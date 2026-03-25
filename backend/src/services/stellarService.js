'use strict';

const { server, SCHOOL_WALLET, isAcceptedAsset, CONFIRMATION_THRESHOLD, StellarSdk, networkPassphrase } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');
const PaymentIntent = require('../models/paymentIntentModel');

function detectAsset(payOp) {
  const assetType = payOp.asset_type;
  const assetCode = assetType === 'native' ? 'XLM' : payOp.asset_code;
  const assetIssuer = assetType === 'native' ? null : payOp.asset_issuer;
  const { accepted } = isAcceptedAsset(assetCode, assetType);
  if (!accepted) return null;
  return { assetCode, assetType, assetIssuer };
}

function normalizeAmount(rawAmount) {
  return parseFloat(parseFloat(rawAmount).toFixed(7));
}

async function extractValidPayment(tx) {
  if (!tx.successful) return null;
  const memo = tx.memo ? tx.memo.trim() : null;
  if (!memo) return null;
  const ops = await tx.operations();
  const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
  if (!payOp) return null;
  const asset = detectAsset(payOp);
  if (!asset) return null;
  return { payOp, memo, asset };
}

function validatePaymentAgainstFee(paymentAmount, expectedFee) {
  if (paymentAmount < expectedFee) {
    return {
      status: 'underpaid',
      excessAmount: 0,
      message: `Payment of ${paymentAmount} is less than the required fee of ${expectedFee}`,
    };
  }
  if (paymentAmount > expectedFee) {
    const excess = parseFloat((paymentAmount - expectedFee).toFixed(7));
    return {
      status: 'overpaid',
      excessAmount: excess,
      message: `Payment of ${paymentAmount} exceeds the required fee of ${expectedFee} by ${excess}`,
    };
  }
  return {
    status: 'valid',
    excessAmount: 0,
    message: 'Payment matches the required fee',
  };
}

async function checkConfirmationStatus(txLedger) {
  const latestLedger = await server.ledgers().order('desc').limit(1).call();
  const latestSequence = latestLedger.records[0].sequence;
  return (latestSequence - txLedger) >= CONFIRMATION_THRESHOLD;
}

async function detectMemoCollision(studentObjId, senderAddress, paymentAmount, expectedFee, txDate) {
  const COLLISION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const windowStart = new Date(txDate.getTime() - COLLISION_WINDOW_MS);

  const recentFromOtherSender = await Payment.findOne({
    studentId: studentObjId,
    senderAddress: { $ne: senderAddress, $ne: null },
    confirmedAt: { $gte: windowStart },
  });

  if (recentFromOtherSender) {
    return {
      suspicious: true,
      reason: `The student ID was used by a different sender (${recentFromOtherSender.senderAddress}) within the last 24 hours`,
    };
  }

  if (paymentAmount <= 0 || paymentAmount > expectedFee * 2) {
    return {
      suspicious: true,
      reason: `Unusual payment amount ${paymentAmount} for expected fee ${expectedFee}`,
    };
  }

  return { suspicious: false, reason: null };
}

