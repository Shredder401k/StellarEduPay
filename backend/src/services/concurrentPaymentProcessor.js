/**
 * Concurrent Payment Processor Service
 * 
 * Production-ready payment processor optimized for high-traffic concurrent
 * financial transactions. Implements multiple safety mechanisms:
 * 
 * - Atomic database operations with transactions
 * - Optimistic and pessimistic locking strategies
 * - Automatic retry with exponential backoff
 * - Race condition prevention
 * - Deadlock detection and recovery
 * - Idempotency key support
 * - Request deduplication
 */

'use strict';

const mongoose = require('mongoose');
const { transactionManager, LOCK_TYPE, safeCredit } = require('./transactionManager');
const { logger } = require('../utils/logger');
const Student = require('../models/studentModel');
const Payment = require('../models/paymentModel');
const PaymentIntent = require('../models/paymentIntentModel');

// ── Idempotency Cache (In-Memory with TTL) ─────────────────────────────────────
class IdempotencyCache {
  constructor(ttlMs = 60000) {
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  /**
   * Check if a key exists and is not expired
   */
  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    
    return true;
  }

  /**
   * Get cached result for a key
   */
  get(key) {
    if (!this.has(key)) return null;
    return this.cache.get(key).result;
  }

  /**
   * Set a key with result
   */
  set(key, result) {
    this.cache.set(key, {
      result,
      expiresAt: Date.now() + this.ttlMs,
    });

    // Cleanup expired entries periodically
    if (this.cache.size % 100 === 0) {
      this.cleanup();
    }
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
      }
    }
  }
}

// ── Rate Limiter ────────────────────────────────────────────────────────────────
class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 100;
    this.windowMs = options.windowMs || 1000;
    this.requests = new Map();
  }

  /**
   * Check if request is allowed
   */
  isAllowed(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Get or initialize request tracking
    let requestInfo = this.requests.get(key);
    
    if (!requestInfo || requestInfo.windowStart < windowStart) {
      requestInfo = {
        windowStart: now,
        count: 0,
      };
    }

    requestInfo.count++;
    this.requests.set(key, requestInfo);

    if (requestInfo.count > this.maxRequests) {
      return {
        allowed: false,
        retryAfterMs: this.windowMs - (now - requestInfo.windowStart),
      };
    }

    return { allowed: true, remaining: this.maxRequests - requestInfo.count };
  }

  /**
   * Cleanup old entries
   */
  cleanup() {
    const windowStart = Date.now() - this.windowMs * 2;
    for (const [key, info] of this.requests.entries()) {
      if (info.windowStart < windowStart) {
        this.requests.delete(key);
      }
    }
  }
}

// ── Concurrency Types ──────────────────────────────────────────────────────────
const CONCURRENCY_STRATEGY = {
  OPTIMISTIC: 'optimistic',
  PESSIMISTIC: 'pessimistic',
  SERIALIZABLE: 'serializable',
};

// ── Payment Processing Result ──────────────────────────────────────────────────
class PaymentProcessingResult {
  constructor(success, data = {}, error = null) {
    this.success = success;
    this.data = data;
    this.error = error;
    this.timestamp = new Date().toISOString();
  }

  toJSON() {
    return {
      success: this.success,
      data: this.data,
      error: this.error ? {
        message: this.error.message,
        code: this.error.code,
      } : null,
      timestamp: this.timestamp,
    };
  }
}

// ── Main Service Class ──────────────────────────────────────────────────────────
class ConcurrentPaymentProcessor {
  constructor(options = {}) {
    this.idempotencyCache = new IdempotencyCache(options.idempotencyTtlMs || 60000);
    this.rateLimiter = new RateLimiter({
      maxRequests: options.maxRequestsPerSecond || 100,
      windowMs: 1000,
    });
    this.defaultLockStrategy = options.lockStrategy || CONCURRENCY_STRATEGY.OPTIMISTIC;
    this.lockTimeoutMs = options.lockTimeoutMs || 30000;
    this.maxRetries = options.maxRetries || 3;
  }

