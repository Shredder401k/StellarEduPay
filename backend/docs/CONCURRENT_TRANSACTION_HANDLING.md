# Concurrent Transaction Handling - Production Implementation

## Overview

This document describes the production-ready concurrent request handling implementation for the StellarEduPay backend, designed to safely process high-traffic financial transactions with guaranteed data consistency.

## Architecture

The implementation consists of several interconnected components:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Express Application                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────────────┐   │
│  │ Rate Limiter     │  │ Circuit Breaker  │  │ Request Queue           │   │
│  │ (Per-client)     │  │ (Fault tolerant) │  │ (Load management)        │   │
│  └────────┬─────────┘  └────────┬─────────┘  └──────────┬───────────────┘   │
│           │                    │                        │                    │
│           └────────────────────┼────────────────────────┘                    │
│                                ▼                                             │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                     Idempotency Layer                                   │  │
│  │                     (Deduplication + Caching)                           │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │              Concurrent Payment Processor                               │  │
│  │  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────────┐ │  │
│  │  │ Optimistic Lock │  │ Pessimistic Lock  │  │ Serializable Trans.    │ │  │
│  │  │ (Low conflict)  │  │ (High conflict)   │  │ (Critical operations)  │ │  │
│  │  └─────────────────┘  └──────────────────┘  └────────────────────────┘ │  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                    Transaction Manager                                   │  │
│  │  ┌───────────────┐  ┌────────────────┐  ┌──────────────────────────────┐│  │
│  │  │ MongoDB       │  │ Automatic      │  │ Safe Debit/Credit          ││  │
│  │  │ Sessions      │  │ Retry + Backoff │  │ Operations                 ││  │
│  │  └───────────────┘  └────────────────┘  └──────────────────────────────┘│  │
│  └────────────────────────────────┬────────────────────────────────────────┘  │
│                                   ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │              Database Layer (MongoDB with Connection Pool)              │  │
│  │  ┌──────────────┐  ┌───────────────┐  ┌───────────────────────────────┐  │  │
│  │  │ Connection   │  │ Write Concern │  │ Read Concern (Majority)     │  │  │
│  │  │ Pool (100)   │  │ W:1+          │  │                             │  │  │
│  │  └──────────────┘  └───────────────┘  └───────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### 1. Database Configuration ([`src/config/database.js`](src/config/database.js))

**Connection Pool Configuration:**
```javascript
{
  maxPoolSize: 100,        // Maximum concurrent connections
  minPoolSize: 10,         // Minimum maintained connections
  maxIdleTimeMS: 30000,   // Connection idle timeout
  connectTimeoutMS: 10000, // Initial connection timeout
  socketTimeoutMS: 45000,  // Socket operation timeout
}
```

**Key Features:**
- **Automatic Retry**: Exponential backoff for transient connection errors
- **Health Checks**: Built-in connection health monitoring
- **Graceful Disconnect**: Clean shutdown handling
- **Event Hooks**: Connection state tracking and logging

### 2. Transaction Manager ([`src/services/transactionManager.js`](src/services/transactionManager.js))

The transaction manager provides ACID guarantees for MongoDB operations:

#### Transaction Flow
```javascript
// BEGIN TRANSACTION
const { session, transactionId } = await transactionManager.startSession();

try {
  // Read phase
  const student = await Student.findOne({ studentId }).session(session);
  
  // Validation
  if (student.totalPaid < amount) {
    throw new Error('Insufficient balance');
  }
  
  // Write phase
  student.totalPaid -= amount;
  await student.save({ session });
  
  // COMMIT TRANSACTION
  await transactionManager.commitTransaction(session, transactionId);
  
} catch (error) {
  // ROLLBACK TRANSACTION
  await transactionManager.abortTransaction(session, transactionId);
  throw error;
}
```

#### Safe Debit/Credit Operations

**Safe Debit** (`safeDebit`):
```javascript
// Atomic debit with balance check
const result = await safeDebit(studentId, amount);

// Internally uses: findOneAndUpdate with $expr for atomic check
Student.findOneAndUpdate(
  {
    studentId,
    $expr: { $gte: ['$totalPaid', amount] } // Atomic balance validation
  },
  {
    $inc: { totalPaid: -amount }
  }
);
```

**Safe Credit** (`safeCredit`):
```javascript
// Atomic credit operation
const result = await safeCredit(studentId, amount);

// Creates student if not exists (upsert: true)
Student.findOneAndUpdate(
  { studentId },
  {
    $inc: { totalPaid: amount },
    $set: { lastPaymentAt: new Date() }
  },
  { upsert: true }
);
```

### 3. Locking Strategies

#### Optimistic Locking
**Best for**: Low contention, read-heavy workloads

