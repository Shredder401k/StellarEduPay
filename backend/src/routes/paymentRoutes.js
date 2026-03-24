'use strict';

const express = require('express');
const router = express.Router();
const {
  getPaymentInstructions,
  verifyPayment,
  syncAllPayments,
  getStudentPayments,
  getAcceptedAssets,
  createPaymentIntent,
  getOverpayments,
  getStudentBalance,
  getSuspiciousPayments,
  getPendingPayments,
  finalizePayments,
} = require('../controllers/paymentController');
const idempotency = require('../middleware/idempotency');

router.get('/accepted-assets', getAcceptedAssets);
router.get('/overpayments', getOverpayments);
router.get('/suspicious', getSuspiciousPayments);
router.get('/pending', getPendingPayments);
router.get('/balance/:studentId', getStudentBalance);
router.get('/instructions/:studentId', getPaymentInstructions);
router.get('/:studentId', getStudentPayments);

// Idempotency enforced on mutating endpoints that create records
router.post('/intent', idempotency, createPaymentIntent);
router.post('/verify', idempotency, verifyPayment);

// Admin/internal — no idempotency key required
router.post('/sync', syncAllPayments);
router.post('/finalize', finalizePayments);

module.exports = router;
