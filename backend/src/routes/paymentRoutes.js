'use strict';

const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/paymentController');
const { validateStudentIdParam, validateVerifyPayment } = require('../middleware/validate');

// Static routes first (before :studentId wildcard)
router.get('/accepted-assets', getAcceptedAssets);
router.get('/limits', getPaymentLimitsEndpoint);
router.get('/overpayments', getOverpayments);
router.get('/suspicious', getSuspiciousPayments);
router.get('/pending', getPendingPayments);
router.get('/retry-queue', getRetryQueue);
router.get('/balance/:studentId', validateStudentIdParam, getStudentBalance);
router.get('/instructions/:studentId', validateStudentIdParam, getPaymentInstructions);

// POST routes
router.post('/intent', createPaymentIntent);
router.post('/verify', validateVerifyPayment, verifyPayment);
router.post('/sync', syncAllPayments);
router.post('/finalize', finalizePayments);

// Parameterized route last to avoid swallowing static paths
router.get('/:studentId', validateStudentIdParam, getStudentPayments);

module.exports = router;
