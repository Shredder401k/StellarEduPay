/**
 * Concurrent Payment Processing Examples
 * 
 * This file demonstrates how to use the concurrent transaction handling
 * features in a production environment.
 */

'use strict';

const {
  concurrentPaymentProcessor,
  CONCURRENCY_STRATEGY
} = require('../services/concurrentPaymentProcessor');
const {
  transactionManager,
  safeDebit,
  safeCredit,
  atomicTransfer,
  LOCK_TYPE
} = require('../services/transactionManager');
const {
  createConcurrentRequestMiddleware,
  createConcurrentPaymentRoutes,
  CircuitBreaker,
  RequestQueue
} = require('../middleware/concurrentRequestHandler');

// ─────────────────────────────────────────────────────────────────────────────────
// Example 1: Basic Payment Processing with Different Locking Strategies
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Processing a single payment with optimistic locking (default)
 * Best for: Low contention scenarios
 */
async function exampleOptimisticLock() {
  console.log('\n=== Example: Optimistic Locking ===');
  
  const result = await concurrentPaymentProcessor.processPayment(
    {
      memo: 'Fee payment for January',
      senderAddress: 'GABCD123...XYZ',
      ledger: 1234567
    },
    {
      idempotencyKey: `payment-${Date.now()}-001`,
      studentId: 'STU001',
      amount: 500.00,
      txHash: 'abc123def456789' + Date.now(),
      lockStrategy: CONCURRENCY_STRATEGY.OPTIMISTIC
    }
  );

  console.log('Result:', JSON.stringify(result.toJSON(), null, 2));
  return result;
}

/**
 * Example: Processing a payment with pessimistic locking
 * Best for: High contention, critical transactions
 */
async function examplePessimisticLock() {
  console.log('\n=== Example: Pessimistic Locking ===');
  
  const result = await concurrentPaymentProcessor.processPayment(
    {
      memo: 'Fee payment with pessimistic lock',
      senderAddress: 'GABCD123...XYZ'
    },
    {
      idempotencyKey: `payment-${Date.now()}-002`,
      studentId: 'STU002',
      amount: 750.00,
      txHash: 'pqr789def456' + Date.now(),
      lockStrategy: CONCURRENCY_STRATEGY.PESSIMISTIC
    }
  );

  console.log('Result:', JSON.stringify(result.toJSON(), null, 2));
  return result;
}

/**
 * Example: Processing a payment with serializable transaction
 * Best for: Critical financial operations requiring strongest consistency
 */
