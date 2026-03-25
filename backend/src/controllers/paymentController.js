'use strict';

const crypto = require('crypto');
const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');
const Student = require('../models/studentModel');
const PendingVerification = require('../models/pendingVerificationModel');
const { syncPayments, verifyTransaction, recordPayment, finalizeConfirmedPayments } = require('../services/stellarService');
const { queueForRetry } = require('../services/retryService');
const { SCHOOL_WALLET, ACCEPTED_ASSETS } = require('../config/stellarConfig');
const { get, set, del, delByPrefix, KEYS, TTL } = require('../cache');

// Permanent error codes that should NOT be retried
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

// POST /api/payments/intent
async function createPaymentIntent(req, res, next) {
  try {
    const { studentId } = req.body;
    const student = await Student.findOne({ studentId });
    if (!student) {
      return res.status(404).json({ error: 'Student not found', code: 'NOT_FOUND' });
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
 *   400 — TX_FAILED | MISSING_MEMO | INVALID_DESTINATION | UNSUPPORTED_ASSET
 *   409 — DUPLICATE_TX
 *   404 — transaction not found / no valid payment
 *   502 — STELLAR_NETWORK_ERROR
 */
async function verifyPayment(req, res, next) {
  try {
    const { txHash } = req.body;

    // Check if we've already recorded this transaction
    // Check for already-processed or already-queued transactions
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
      const knownFailCodes = ['TX_FAILED', 'MISSING_MEMO', 'INVALID_DESTINATION', 'UNSUPPORTED_ASSET'];
      // Record a failed payment entry for known failure codes so we have an audit trail
      if (knownFailCodes.includes(stellarErr.code)) {
        await Payment.create({
          studentId: 'unknown',
          txHash,
          amount: 0,
          status: 'failed',
          feeValidationStatus: 'unknown',
        }).catch(() => {}); // non-fatal — don't mask the original error
      }
      return next(knownFailCodes.includes(stellarErr.code) ? stellarErr : wrapStellarError(stellarErr));
    }

    // verifyTransaction returns null if the tx exists but has no valid payment to the school wallet
    if (!result) {
      return res.status(404).json({
        error: 'Transaction found but contains no valid payment to the school wallet',
        code: 'NOT_FOUND',
      });
    }

    const now = new Date();

    await recordPayment({
      studentId: result.studentId || result.memo,
      txHash: result.hash,
      transactionHash: result.hash,   // audit: canonical on-chain reference
      amount: result.amount,
      feeAmount: result.expectedAmount || result.feeAmount,
      feeValidationStatus: result.feeValidation.status,
      excessAmount: result.feeValidation.excessAmount,
      status: 'confirmed',
      memo: result.memo,
      senderAddress: result.senderAddress || null,
      ledger: result.ledger || null,
      confirmationStatus: 'confirmed',
      confirmedAt: new Date(result.date),
      confirmedAt: new Date(result.date), // audit: ledger confirmation time
      verifiedAt: now,                    // audit: when this endpoint was called
      confirmedAt: result.date ? new Date(result.date) : new Date(),
    });

    // Invalidate caches affected by the new payment
    const verifiedStudentId = result.studentId || result.memo;
    del(
      KEYS.balance(verifiedStudentId),
      KEYS.payments(verifiedStudentId),
      KEYS.student(verifiedStudentId),
      KEYS.studentsAll(),
      KEYS.overpayments(),
      KEYS.suspicious(),
      KEYS.pending(),
    );
    delByPrefix('report:');

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
    // Sync may record new payments — invalidate payment-related caches
    del(KEYS.overpayments(), KEYS.suspicious(), KEYS.pending());
    delByPrefix('payments:');
    delByPrefix('balance:');
    delByPrefix('report:');
    res.json({ message: 'Sync complete' });
  } catch (err) {
    const wrapped = wrapStellarError(err);
    // If the sync itself fails due to a network outage, report it clearly
    // (individual tx caching happens inside stellarService during sync)
    next(wrapped);
  }
}

// POST /api/payments/finalize
async function finalizePayments(req, res, next) {
  try {
    await finalizeConfirmedPayments();
    // Finalization promotes pending → confirmed and updates student records
    del(KEYS.pending(), KEYS.overpayments(), KEYS.suspicious());
    delByPrefix('payments:');
    delByPrefix('balance:');
    delByPrefix('student:');
    del(KEYS.studentsAll());
    delByPrefix('report:');
    res.json({ message: 'Finalization complete' });
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/:studentId
async function getStudentPayments(req, res, next) {
  try {
    const { studentId } = req.params;
    const cacheKey = KEYS.payments(studentId);
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const payments = await Payment.find({ studentId }).sort({ confirmedAt: -1 });
    set(cacheKey, payments, TTL.PAYMENTS);
    res.json(payments);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/accepted-assets
async function getAcceptedAssets(req, res, next) {
  try {
    const cacheKey = KEYS.acceptedAssets();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const data = {
      assets: Object.values(ACCEPTED_ASSETS).map(a => ({
        code: a.code,
        type: a.type,
        displayName: a.displayName,
      })),
    };
    set(cacheKey, data, TTL.ACCEPTED_ASSETS);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/overpayments
async function getOverpayments(req, res, next) {
  try {
    const cacheKey = KEYS.overpayments();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const overpayments = await Payment.find({ feeValidationStatus: 'overpaid' }).sort({ confirmedAt: -1 });
    const totalExcess = overpayments.reduce((sum, p) => sum + (p.excessAmount || 0), 0);
    const data = { count: overpayments.length, totalExcess, overpayments };
    set(cacheKey, data, TTL.OVERPAYMENTS);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/balance/:studentId
async function getStudentBalance(req, res, next) {
  try {
    const { studentId } = req.params;
    const cacheKey = KEYS.balance(studentId);
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

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

    const data = {
      studentId,
      feeAmount: student.feeAmount,
      totalPaid,
      remainingBalance,
      excessAmount,
      feePaid: totalPaid >= student.feeAmount,
      installmentCount: result.length ? result[0].count : 0,
    };
    set(cacheKey, data, TTL.BALANCE);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/suspicious
async function getSuspiciousPayments(req, res, next) {
  try {
    const cacheKey = KEYS.suspicious();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const suspicious = await Payment.find({ isSuspicious: true }).sort({ confirmedAt: -1 });
    const data = { count: suspicious.length, suspicious };
    set(cacheKey, data, TTL.SUSPICIOUS);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// GET /api/payments/pending
async function getPendingPayments(req, res, next) {
  try {
    const cacheKey = KEYS.pending();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const pending = await Payment.find({ confirmationStatus: 'pending_confirmation' }).sort({ confirmedAt: -1 });
    const data = { count: pending.length, pending };
    set(cacheKey, data, TTL.PENDING);
    res.json(data);
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
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  getRetryQueue,
};