  /**
   * Process a payment with full concurrency protection
   */
  async processPayment(paymentData, options = {}) {
    const {
      idempotencyKey,
      lockStrategy = this.defaultLockStrategy,
      studentId,
      amount,
      txHash,
    } = options;

    // ── Step 1: Idempotency Check ─────────────────────────────────────────────
    if (idempotencyKey && this.idempotencyCache.has(idempotencyKey)) {
      logger.info('[PaymentProcessor] Returning cached result', { idempotencyKey });
      return this.idempotencyCache.get(idempotencyKey);
    }

    // ── Step 2: Rate Limiting ─────────────────────────────────────────────────
    const rateLimitResult = this.rateLimiter.isAllowed(`payment:${studentId}`);
    if (!rateLimitResult.allowed) {
      return new PaymentProcessingResult(false, {}, {
        message: 'Rate limit exceeded',
        code: 'RATE_LIMIT_EXCEEDED',
        retryAfterMs: rateLimitResult.retryAfterMs,
      });
    }

    try {
      // ── Step 3: Check for Duplicate Transaction ─────────────────────────────
      const existingPayment = await Payment.findOne({ txHash });
      if (existingPayment) {
        logger.warn('[PaymentProcessor] Duplicate transaction', { txHash });
        const result = new PaymentProcessingResult(true, {
          duplicate: true,
          existingPaymentId: existingPayment._id,
        });
        if (idempotencyKey) this.idempotencyCache.set(idempotencyKey, result);
        return result;
      }

      // ── Step 4: Process with Chosen Lock Strategy ────────────────────────────
      let processingResult;
      
      switch (lockStrategy) {
        case CONCURRENCY_STRATEGY.PESSIMISTIC:
          processingResult = await this.processWithPessimisticLock(
            studentId,
            amount,
            txHash,
            paymentData
          );
          break;
          
        case CONCURRENCY_STRATEGY.SERIALIZABLE:
          processingResult = await this.processWithSerializableTransaction(
            studentId,
            amount,
            txHash,
            paymentData
          );
          break;
          
        case CONCURRENCY_STRATEGY.OPTIMISTIC:
        default:
          processingResult = await this.processWithOptimisticLock(
            studentId,
            amount,
            txHash,
            paymentData
          );
          break;
      }

      // ── Step 5: Cache Successful Result ─────────────────────────────────────
      if (idempotencyKey && processingResult.success) {
        this.idempotencyCache.set(idempotencyKey, processingResult);
      }

      return processingResult;
    } catch (error) {
      logger.error('[PaymentProcessor] Processing failed', {
        studentId,
        txHash,
        error: error.message,
        code: error.code,
      });

      const result = new PaymentProcessingResult(false, {}, error);
      
      if (idempotencyKey) {
        this.idempotencyCache.set(idempotencyKey, result);
      }

      return result;
    }
  }

