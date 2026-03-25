const { checkConsistency } = require('../backend/src/services/consistencyService');

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockOperations = jest.fn();

jest.mock('../backend/src/config/stellarConfig', () => ({
  SCHOOL_WALLET: 'GSCHOOL123',
  server: {
    transactions: () => ({
      forAccount: () => ({
        order: () => ({
          limit: () => ({
            call: async () => ({ records: mockChainTxs }),
          }),
        }),
      }),
    }),
  },
}));

const mockFind = jest.fn();
jest.mock('../backend/src/models/paymentModel', () => ({
  find: (...args) => ({ lean: () => mockFind(...args) }),
}));

jest.mock('../backend/src/models/studentModel', () => ({}));

const Payment = { find: mockFind };

// Shared mutable array so individual tests can populate it
let mockChainTxs = [];

function makeChainTx(hash, memo, amount) {
  return {
    hash,
    memo,
    successful: true,
    operations: async () => ({
      records: [{ type: 'payment', to: 'GSCHOOL123', amount: String(amount) }],
    }),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockChainTxs = [];
  mockFind.mockReset();
});

describe('checkConsistency', () => {
  test('returns clean report when DB and chain match', async () => {
    mockChainTxs = [makeChainTx('hash1', 'STU001', 250)];
    mockFind.mockResolvedValue([
      { txHash: 'hash1', studentId: 'STU001', amount: 250 },
    ]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(0);
    expect(report.mismatches).toHaveLength(0);
    expect(report.totalDbPayments).toBe(1);
    expect(report.totalChainTxsScanned).toBe(1);
  });

  test('flags missing_on_chain when DB payment has no matching chain tx', async () => {
    mockChainTxs = [];
    mockFind.mockResolvedValue([
      { txHash: 'ghost_hash', studentId: 'STU002', amount: 100 },
    ]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('missing_on_chain');
    expect(report.mismatches[0].txHash).toBe('ghost_hash');
  });

  test('flags amount_mismatch when DB amount differs from chain', async () => {
    mockChainTxs = [makeChainTx('hash2', 'STU003', 300)];
    mockFind.mockResolvedValue([
      { txHash: 'hash2', studentId: 'STU003', amount: 150 }, // wrong amount
    ]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('amount_mismatch');
    expect(report.mismatches[0].dbAmount).toBe(150);
    expect(report.mismatches[0].chainAmount).toBe(300);
  });

  test('flags student_mismatch when DB studentId differs from chain memo', async () => {
    mockChainTxs = [makeChainTx('hash3', 'STU999', 200)];
    mockFind.mockResolvedValue([
      { txHash: 'hash3', studentId: 'STU001', amount: 200 }, // wrong student
    ]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(1);
    expect(report.mismatches[0].type).toBe('student_mismatch');
    expect(report.mismatches[0].dbStudentId).toBe('STU001');
    expect(report.mismatches[0].chainMemo).toBe('STU999');
  });

  test('reports multiple mismatches across different payments', async () => {
    mockChainTxs = [makeChainTx('hash4', 'STU010', 500)];
    mockFind.mockResolvedValue([
      { txHash: 'hash4', studentId: 'STU010', amount: 999 }, // amount mismatch
      { txHash: 'missing', studentId: 'STU011', amount: 100 }, // missing on chain
    ]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(2);
    const types = report.mismatches.map(m => m.type);
    expect(types).toContain('amount_mismatch');
    expect(types).toContain('missing_on_chain');
  });

  test('returns empty report when DB has no payments', async () => {
    mockChainTxs = [makeChainTx('hash5', 'STU020', 100)];
    mockFind.mockResolvedValue([]);

    const report = await checkConsistency();

    expect(report.mismatchCount).toBe(0);
    expect(report.totalDbPayments).toBe(0);
  });

  test('report includes checkedAt timestamp', async () => {
    mockChainTxs = [];
    mockFind.mockResolvedValue([]);

    const report = await checkConsistency();

    expect(report.checkedAt).toBeDefined();
    expect(new Date(report.checkedAt).toString()).not.toBe('Invalid Date');
  });
});

// ─── Scheduler tests ──────────────────────────────────────────────────────────

describe('consistencyScheduler', () => {
  let startConsistencyScheduler, stopConsistencyScheduler;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.resetModules();

    // Re-mock consistencyService for the scheduler module
    jest.mock('../backend/src/services/consistencyService', () => ({
      checkConsistency: jest.fn().mockResolvedValue({
        checkedAt: new Date().toISOString(),
        totalDbPayments: 0,
        totalChainTxsScanned: 0,
        mismatchCount: 0,
        mismatches: [],
      }),
    }));

    ({ startConsistencyScheduler, stopConsistencyScheduler } =
      require('../backend/src/services/consistencyScheduler'));
  });

  afterEach(() => {
    stopConsistencyScheduler();
    jest.useRealTimers();
  });

  test('runs an immediate check on start', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve(); // flush microtasks
    expect(checkConsistency).toHaveBeenCalledTimes(1);
  });

  test('runs again after the interval elapses', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve();
    jest.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    expect(checkConsistency).toHaveBeenCalledTimes(2);
  });

  test('stop prevents further checks', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    startConsistencyScheduler();
    await Promise.resolve();
    stopConsistencyScheduler();
    jest.advanceTimersByTime(5 * 60 * 1000);
    await Promise.resolve();
    expect(checkConsistency).toHaveBeenCalledTimes(1);
  });

  test('logs a warning when mismatches are found', async () => {
    const { checkConsistency } = require('../backend/src/services/consistencyService');
    checkConsistency.mockResolvedValueOnce({
      checkedAt: new Date().toISOString(),
      totalDbPayments: 1,
      totalChainTxsScanned: 0,
      mismatchCount: 1,
      mismatches: [{ type: 'missing_on_chain', message: 'tx ghost not found on-chain' }],
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    startConsistencyScheduler();
    await Promise.resolve();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1 mismatch(es) detected'));
    warnSpy.mockRestore();
  });
});
