const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema({
  studentId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  class: { type: String, required: true, index: true },
  feeAmount: { type: Number, required: true },
  feePaid: { type: Boolean, default: false, index: true },
  totalPaid: { type: Number, default: 0 },
  remainingBalance: { type: Number, default: null },
  
  // Concurrency control fields
  version: { type: Number, default: 0 },
  lastPaymentAt: { type: Date, default: null },
  lastPaymentHash: { type: String, default: null },
  
  // Additional tracking
  lastTransactionAt: { type: Date, default: null },
}, { timestamps: true });

// Compound indexes for common query patterns
studentSchema.index({ studentId: 1, version: 1 });
studentSchema.index({ feePaid: 1, class: 1 });
studentSchema.index({ totalPaid: 1 });

// Pre-save hook to increment version
studentSchema.pre('save', function(next) {
  if (this.isModified() && !this.isNew) {
    this.version += 1;
  }
  next();
});

module.exports = mongoose.model('Student', studentSchema);