  /**
   * Process with Optimistic Locking
   * Best for: Low contention scenarios, read-heavy workloads
   */
  async processWithOptimisticLock(studentId, amount, txHash, paymentData) {
    let attempt = 0;
    
    while (attempt < this.maxRetries) {
      try {
        // Get current student state with version
        const student = await Student.findOne({ studentId });
        
        if (!student) {
          return new PaymentProcessingResult(false, {}, {
            message: `Student not found: ${studentId}`,
            code: 'STUDENT_NOT_FOUND',
          });
        }

        // Calculate new totals
        const currentTotal = student.totalPaid || 0;
        const newTotal = currentTotal + amount;
        const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
        const isFeePaid = newTotal >= student.feeAmount;

        // Attempt atomic update with version check
        const updatedStudent = await Student.findOneAndUpdate(
          {
            studentId,
            totalPaid: currentTotal, // Version-like check
          },
          {
            $set: {
              totalPaid: newTotal,
              remainingBalance: newRemainingBalance,
              feePaid: isFeePaid,
              lastPaymentAt: new Date(),
              lastPaymentHash: txHash,
            },
          },
          { new: true }
        );

        if (!updatedStudent) {
          // Version mismatch - concurrent modification detected
          attempt++;
          const delay = 100 * Math.pow(2, attempt);
          logger.warn('[PaymentProcessor] Optimistic lock conflict', {
            studentId,
            attempt,
            maxRetries: this.maxRetries,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Create payment record
        const payment = await Payment.create({
          studentId,
          txHash,
          amount,
          feeAmount: student.feeAmount,
          feeValidationStatus: isFeePaid ? 'valid' : (amount < student.feeAmount ? 'underpaid' : 'overpaid'),
          status: 'confirmed',
          ...paymentData,
        });

        return new PaymentProcessingResult(true, {
          student,
          payment,
          newTotalPaid: newTotal,
          remainingBalance: newRemainingBalance,
          feePaid: isFeePaid,
        });

      } catch (error) {
        if (this.isRetryableError(error)) {
          attempt++;
          const delay = 100 * Math.pow(2, attempt);
          logger.warn('[PaymentProcessor] Retrying after error', {
            studentId,
            attempt,
            error: error.message,
          });
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }

    return new PaymentProcessingResult(false, {}, {
      message: `Failed after ${this.maxRetries} attempts due to concurrent modifications`,
      code: 'MAX_RETRIES_EXCEEDED',
    });
  }

  /**
   * Process with Pessimistic Locking
   * Best for: High contention scenarios, write-heavy workloads
   */
  async processWithPessimisticLock(studentId, amount, txHash, paymentData) {
    return await transactionManager.withPessimisticLock(
      async () => {
        return await transactionManager.withTransaction(async (session) => {
          // Get student with lock held
          const student = await Student.findOne({ studentId }).session(session);
          
          if (!student) {
            throw new Error(`Student not found: ${studentId}`);
          }

          // Calculate new totals
          const currentTotal = student.totalPaid || 0;
          const newTotal = currentTotal + amount;
          const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
          const isFeePaid = newTotal >= student.feeAmount;

          // Update student
          student.totalPaid = newTotal;
          student.remainingBalance = newRemainingBalance;
          student.feePaid = isFeePaid;
          student.lastPaymentAt = new Date();
          student.lastPaymentHash = txHash;
          await student.save({ session });

          // Create payment record
          const payment = await Payment.create([{
            studentId,
            txHash,
            amount,
            feeAmount: student.feeAmount,
            feeValidationStatus: isFeePaid ? 'valid' : (amount < student.feeAmount ? 'underpaid' : 'overpaid'),
            status: 'confirmed',
            ...paymentData,
          }], { session });

          return new PaymentProcessingResult(true, {
            student,
            payment: payment[0],
            newTotalPaid: newTotal,
            remainingBalance: newRemainingBalance,
            feePaid: isFeePaid,
          });
        });
      },
      {
        entityType: 'Student',
        entityId: studentId,
        lockDurationMs: this.lockTimeoutMs,
      }
    );
  }

  /**
   * Process with Serializable Transaction
   * Best for: Critical financial operations requiring strongest consistency
   */
  async processWithSerializableTransaction(studentId, amount, txHash, paymentData) {
    return await transactionManager.withTransaction(async (session) => {
      // Use find with session for strong consistency
      const student = await Student.findOne({ studentId }).session(session);
      
      if (!student) {
        throw new Error(`Student not found: ${studentId}`);
      }

      // Calculate new totals
      const currentTotal = student.totalPaid || 0;
      const newTotal = currentTotal + amount;
      const newRemainingBalance = Math.max(0, student.feeAmount - newTotal);
      const isFeePaid = newTotal >= student.feeAmount;

      // Update with conditions
      const updateResult = await Student.updateOne(
        {
          studentId,
          totalPaid: currentTotal, // Ensure no concurrent modification
        },
        {
          $set: {
            totalPaid: newTotal,
            remainingBalance: newRemainingBalance,
            feePaid: isFeePaid,
            lastPaymentAt: new Date(),
            lastPaymentHash: txHash,
          },
        },
        { session }
      );

      if (updateResult.matchedCount === 0) {
        throw new Error('Concurrent modification detected - transaction aborted');
      }

      // Create payment record
      const payment = await Payment.create([{
        studentId,
        txHash,
        amount,
        feeAmount: student.feeAmount,
        feeValidationStatus: isFeePaid ? 'valid' : (amount < student.feeAmount ? 'underpaid' : 'overpaid'),
        status: 'confirmed',
        ...paymentData,
      }], { session });

      return new PaymentProcessingResult(true, {
        student,
        payment: payment[0],
        newTotalPaid: newTotal,
        remainingBalance: newRemainingBalance,
        feePaid: isFeePaid,
      });
    });
  }

  /**
   * Check if error is retryable
   */
  isRetryableError(error) {
    const retryablePatterns = [
      'TransientTransactionError',
      'WriteConflict',
      'LockTimeout',
      'WriteConflict:',
    ];
    
    return (
      error.hasErrorLabel?.('TransientTransactionError') ||
      error.code === 112 ||
      error.code === 189 ||
      retryablePatterns.some(pattern => error.message?.includes(pattern))
    );
  }

  /**
   * Process batch payments with concurrency control
   */
  async processBatch(payments, options = {}) {
    const results = [];
    const concurrencyLimit = options.concurrencyLimit || 10;
    const maxRetries = options.maxRetries || 3;

    // Process in controlled batches
    for (let i = 0; i < payments.length; i += concurrencyLimit) {
      const batch = payments.slice(i, i + concurrencyLimit);
      
      const batchResults = await Promise.allSettled(
        batch.map(payment => this.processPayment(payment, options))
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push({ success: true, data: result.value });
        } else {
          results.push({ success: false, error: result.reason.message });
        }
      }
    }

    return {
      total: payments.length,
      successful: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      results,
    };
  }

  /**
   * Get processor statistics
   */
  getStats() {
    return {
      idempotencyCacheSize: this.idempotencyCache.cache.size,
      rateLimiterStats: {
        trackedKeys: this.rateLimiter.requests.size,
      },
      transactionManagerStats: {
        activeTransactions: transactionManager.getActiveTransactionCount(),
      },
    };
  }
}

// ── Singleton Instance ──────────────────────────────────────────────────────────
const concurrentPaymentProcessor = new ConcurrentPaymentProcessor({
  idempotencyTtlMs: 60000,
  maxRequestsPerSecond: 100,
  lockStrategy: CONCURRENCY_STRATEGY.OPTIMISTIC,
  lockTimeoutMs: 30000,
  maxRetries: 3,
});

module.exports = {
  concurrentPaymentProcessor,
  ConcurrentPaymentProcessor,
  PaymentProcessingResult,
  IdempotencyCache,
  RateLimiter,
  CONCURRENCY_STRATEGY,
};