async function syncPayments() {
  const transactions = await server
    .transactions()
    .forAccount(SCHOOL_WALLET)
    .order('desc')
    .limit(20)
    .call();

  for (const tx of transactions.records) {
    const exists = await Payment.findOne({ transactionHash: tx.hash });
    if (exists) continue;

    const valid = await extractValidPayment(tx);
    if (!valid) continue;

    const { payOp, memo } = valid;

    const intent = await PaymentIntent.findOne({ memo, status: 'pending' });
    if (!intent) continue;

    const student = await Student.findOne({ studentId: intent.studentId });
    if (!student) continue;

    const paymentAmount = parseFloat(payOp.amount);
    const senderAddress = payOp.from || null;
    const txDate = new Date(tx.created_at);
    const txLedger = tx.ledger_attr || tx.ledger || null;

    const isConfirmed = txLedger ? await checkConfirmationStatus(txLedger) : false;
    const confirmationStatus = isConfirmed ? 'confirmed' : 'pending_confirmation';

    const collision = await detectMemoCollision(student._id, senderAddress, paymentAmount, student.feeAmount, txDate);

    const previousPayments = await Payment.aggregate([
      { $match: { studentId: student._id, status: 'SUCCESS' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const previousTotal = previousPayments.length ? previousPayments[0].total : 0;
    const cumulativeTotal = parseFloat((previousTotal + paymentAmount).toFixed(7));
    const remaining = parseFloat((student.feeAmount - cumulativeTotal).toFixed(7));

    let cumulativeStatus;
    if (cumulativeTotal < student.feeAmount) {
      cumulativeStatus = 'underpaid';
    } else if (cumulativeTotal > student.feeAmount) {
      cumulativeStatus = 'overpaid';
    } else {
      cumulativeStatus = 'valid';
    }

    const excessAmount = cumulativeStatus === 'overpaid'
      ? parseFloat((cumulativeTotal - student.feeAmount).toFixed(7))
      : 0;

    const feeValidation = validatePaymentAgainstFee(paymentAmount, intent.amount);

    await Payment.create({
      studentId: student._id,
      transactionHash: tx.hash,
      amount: paymentAmount,
      feeAmount: intent.amount,
      feeValidationStatus: cumulativeStatus,
      excessAmount,
      status: 'SUCCESS',
      memo,
      senderAddress,
      isSuspicious: collision.suspicious,
      suspicionReason: collision.reason,
      ledgerSequence: txLedger,
      confirmationStatus,
      confirmedAt: txDate,
    });

    if (isConfirmed && !collision.suspicious) {
      await Student.findOneAndUpdate(
        { studentId: intent.studentId },
        {
          totalPaid: cumulativeTotal,
          remainingBalance: remaining < 0 ? 0 : remaining,
          feePaid: cumulativeTotal >= student.feeAmount,
        }
      );
    }

    await PaymentIntent.findByIdAndUpdate(intent._id, { status: 'completed' });

    if (feeValidation.status === 'valid' || feeValidation.status === 'overpaid') {
      await Student.findOneAndUpdate({ studentId: intent.studentId }, { feePaid: true });
    }
  }
}

async function recordPayment(data) {
  const exists = await Payment.findOne({ transactionHash: data.transactionHash });
  if (exists) {
    const err = new Error(`Transaction ${data.transactionHash} has already been processed`);
    err.code = 'DUPLICATE_TX';
    throw err;
  }
  try {
    return await Payment.create(data);
  } catch (e) {
    if (e.code === 11000) {
      const err = new Error(`Transaction ${data.transactionHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      throw err;
    }
    throw e;
  }
}

async function verifyTransaction(txHash) {
  const tx = await server.transactions().transaction(txHash).call();

  const valid = await extractValidPayment(tx);
  if (!valid) return null;

  const { payOp, memo, asset } = valid;
  const amount = normalizeAmount(payOp.amount);

  if (tx.successful === false) {
    const err = new Error('Transaction was not successful on the Stellar network');
    err.code = 'TX_FAILED';
    throw err;
  }

  const memoStr = tx.memo ? tx.memo.trim() : null;
  if (!memoStr) {
    const err = new Error('Transaction memo is missing or empty — cannot identify student');
    err.code = 'MISSING_MEMO';
    throw err;
  }

  const ops = await tx.operations();
  const validPayOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
  if (!validPayOp) {
    const err = new Error(`No payment operation found targeting the school wallet (${SCHOOL_WALLET})`);
    err.code = 'INVALID_DESTINATION';
    throw err;
  }

  const validAsset = detectAsset(validPayOp);
  if (!validAsset) {
    const assetCode = validPayOp.asset_type === 'native' ? 'XLM' : (validPayOp.asset_code || validPayOp.asset_type);
    const err = new Error(`Unsupported asset: ${assetCode}`);
    err.code = 'UNSUPPORTED_ASSET';
    err.assetCode = assetCode;
    throw err;
  }

  const amountExtracted = normalizeAmount(validPayOp.amount);
  const student = await Student.findOne({ studentId: memoStr });
  const feeAmount = student ? student.feeAmount : null;
  
  const feeValidation = feeAmount != null
    ? validatePaymentAgainstFee(amountExtracted, feeAmount)
    : { status: 'unknown', excessAmount: 0, message: 'Student not found, cannot validate fee' };

  return {
    hash: tx.hash,
    memo: memoStr,
    studentId: memoStr,
    amount: amountExtracted,
    assetCode: validAsset.assetCode,
    assetType: validAsset.assetType,
    feeAmount,
    feeValidation,
    date: tx.created_at,
    ledger: tx.ledger_attr || tx.ledger || null,
    senderAddress: validPayOp.from || null,
  };
}

async function finalizeConfirmedPayments() {
  const pending = await Payment.find({ confirmationStatus: 'pending_confirmation', isSuspicious: false });

  for (const payment of pending) {
    if (!payment.ledgerSequence) continue;
    const isConfirmed = await checkConfirmationStatus(payment.ledgerSequence);
    if (!isConfirmed) continue;

    await Payment.findByIdAndUpdate(payment._id, { confirmationStatus: 'confirmed' });

    const student = await Student.findById(payment.studentId);
    if (!student) continue;

    const agg = await Payment.aggregate([
      { $match: { studentId: payment.studentId, confirmationStatus: 'confirmed', isSuspicious: false } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const totalPaid = agg.length ? parseFloat(agg[0].total.toFixed(7)) : 0;
    const remainingBalance = parseFloat(Math.max(0, student.feeAmount - totalPaid).toFixed(7));

    await Student.findByIdAndUpdate(
      payment.studentId,
      { totalPaid, remainingBalance, feePaid: totalPaid >= student.feeAmount }
    );
  }
}

module.exports = {
  syncPayments,
  verifyTransaction,
  validatePaymentAgainstFee,
  detectAsset,
  normalizeAmount,
  extractValidPayment,
  detectMemoCollision,
  finalizeConfirmedPayments,
  checkConfirmationStatus,
  recordPayment,
};