```javascript
// Version-based locking with automatic retry
const result = await processor.processWithOptimisticLock(
  studentId,
  amount,
  txHash,
  paymentData
);

// Mechanism:
// 1. Read current state with version
const student = await Student.findOne({ studentId });
// 2. Attempt update with version check
await Student.findOneAndUpdate(
  { studentId, totalPaid: student.totalPaid }, // Version check
  { $set: { totalPaid: newTotal } }
);
// 3. If update fails (matchedCount === 0), retry
```

**Advantages:**
- No lock acquisition overhead
- High throughput for read-heavy workloads
- Lower latency

**Disadvantages:**
- Retry overhead under contention
- Not suitable for high-write scenarios

#### Pessimistic Locking
**Best for**: High contention, write-heavy workloads

```javascript
// Explicit lock acquisition before operation
const result = await processor.processWithPessimisticLock(
  studentId,
  amount,
  txHash,
  paymentData
);

// Mechanism:
// 1. Acquire lock atomically
await VersionCounter.findOneAndUpdate(
  {
    entityType: 'Student',
    entityId: studentId,
    lockedUntil: null  // No existing lock
  },
  {
    $set: {
      lockedUntil: lockDeadline,
      lockHolder: lockId
    }
  }
);
// 2. Execute protected operation
// 3. Release lock
```

**Advantages:**
- No retry overhead
- Guaranteed exclusive access
- Predictable latency

**Disadvantages:**
- Lock acquisition overhead
- Potential deadlocks (mitigated by lock ordering)
- Lower throughput under contention

#### Serializable Transactions
**Best for**: Critical financial operations requiring strongest consistency

```javascript
// Highest isolation level
const result = await processor.processWithSerializableTransaction(
  studentId,
  amount,
  txHash,
  paymentData
);

// MongoDB serializable snapshot isolation
// Automatically aborts conflicting transactions
```

### 4. Race Condition Prevention

#### Atomic Balance Updates

**Problem**: Multiple concurrent requests read balance, then write

```
Time    Request A              Request B              Database
─────────────────────────────────────────────────────────────────────
T1      READ balance: 100                              balance = 100
T2                                  READ balance: 100
T3      WRITE: 100 - 50 = 50                          balance = 50
T4                                  WRITE: 100 - 30 = 70
                                                           balance = 70 (WRONG!)
```

**Solution**: Atomic update with conditional check

```javascript
// MongoDB atomic operation with $expr
Student.findOneAndUpdate(
  {
    studentId,
    $expr: { $gte: ['$totalPaid', amount] } // Evaluated atomically
  },
  {
    $inc: { totalPaid: -amount }
  }
);
```

#### Idempotency Key Support

```javascript
// Client provides unique idempotency key
const result = await processor.processPayment(
  paymentData,
  {
    idempotencyKey: 'unique-request-id-123',
    studentId,
    amount,
    txHash
  }
);

// Subsequent requests with same key return cached result
if (idempotencyCache.has(idempotencyKey)) {
  return idempotencyCache.get(idempotencyKey);
}
```

### 5. Retry Logic with Exponential Backoff

```javascript
// Automatic retry configuration
const transactionManager = new TransactionManager({
  maxRetries: 3,
  retryDelayMs: 100,
  maxRetryDelayMs: 5000,
  transactionTimeoutMs: 30000,
});

// Retry delay calculation
calculateBackoff(attempt) {
  const delay = retryDelayMs * Math.pow(2, attempt);
  return Math.min(delay, maxRetryDelayMs);
}

// Retry on transient errors
if (isRetryableError(error)) {
  const delay = calculateBackoff(attempt);
  await sleep(delay);
  return await operation(); // Retry
}
```

**Retryable Errors:**
- `TransientTransactionError` (MongoDB label)
- `WriteConflict` (code 112)
- `LockTimeout` (code 189)
- Network timeouts
- Connection resets

### 6. Express Middleware ([`src/middleware/concurrentRequestHandler.js`](src/middleware/concurrentRequestHandler.js))

#### Circuit Breaker

```javascript
// Circuit breaker protects against cascading failures
const breaker = new CircuitBreaker({
  failureThreshold: 5,        // Open after 5 failures
  resetTimeoutMs: 30000,      // Try again after 30s
  halfOpenSuccessThreshold: 2 // Require 2 successes to close
});

// Automatic state transitions
// CLOSED → (failures >= threshold) → OPEN
// OPEN → (timeout) → HALF_OPEN
// HALF_OPEN → (successes >= threshold) → CLOSED
// HALF_OPEN → (failure) → OPEN
```

#### Rate Limiter

```javascript
// Per-client rate limiting
const rateLimiter = middleware.rateLimiter((req) => req.ip);

// Returns 429 when limit exceeded
res.status(429).json({
  error: 'Too many requests',
  retryAfter: 60
});
```

#### Request Queue

```javascript
// Queue overflow requests during high load
const queue = new RequestQueue({
  maxConcurrent: 50,
  maxSize: 1000,
  defaultTimeoutMs: 30000
});

// Priority queuing for critical operations
await queue.enqueue(
  operation,
  priority = 0,      // Higher priority = processed first
  timeoutMs = 30000
);
```