async function exampleSerializableTransaction() {
  console.log('\n=== Example: Serializable Transaction ===');
  
  const result = await concurrentPaymentProcessor.processPayment(
    {
      memo: 'Critical bulk payment',
      senderAddress: 'GCRITICAL001...'
    },
    {
      idempotencyKey: `payment-${Date.now()}-003`,
      studentId: 'STU003',
      amount: 1000.00,
      txHash: 'critical789' + Date.now(),
      lockStrategy: CONCURRENCY_STRATEGY.SERIALIZABLE
    }
  );

  console.log('Result:', JSON.stringify(result.toJSON(), null, 2));
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 2: Safe Debit and Credit Operations
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Safe credit operation (adding funds)
 * Automatically handles transaction management
 */
async function exampleSafeCredit() {
  console.log('\n=== Example: Safe Credit ===');
  
  try {
    const result = await safeCredit('STU001', 250.00, {
      reference: 'CREDIT-' + Date.now()
    });

    console.log('Credit successful:', {
      success: result.success,
      accountId: result.accountId,
      credited: result.credited,
      newTotalPaid: result.newTotalPaid,
      remainingBalance: result.remainingBalance,
      feePaid: result.feePaid
    });

    return result;
  } catch (error) {
    console.error('Credit failed:', {
      code: error.code,
      message: error.message
    });
    throw error;
  }
}

/**
 * Example: Safe debit operation (withdrawing funds)
 * Includes balance check
 */
async function exampleSafeDebit() {
  console.log('\n=== Example: Safe Debit ===');
  
  try {
    const result = await safeDebit('STU001', 100.00, {
      reference: 'DEBIT-' + Date.now()
    });

    console.log('Debit successful:', {
      success: result.success,
      accountId: result.accountId,
      debited: result.debited,
      newBalance: result.newBalance
    });

    return result;
  } catch (error) {
    console.error('Debit failed:', {
      code: error.code,
      message: error.message
    });
    throw error;
  }
}

/**
 * Example: Atomic transfer between accounts
 * Both debit and credit in single transaction
 */
async function exampleAtomicTransfer() {
  console.log('\n=== Example: Atomic Transfer ===');
  
  try {
    const result = await atomicTransfer(
      'STU001',  // From account
      'STU002',  // To account
      150.00,    // Amount
      { reference: 'TRANSFER-' + Date.now() }
    );

    console.log('Transfer successful:', {
      success: result.success,
      fromAccountId: result.fromAccountId,
      toAccountId: result.toAccountId,
      amount: result.amount,
      sourceNewBalance: result.sourceNewBalance,
      destNewBalance: result.destNewBalance
    });

    return result;
  } catch (error) {
    console.error('Transfer failed:', {
      code: error.code,
      message: error.message
    });
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 3: Batch Processing with Concurrency Control
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Processing multiple payments with controlled concurrency
 */
async function exampleBatchProcessing() {
  console.log('\n=== Example: Batch Processing ===');
  
  const payments = [
    { studentId: 'STU001', amount: 100, txHash: 'batch-hash-001', memo: 'Payment 1' },
    { studentId: 'STU002', amount: 200, txHash: 'batch-hash-002', memo: 'Payment 2' },
    { studentId: 'STU003', amount: 150, txHash: 'batch-hash-003', memo: 'Payment 3' },
    { studentId: 'STU004', amount: 300, txHash: 'batch-hash-004', memo: 'Payment 4' },
    { studentId: 'STU005', amount: 250, txHash: 'batch-hash-005', memo: 'Payment 5' },
    { studentId: 'STU006', amount: 175, txHash: 'batch-hash-006', memo: 'Payment 6' },
    { studentId: 'STU007', amount: 225, txHash: 'batch-hash-007', memo: 'Payment 7' },
    { studentId: 'STU008', amount: 125, txHash: 'batch-hash-008', memo: 'Payment 8' },
    { studentId: 'STU009', amount: 275, txHash: 'batch-hash-009', memo: 'Payment 9' },
    { studentId: 'STU010', amount: 325, txHash: 'batch-hash-010', memo: 'Payment 10' },
  ];

  const result = await concurrentPaymentProcessor.processBatch(payments, {
    concurrencyLimit: 3,  // Process 3 at a time
    maxRetries: 2
  });

  console.log('Batch processing result:', {
    total: result.total,
    successful: result.successful,
    failed: result.failed,
    successRate: `${((result.successful / result.total) * 100).toFixed(1)}%`
  });

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 4: Concurrent Request Handling Middleware
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Creating Express routes with all middleware
 */
function exampleExpressMiddleware() {
  console.log('\n=== Example: Express Middleware Setup ===');
  
  const express = require('express');
  const app = express();
  
  // Create middleware with custom options
  const middleware = createConcurrentRequestMiddleware({
    circuitBreaker: {
      failureThreshold: 5,
      resetTimeoutMs: 30000,
      halfOpenSuccessThreshold: 2
    },
    queue: {
      maxConcurrent: 50,
      maxSize: 1000,
      defaultTimeoutMs: 30000
    },
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100
    },
    deduplicationTtlMs: 60000
  });

  // Create payment routes
  const paymentRoutes = createConcurrentPaymentRoutes(concurrentPaymentProcessor);

  // Apply middleware globally
  app.use(middleware.requestQueue());
  
  // Apply rate limiting per client IP
  app.use('/api', middleware.rateLimiter((req) => req.ip));

  // Apply circuit breaker to health endpoints
  app.get('/health', 
    middleware.circuitBreaker(async (req, res) => {
      const db = require('../config/database');
      const health = await db.healthCheck();
      res.json(health);
    })
  );

  // Apply payment routes
  app.use('/api/payments', paymentRoutes);

  console.log('Express middleware configured successfully');
  console.log('Routes available:');
  console.log('  POST /api/payments/process - Process single payment');
  console.log('  POST /api/payments/batch - Process batch payments');
  console.log('  GET  /api/payments/stats - Get processor stats');
  console.log('  GET  /api/payments/health - Health check');

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 5: Circuit Breaker Usage
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Manual circuit breaker usage
 */
async function exampleCircuitBreaker() {
  console.log('\n=== Example: Circuit Breaker ===');
  
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    resetTimeoutMs: 5000,  // Short for demo
    halfOpenSuccessThreshold: 1
  });

  // Simulate operation
  const simulateOperation = async (shouldFail = false) => {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (shouldFail) {
      throw new Error('Operation failed');
    }
    return { success: true, data: 'Operation result' };
  };

  // Test circuit breaker
  console.log('Circuit state:', breaker.getState());

  // Successful operations
  for (let i = 0; i < 3; i++) {
    try {
      const result = await breaker.execute(() => simulateOperation(false));
      console.log(`Operation ${i + 1} succeeded:`, result);
    } catch (error) {
      console.log(`Operation ${i + 1} failed:`, error.message);
    }
  }
  console.log('After successes, circuit state:', breaker.getState());

  // Fail enough to open circuit
  console.log('\nTriggering failures to open circuit...');
  for (let i = 0; i < 3; i++) {
    try {
      await breaker.execute(() => simulateOperation(true));
    } catch (error) {
      console.log(`Failure ${i + 1}:`, error.message);
    }
  }
  console.log('After failures, circuit state:', breaker.getState());

  // Wait for reset timeout
  console.log('\nWaiting for circuit reset...');
  await new Promise(resolve => setTimeout(resolve, 6000));
  console.log('After timeout, circuit state:', breaker.getState());

  // Test half-open state
  try {
    const result = await breaker.execute(() => simulateOperation(false));
    console.log('Half-open test succeeded:', result);
  } catch (error) {
    console.log('Half-open test failed:', error.message);
  }
  console.log('Final circuit state:', breaker.getState());

  return breaker;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 6: Request Queue Usage
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Request queue with priority
 */
async function exampleRequestQueue() {
  console.log('\n=== Example: Request Queue ===');
  
  const queue = new RequestQueue({
    maxConcurrent: 2,
    maxSize: 100,
    defaultTimeoutMs: 5000
  });

  const processTask = async (id, duration = 100) => {
    await new Promise(resolve => setTimeout(resolve, duration));
    return { taskId: id, completed: true };
  };

  // Submit tasks with different priorities
  console.log('Submitting tasks...');
  
  const results = await Promise.all([
    // Low priority
    queue.enqueue(() => processTask('low-priority-1', 200), 0),
    queue.enqueue(() => processTask('low-priority-2', 200), 0),
    
    // Medium priority
    queue.enqueue(() => processTask('medium-priority-1', 150), 5),
    
    // High priority
    queue.enqueue(() => processTask('high-priority-1', 100), 10),
  ]);

  console.log('Queue stats:', queue.getStats());
  console.log('Results:', results);

  return { queue, results };
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 7: Advanced Transaction with Custom Retry Logic
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Custom transaction with specific retry logic
 */
async function exampleAdvancedTransaction() {
  console.log('\n=== Example: Advanced Transaction ===');
  
  const customOperation = async () => {
    // Start a custom transaction
    const { session, transactionId } = await transactionManager.startSession();
    
    try {
      const Student = require('../models/studentModel');
      
      // Perform multiple operations within transaction
      const student = await Student.findOne({ studentId: 'STU001' }).session(session);
      
      if (!student) {
        throw new Error('Student not found');
      }

      // Calculate new balance
      const newBalance = student.totalPaid + 100;
      const remainingBalance = Math.max(0, student.feeAmount - newBalance);

      // Update with conditions
      await Student.updateOne(
        { studentId: 'STU001', totalPaid: student.totalPaid },
        {
          $set: {
            totalPaid: newBalance,
            remainingBalance,
            feePaid: newBalance >= student.feeAmount
          }
        },
        { session }
      );

      // Commit
      await transactionManager.commitTransaction(session, transactionId);

      console.log('Transaction committed successfully');
      return {
        studentId: 'STU001',
        previousBalance: student.totalPaid,
        newBalance,
        remainingBalance
      };

    } catch (error) {
      // Rollback on any error
      await transactionManager.abortTransaction(session, transactionId);
      throw error;
    }
  };

  // Execute with retry
  try {
    const result = await transactionManager.withRetry(customOperation, {
      maxRetries: 3,
      retryDelayMs: 100
    });
    console.log('Result:', result);
    return result;
  } catch (error) {
    console.error('Transaction failed after retries:', error.message);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────
// Example 8: Idempotency Demonstration
// ─────────────────────────────────────────────────────────────────────────────────

/**
 * Example: Demonstrating idempotency with concurrent requests
 */
async function exampleIdempotency() {
  console.log('\n=== Example: Idempotency ===');
  
  const idempotencyKey = `idempotent-${Date.now()}`;
  
  // Simulate multiple concurrent requests with same idempotency key
  const concurrentRequests = Array(5).fill().map((_, i) => {
    return concurrentPaymentProcessor.processPayment(
      {
        memo: `Concurrent request ${i}`,
        senderAddress: 'GXYZ...'
      },
      {
        idempotencyKey,
        studentId: 'STU001',
        amount: 100 + i,
        txHash: `unique-hash-${Date.now()}-${i}`
      }
    );
  });

  console.log(`Sending ${concurrentRequests.length} concurrent requests with same idempotency key...`);
  
  const results = await Promise.all(concurrentRequests);
  
  // Count successes and cached results
  const successful = results.filter(r => r.success).length;
  const cached = results.filter(r => r.data?.duplicate === true).length;
  
  console.log(`Results: ${successful} successful, ${cached} returned from cache`);
  console.log('Only one actual transaction should be processed!');

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────────
// Run All Examples
// ─────────────────────────────────────────────────────────────────────────────────

async function runAllExamples() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     Concurrent Transaction Handling - Examples               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  try {
    // Example 1: Basic payment processing
    // await exampleOptimisticLock();
    // await examplePessimisticLock();
    // await exampleSerializableTransaction();

    // Example 2: Safe debit/credit
    // await exampleSafeCredit();
    // await exampleSafeDebit();
    // await exampleAtomicTransfer();

    // Example 3: Batch processing
    // await exampleBatchProcessing();

    // Example 4: Express middleware
    exampleExpressMiddleware();

    // Example 5: Circuit breaker
    // await exampleCircuitBreaker();

    // Example 6: Request queue
    // await exampleRequestQueue();

    // Example 7: Advanced transaction
    // await exampleAdvancedTransaction();

    // Example 8: Idempotency
    // await exampleIdempotency();

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║     All Examples Completed Successfully                     ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

  } catch (error) {
    console.error('Example failed:', error);
  }
}

// Export examples
module.exports = {
  exampleOptimisticLock,
  examplePessimisticLock,
  exampleSerializableTransaction,
  exampleSafeCredit,
  exampleSafeDebit,
  exampleAtomicTransfer,
  exampleBatchProcessing,
  exampleExpressMiddleware,
  exampleCircuitBreaker,
  exampleRequestQueue,
  exampleAdvancedTransaction,
  exampleIdempotency,
  runAllExamples
};

// Run if called directly
if (require.main === module) {
  runAllExamples();
}
