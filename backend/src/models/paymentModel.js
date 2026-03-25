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

    // ── Audit trail ──────────────────────────────────────────────────────────
    // Stellar transaction hash — canonical reference for on-chain traceability
    transactionHash:      { type: String, default: null, index: true },
    // When the payment was confirmed on the Stellar network (ledger close time)
    confirmedAt:          { type: Date, default: null, index: true },
    // When the payment was verified via POST /api/payments/verify
    verifiedAt:           { type: Date, default: null },
    // createdAt and updatedAt are injected automatically by { timestamps: true }
  },
  {
    timestamps: true, // auto-manages createdAt + updatedAt
  }
);

module.exports = mongoose.model('Payment', paymentSchema);
