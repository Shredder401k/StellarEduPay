'use strict';

const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const PendingVerification = require('../models/pendingVerificationModel');
const {
  syncPayments,
  verifyTransaction,
  recordPayment,
  finalizeConfirmedPayments,
} = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS, server } = require('../config/stellarConfig');
const StellarSdk = require('@stellar/stellar-sdk');

const PERMANENT_FAIL_CODES = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];

function wrapStellarError(err) {
  if (!err.code) {
    err.code = 'STELLAR_NETWORK_ERROR';
    err.message = `Stellar network error: ${err.message}`;
  }
  return err;
}

// GET /api/payments/instructions/:studentId
async function getPaymentInstructions(req, res, next) {
  try {
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      note: 'Include the payment intent memo exactly when sending payment to ensure your fees are credited.',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/intent  (Step 1: Record intent)
async function createPaymentIntent(req, res, next) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();
    
    // We now use the Payment model to track the initial 'PENDING' intent.
    const payment = await Payment.create({
      studentId: student._id,
      amount: student.feeAmount,
      memo,
      status: 'PENDING',
      startedAt: new Date(),
    });

    res.status(201).json({
      memo: payment.memo,
      amount: payment.amount,
      studentId: student.studentId,
      paymentId: payment._id
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/submit  (Step 2 & 3: Submit and Track XDR)
async function submitTransaction(req, res, next) {
  try {
    const { xdr } = req.body;
    if (!xdr) {
      return res.status(400).json({ error: 'Missing xdr parameter' });
    }

    // Decode the transaction from the base64 XDR string
    const tx = new StellarSdk.Transaction(xdr, StellarSdk.Networks.TESTNET); // or networkPassphrase
    const transactionHash = tx.hash().toString('hex');
    const memo = tx.memo.value ? tx.memo.value.toString() : null;

    if (!memo) {
      return res.status(400).json({ error: 'Transaction must include the student ID as a memo' });
    }

    // Step 2: Capture XDR/Hash before submission
    // Update or create the Payment record with SUBMITTED status
    let paymentRecord = await Payment.findOne({ memo, status: 'PENDING' }).sort({ createdAt: -1 });
    if (!paymentRecord) {
      const studentObj = await Student.findOne({ studentId: memo });
      if (!studentObj) {
        return res.status(404).json({ error: 'Associated student not found in the database. Cannot process transaction.' });
      }
      paymentRecord = new Payment({
        studentId: studentObj._id,
        memo: memo,
        amount: 0, // Gets corrected on success
      });
    }

    paymentRecord.transactionHash = transactionHash;
    paymentRecord.status = 'SUBMITTED';
    paymentRecord.submittedAt = new Date();
    // Saving the record before sending to the network ensures a robust audit trail
    await paymentRecord.save();

    let txResponse;
    try {
      // Step 3: Send to the Stellar network
      txResponse = await server.submitTransaction(tx);
    } catch (err) {
      paymentRecord.status = 'FAILED';
      let errorReason = err.message;
      if (err.response && err.response.data && err.response.data.extras) {
        errorReason = err.response.data.extras.result_codes.transaction;
      }
      paymentRecord.suspicionReason = errorReason;
      await paymentRecord.save();
      return res.status(400).json({ error: 'Transaction submission failed', code: errorReason });
    }

    // Success
    paymentRecord.status = 'SUCCESS';
    paymentRecord.confirmedAt = new Date();
    paymentRecord.ledgerSequence = txResponse.ledger;
    // (Amount should be extracted from operations, but verifyTransaction does that better)
    await paymentRecord.save();

    res.json({
      verified: true,
      hash: transactionHash,
      ledger: txResponse.ledger,
      status: 'SUCCESS'
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/verify
async function verifyPayment(req, res, next) {
  try {
    const { txHash } = req.body;

    const existing = await Payment.findOne({ transactionHash: txHash, status: 'SUCCESS' });
    if (existing) {
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      return next(err);
    }

    let result;
    try {
      result = await verifyTransaction(txHash);
    } catch (stellarErr) {
      const knownFailCodes = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];
      // Ensure no 'orphan' payments can be created in the system by removing dummy records
      return next(knownFailCodes.includes(stellarErr.code) ? stellarErr : wrapStellarError(stellarErr));
    }

    if (!result) {
      return res.status(404).json({
        error: 'Transaction found but contains no valid payment to the school wallet',
        code: 'NOT_FOUND',
      });
    }

    const now = new Date();

    const studentStrId = result.studentId || result.memo;
    const studentObj = await Student.findOne({ studentId: studentStrId });
    if (!studentObj) {
      return res.status(404).json({ error: 'Associated student not found. Cannot record transaction.' });
    }

    await recordPayment({
      studentId: studentObj._id,
      transactionHash: result.hash,
      amount: result.amount,
      feeAmount: result.expectedAmount || result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      excessAmount: result.feeValidation.excessAmount,
      status: 'SUCCESS',
      memo: result.memo,
      senderAddress: result.senderAddress || null,
      ledgerSequence: result.ledger || null,
      confirmationStatus: 'confirmed',
      confirmedAt: result.date ? new Date(result.date) : now,
      verifiedAt: now,
    });

    res.json({
      verified: true,
      hash: result.hash,
      memo: result.memo,
      studentId: result.studentId,
      amount: result.amount,
      assetCode: result.assetCode,
      assetType: result.assetType,
      feeAmount: result.feeAmount,
      feeValidation: result.feeValidation,
      date: result.date,
    });
  } catch (err) {
    // Retry queue logic for transient errors
    const failCodes = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];
    if (failCodes.includes(err.code)) {
      if (PERMANENT_FAIL_CODES.includes(err.code)) {
        // Ensure no 'orphan' payments can be created in the system
        return next(err);
      }

      await queueForRetry(req.body.txHash, req.body.studentId || null, err.message);
      return res.status(202).json({
        message: 'Stellar network is temporarily unavailable. Your transaction has been queued.',
        txHash: req.body.txHash,
        status: 'queued_for_retry',
      });
    }
    next(err);
  }
}

// POST /api/payments/sync
async function syncAllPayments(req, res, next) {
  try {
    await syncPayments();
    res.json({ message: 'Sync complete' });
  } catch (err) {
    const wrapped = wrapStellarError(err);
    next(wrapped);
  }
}

// POST /api/payments/finalize
async function finalizePayments(req, res, next) {
  try {
    await finalizeConfirmedPayments();
    res.json({ message: 'Finalization complete' });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res, next) {
  try {
    const student = await Student.findOne({ studentId: req.params.studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }
    const payments = await Payment.find({ studentId: student._id })
      .sort({ confirmedAt: -1 })
      .populate('studentId', 'name email studentRegNumber');
    res.json(payments);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res, next) {
  try {
    res.json({
      assets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/overpayments
async function getOverpayments(req, res, next) {
  try {
    const overpayments = await Payment.find({ feeValidationStatus: 'overpaid' })
      .sort({ confirmedAt: -1 })
      .populate('studentId', 'name email studentRegNumber');
    const totalExcess = overpayments.reduce((sum, p) => sum + (p.excessAmount || 0), 0);
    res.json({ count: overpayments.length, totalExcess, overpayments });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/balance/:studentId
async function getStudentBalance(req, res, next) {
  try {
    const { studentId } = req.params;
    const student = await Student.findOne({ studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    const result = await Payment.aggregate([
      { $match: { studentId: student._id, status: 'SUCCESS' } },
      { $group: { _id: null, totalPaid: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const totalPaid = result.length ? parseFloat(result[0].totalPaid.toFixed(7)) : 0;
    const remainingBalance = parseFloat(Math.max(0, student.feeAmount - totalPaid).toFixed(7));
    const excessAmount = totalPaid > student.feeAmount
      ? parseFloat((totalPaid - student.feeAmount).toFixed(7))
      : 0;

    res.json({
      studentId,
      feeAmount: student.feeAmount,
      totalPaid,
      remainingBalance,
      excessAmount,
      feePaid: totalPaid >= student.feeAmount,
      installmentCount: result.length ? result[0].count : 0,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/suspicious
async function getSuspiciousPayments(req, res, next) {
  try {
    const suspicious = await Payment.find({ isSuspicious: true })
      .sort({ confirmedAt: -1 })
      .populate('studentId', 'name email studentRegNumber');
    res.json({ count: suspicious.length, suspicious });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/pending
async function getPendingPayments(req, res, next) {
  try {
    const pending = await Payment.find({ confirmationStatus: 'pending_confirmation' })
      .sort({ confirmedAt: -1 })
      .populate('studentId', 'name email studentRegNumber');
    res.json({ count: pending.length, pending });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/retry-queue
async function getRetryQueue(req, res) {
  try {
    const [pending, deadLetter, resolved] = await Promise.all([
      PendingVerification.find({ status: 'pending' }).sort({ nextRetryAt: 1 }),
      PendingVerification.find({ status: 'dead_letter' }).sort({ updatedAt: -1 }),
      PendingVerification.find({ status: 'resolved' }).sort({ resolvedAt: -1 }).limit(20),
    ]);
    res.json({
      pending: { count: pending.length, items: pending },
      dead_letter: { count: deadLetter.length, items: deadLetter },
      recently_resolved: { count: resolved.length, items: resolved },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = {
  getPaymentInstructions,
  createPaymentIntent,
  verifyPayment,
  syncAllPayments,
  finalizePayments,
  getStudentPayments,
  getAcceptedAssets,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
  submitTransaction,
};
