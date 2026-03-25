'use strict';

const IdempotencyKey = require('../models/idempotencyKeyModel');

/**
 * Idempotency middleware.
 *
 * Expects an `Idempotency-Key` header on mutating requests.
 * - If the key has been seen before and the response is cached, returns it immediately.
 * - If the key is new, processes the request normally and caches the response.
 * - If the header is missing, rejects with 400.
 *
 * Usage: apply to individual POST routes that must be idempotent.
 */
function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];

  if (!key || typeof key !== 'string' || !key.trim()) {
    return res.status(400).json({
      error: 'Idempotency-Key header is required for this request',
      code: 'MISSING_IDEMPOTENCY_KEY',
    });
  }

  const normalizedKey = key.trim();

  // Check for a cached response
  IdempotencyKey.findOne({ key: normalizedKey, requestPath: req.path })
    .then((record) => {
      if (record) {
        // Replay the cached response — same status, same body
        return res.status(record.responseStatus).json(record.responseBody);
      }

      // Intercept res.json to capture and cache the response before sending
      const originalJson = res.json.bind(res);

      res.json = function (body) {
        // Only cache successful or expected error responses (not 5xx)
        if (res.statusCode < 500) {
          IdempotencyKey.create({
            key: normalizedKey,
            requestPath: req.path,
            responseStatus: res.statusCode,
            responseBody: body,
          }).catch((err) => {
            // Duplicate key race condition — safe to ignore, another request won
            if (err.code !== 11000) {
              console.error('[Idempotency] Failed to cache response:', err.message);
            }
          });
        }
        return originalJson(body);
      };

      next();
    })
    .catch((err) => {
      console.error('[Idempotency] DB lookup failed:', err.message);
      // Fail open — let the request through rather than blocking the user
      next();
    });
}

module.exports = idempotency;