## API Usage Examples

### Single Payment Processing

```bash
# Process payment with optimistic locking (default)
curl -X POST http://localhost:5000/api/payments/process \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: unique-payment-id-123" \
  -d '{
    "studentId": "STU001",
    "amount": 500,
    "txHash": "abc123def456...",
    "memo": "Fee payment",
    "senderAddress": "GABC...XYZ"
  }'

# Response
{
  "success": true,
  "data": {
    "newTotalPaid": 1500,
    "remainingBalance": 500,
    "feePaid": false,
    "payment": { ... }
  },
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Batch Processing

```bash
# Process multiple payments with controlled concurrency
curl -X POST http://localhost:5000/api/payments/batch \
  -H "Content-Type: application/json" \
  -d '{
    "payments": [
      { "studentId": "STU001", "amount": 100, "txHash": "hash1" },
      { "studentId": "STU002", "amount": 200, "txHash": "hash2" },
      { "studentId": "STU003", "amount": 150, "txHash": "hash3" }
    ],
    "concurrencyLimit": 5
  }'

# Response
{
  "total": 3,
  "successful": 3,
  "failed": 0,
  "results": [ ... ]
}
```

### Health Check

```bash
curl http://localhost:5000/api/payments/health

# Response
{
  "status": "healthy",
  "circuitBreaker": {
    "state": "closed",
    "failureCount": 0
  },
  "queue": {
    "queueLength": 5,
    "processing": 10,
    "maxConcurrent": 50
  }
}
```

## Data Corruption Prevention

### How Data Corruption is Prevented

1. **Atomic Operations**
   ```javascript
   // Single atomic operation instead of read-modify-write
   Student.findOneAndUpdate(
     { studentId },
     { $inc: { totalPaid: amount } }  // Atomic increment
   );
   ```

2. **Transaction Isolation**
   ```javascript
   // All reads/writes in same transaction
   await transactionManager.withTransaction(async (session) => {
     const student = await Student.findOne({ studentId }).session(session);
     // ... validation ...
     student.totalPaid += amount;
     await student.save({ session });
   });
   ```

3. **Version Checking**
   ```javascript
   // Optimistic: Only update if version unchanged
   Student.findOneAndUpdate(
     { studentId, version: expectedVersion },
     { $set: { ... }, $inc: { version: 1 } }
   );
   ```

4. **Write Concern**
   ```javascript
   // Wait for majority acknowledgment
   await collection.insertOne(doc, { writeConcern: { w: 'majority' } });
   ```

5. **Read Concern**
   ```javascript
   // Read only committed data
   await collection.find({}, { readConcern: { level: 'majority' } });
   ```

## Configuration Reference

### Environment Variables

```bash
# Database Connection Pool
DB_MAX_POOL_SIZE=100
DB_MIN_POOL_SIZE=10
DB_MAX_IDLE_TIME_MS=30000
DB_CONNECT_TIMEOUT_MS=10000
DB_SOCKET_TIMEOUT_MS=45000

# Transaction Settings
DB_READ_CONCERN=majority
DB_WRITE_CONCERN=1
DB_JOURNAL=true
DB_TRANSACTION_TIMEOUT_MS=30000

# Retry Configuration
DB_MAX_RETRIES=3
DB_INITIAL_RETRY_DELAY_MS=100
DB_MAX_RETRY_DELAY_MS=5000

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Circuit Breaker
CIRCUIT_FAILURE_THRESHOLD=5
CIRCUIT_RESET_TIMEOUT_MS=30000
```

## Performance Considerations

### Connection Pool Sizing

| Load Level | maxPoolSize | Expected Throughput |
|------------|-------------|---------------------|
| Low        | 10-20       | ~100 req/s          |
| Medium     | 50-100      | ~500 req/s          |
| High       | 100-200     | ~1000+ req/s        |

### Lock Strategy Selection

| Scenario | Recommended Strategy |
|----------|---------------------|
| Low contention, many reads | Optimistic Locking |
| High contention, many writes | Pessimistic Locking |
| Critical financial operations | Serializable Transaction |
| Unknown contention level | Optimistic with retry fallback |

## Testing Recommendations

1. **Load Testing**: Use k6 or Artillery to simulate concurrent requests
2. **Chaos Testing**: Kill replica set members during transactions
3. **Race Condition Testing**: Send simultaneous requests to same account
4. **Idempotency Testing**: Send same request with same idempotency key

## Production Checklist

- [ ] Configure replica set for transactions
- [ ] Set appropriate write/read concerns
- [ ] Monitor connection pool metrics
- [ ] Set up circuit breaker alerts
- [ ] Configure rate limiting thresholds
- [ ] Enable query logging for debugging
- [ ] Set up transaction timeout alerts
- [ ] Configure proper index for studentId queries
