'use strict';

const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, index: true },
  txHash: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  feeAmount: { type: Number, default: null },
  feeValidationStatus: { type: String, enum: ['valid', 'underpaid', 'overpaid', 'unknown'], default: 'unknown' },
  confirmedAt: { type: Date, default: Date.now, index: true },
  studentId: { type: String, required: true },
  txHash: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, required: true },
  feeAmount: { type: Number, default: null },
  feeValidationStatus: { type: String, enum: ['valid', 'underpaid', 'overpaid', 'unknown'], default: 'unknown' },
  excessAmount: { type: Number, default: 0 },
  status: { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'pending' },
  memo: { type: String },
  senderAddress: { type: String, default: null },
  isSuspicious: { type: Boolean, default: false },
  suspicionReason: { type: String, default: null },
  ledger: { type: Number, default: null },
  confirmationStatus: { type: String, enum: ['pending_confirmation', 'confirmed'], default: 'pending_confirmation' },
  confirmedAt: { type: Date, default: Date.now },
  referenceCode: { type: String, unique: true, sparse: true, index: true },
}, { timestamps: true });
const paymentSchema = new mongoose.Schema(
  {
    schoolId:             { type: String, required: true, index: true },
    studentId:            { type: String, required: true, index: true },
    txHash:               { type: String, required: true, unique: true, index: true },
    amount:               { type: Number, required: true },
    feeAmount:            { type: Number, default: null },
    feeValidationStatus:  { type: String, enum: ['valid', 'underpaid', 'overpaid', 'unknown'], default: 'unknown' },
    excessAmount:         { type: Number, default: 0 },
    status:               { type: String, enum: ['pending', 'confirmed', 'failed'], default: 'pending' },
    memo:                 { type: String },
    senderAddress:        { type: String, default: null },
    isSuspicious:         { type: Boolean, default: false },
    suspicionReason:      { type: String, default: null },
    ledger:               { type: Number, default: null },
    confirmationStatus:   { type: String, enum: ['pending_confirmation', 'confirmed'], default: 'pending_confirmation' },

    // ── Audit trail ────────────────────────────────────────────────────────
    transactionHash:      { type: String, default: null, index: true },
    confirmedAt:          { type: Date, default: null, index: true },
    verifiedAt:           { type: Date, default: null },
  },
  { timestamps: true }
);

// All queries are school-scoped — schoolId always leads
paymentSchema.index({ schoolId: 1, studentId: 1 });
paymentSchema.index({ schoolId: 1, confirmedAt: -1 });
paymentSchema.index({ schoolId: 1, feeValidationStatus: 1 });
paymentSchema.index({ schoolId: 1, isSuspicious: 1 });
paymentSchema.index({ schoolId: 1, confirmationStatus: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
