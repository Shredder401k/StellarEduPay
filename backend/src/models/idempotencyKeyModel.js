'use strict';

const mongoose = require('mongoose');

/**
 * Stores idempotency key → cached response mappings.
 * TTL index automatically purges records after 24 hours.
 */
const idempotencyKeySchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  requestPath: { type: String, required: true },
  responseStatus: { type: Number, required: true },
  responseBody: { type: mongoose.Schema.Types.Mixed, required: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 }, // TTL: 24h
});

module.exports = mongoose.model('IdempotencyKey', idempotencyKeySchema);
