const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    studentId:            { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    txHash:               { type: String, required: true, unique: true, index: true },
    amount:               { type: Number, required: true },
    feeAmount:            { type: Number, default: null },
    feeValidationStatus:  { type: String, enum: ['valid', 'underpaid', 'overpaid', 'unknown'], default: 'unknown' },
    excessAmount:         { type: Number, default: 0 },
    status:               { type: String, enum: ['PENDING', 'SUBMITTED', 'SUCCESS', 'FAILED'], default: 'PENDING' },
    memo:                 { type: String },
    senderAddress:        { type: String, default: null },
    isSuspicious:         { type: Boolean, default: false },
    suspicionReason:      { type: String, default: null },
    ledger:               { type: Number, default: null },
    ledgerSequence:       { type: Number, default: null },
    confirmationStatus:   { type: String, enum: ['pending_confirmation', 'confirmed'], default: 'pending_confirmation' },

    // ── Audit trail ──────────────────────────────────────────────────────────
    // Stellar transaction hash — canonical reference for on-chain traceability
    transactionHash:      { type: String, default: null, index: true },
    // Logical lifecycle timestamps
    startedAt:            { type: Date, default: null },
    submittedAt:          { type: Date, default: null },
    // When the payment was confirmed on the Stellar network (ledger close time)
    confirmedAt:          { type: Date, default: null, index: true },
    // When the payment was verified via POST /api/payments/verify
    verifiedAt:           { type: Date, default: null },
    // createdAt and updatedAt are injected automatically by { timestamps: true }
  },
  {
    timestamps: true, // auto-manages createdAt + updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

paymentSchema.index({ studentId: 1, createdAt: -1 });

paymentSchema.virtual('explorerUrl').get(function() {
  if (!this.transactionHash) return null;
  // Assumes testnet by default, could be dynamic based on config if needed
  return `https://stellar.expert/explorer/testnet/tx/${this.transactionHash}`;
});

paymentSchema.pre('save', async function(next) {
  // Immutability Hook: Prevent modifying records that are in SUCCESS or FAILED state
  if (!this.isNew && this.isModified()) {
    try {
      const original = await mongoose.model('Payment').findById(this._id).lean();
      if (original && (original.status === 'SUCCESS' || original.status === 'FAILED')) {
        throw new Error('Payment audit trail is immutable once in SUCCESS or FAILED state');
      }
    } catch (err) {
      return next(err);
    }
  }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);
