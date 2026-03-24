const express = require('express');
const router = express.Router();
const { getPaymentInstructions, verifyPayment, syncAllPayments, getStudentPayments, getAcceptedAssets } = require('../controllers/paymentController');
const { validateStudentIdParam, validateVerifyPayment } = require('../middleware/validate');

router.get('/accepted-assets', getAcceptedAssets);
router.get('/instructions/:studentId', validateStudentIdParam, getPaymentInstructions);
router.get('/:studentId', validateStudentIdParam, getStudentPayments);
router.post('/verify', validateVerifyPayment, verifyPayment);
router.post('/sync', syncAllPayments);

module.exports = router;
