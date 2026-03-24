'use strict';

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
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { getPaymentLimits } = require('../utils/paymentLimits');
const crypto = require('crypto');

// Permanent error codes that should NOT be retried
const PERMANENT_FAIL_CODES = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET', 'AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH'];

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
    const limits = getPaymentLimits();
    res.json({
      walletAddress: SCHOOL_WALLET,
      memo: req.params.studentId,
      acceptedAssets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
      paymentLimits: {
        min: limits.min,
        max: limits.max,
      },
      note: 'Include the payment intent memo exactly when sending payment to ensure your fees are credited.',
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/payments/intent
async function createPaymentIntent(req, res, next) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
    }

    // Validate that the student's fee amount is within payment limits
    const { validatePaymentAmount } = require('../utils/paymentLimits');
    const limitValidation = validatePaymentAmount(student.feeAmount);
    if (!limitValidation.valid) {
      return res.status(400).json({
        error: limitValidation.error,
        code: limitValidation.code,
      });
    }

    const memo = crypto.randomBytes(4).toString('hex').toUpperCase();
    const intent = await PaymentIntent.create({
      studentId,
      amount: student.feeAmount,
      memo,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    res.status(201).json(intent);
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/verify
 *
 * Accepts a Stellar transaction hash, queries the Stellar network to verify
 * the payment, records it if valid, and returns the verification result.
 *
 * Request body: { txHash: string }  — 64-char hex string (validated by middleware)
 *
 * Success response (200):
 *   {
 *     verified: true,
 *     hash, memo, studentId, amount, assetCode, assetType,
 *     feeAmount, feeValidation: { status, excessAmount, message },
 *     date, alreadyRecorded: boolean
 *   }
 *
 * Error responses follow the global error handler format:
 *   { error: string, code: string }
 *   400 — TX_FAILED | MISSING_MEMO | INVALID_DESTINATION | UNSUPPORTED_ASSET | AMOUNT_TOO_LOW | AMOUNT_TOO_HIGH
 *   409 — DUPLICATE_TX
 *   404 — transaction not found / no valid payment
 *   502 — STELLAR_NETWORK_ERROR
 */
async function verifyPayment(req, res, next) {
  try {
    const { txHash } = req.body;

    // Check if we've already recorded this transaction
    const existing = await Payment.findOne({ txHash });
    if (existing) {
      const err = new Error(`Transaction ${txHash} has already been processed`);
      err.code = 'DUPLICATE_TX';
      return next(err);
    }

    // Query Stellar network — throws structured errors on any failure
    let result;
    try {
      result = await verifyTransaction(txHash);
    } catch (stellarErr) {
      // Record a failed payment entry for known failure codes so we have an audit trail
      if (PERMANENT_FAIL_CODES.includes(stellarErr.code)) {
        await Payment.create({
          studentId: 'unknown',
          txHash,
          amount: 0,
          status: 'failed',
          feeValidationStatus: 'unknown',
        }).catch(() => {}); // non-fatal — don't mask the original error
        return next(stellarErr);
      }

      // Transient Stellar network error — cache for retry so the tx is not lost
      await queueForRetry(txHash, req.body.studentId || null, stellarErr.message);
      return res.status(202).json({
        message: 'Stellar network is temporarily unavailable. Your transaction has been queued and will be verified automatically once the network recovers.',
        txHash,
        status: 'queued_for_retry',
      });
    }

    // verifyTransaction returns null if the tx exists but has no valid payment to the school wallet
    if (!result) {
      return res.status(404).json({
        error: 'Transaction found but contains no valid payment to the school wallet',
        code: 'NOT_FOUND',
      });
    }

    // Persist the verified payment
    const now = new Date();
    await recordPayment({
      studentId: result.studentId || result.memo,
      txHash: result.hash,
      transactionHash: result.hash,
      amount: result.amount,
      feeAmount: result.expectedAmount || result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      excessAmount: result.feeValidation.excessAmount,
      status: 'confirmed',
      memo: result.memo,
      senderAddress: result.senderAddress || null,
      ledger: result.ledger || null,
      confirmationStatus: 'confirmed',
      confirmedAt: result.date ? new Date(result.date) : new Date(),
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
    const payments = await Payment.find({ studentId: req.params.studentId }).sort({ confirmedAt: -1 });
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

// GET /api/payments/limits
async function getPaymentLimitsEndpoint(req, res, next) {
  try {
    const limits = getPaymentLimits();
    res.json({
      min: limits.min,
      max: limits.max,
      message: `Payment amounts must be between ${limits.min} and ${limits.max}`,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/overpayments
async function getOverpayments(req, res, next) {
  try {
    const overpayments = await Payment.find({ feeValidationStatus: 'overpaid' }).sort({ confirmedAt: -1 });
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
      { $match: { studentId } },
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
    const suspicious = await Payment.find({ isSuspicious: true }).sort({ confirmedAt: -1 });
    res.json({ count: suspicious.length, suspicious });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/pending
async function getPendingPayments(req, res, next) {
  try {
    const pending = await Payment.find({ confirmationStatus: 'pending_confirmation' }).sort({ confirmedAt: -1 });
    res.json({ count: pending.length, pending });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/retry-queue — observability endpoint for the retry queue
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
  getPaymentLimitsEndpoint,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
};
