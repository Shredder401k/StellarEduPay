const { server, SCHOOL_WALLET } = require('../config/stellarConfig');
const Payment = require('../models/paymentModel');
const Student = require('../models/studentModel');

/**
 * Fetch all transactions for the school wallet from Horizon (up to 200).
 */
async function fetchChainTransactions() {
  const result = await server.transactions()
    .forAccount(SCHOOL_WALLET)
    .order('desc')
    .limit(200)
    .call();
  return result.records;
}

/**
 * Compare DB payments against on-chain transactions and return mismatches.
 *
 * Mismatch types:
 *  - missing_on_chain : payment recorded in DB but not found on Stellar
 *  - amount_mismatch  : DB amount differs from on-chain amount
 *  - student_mismatch : DB studentId doesn't match the tx memo
 */
async function checkConsistency() {
  const [dbPayments, chainTxs] = await Promise.all([
    Payment.find({}).lean(),
    fetchChainTransactions(),
  ]);

  // Build a map of txHash → on-chain tx for O(1) lookup
  const chainMap = new Map();
  for (const tx of chainTxs) {
    const ops = await tx.operations();
    const payOp = ops.records.find(op => op.type === 'payment' && op.to === SCHOOL_WALLET);
    if (payOp) {
      chainMap.set(tx.hash, {
        hash: tx.hash,
        memo: tx.memo ? tx.memo.trim() : null,
        amount: parseFloat(parseFloat(payOp.amount).toFixed(7)),
      });
    }
  }

  const mismatches = [];

  for (const payment of dbPayments) {
    const onChain = chainMap.get(payment.txHash);

    if (!onChain) {
      mismatches.push({
        type: 'missing_on_chain',
        txHash: payment.txHash,
        studentId: payment.studentId,
        dbAmount: payment.amount,
        message: `Transaction ${payment.txHash} exists in DB but not found on-chain`,
      });
      continue;
    }

    if (Math.abs(onChain.amount - payment.amount) > 0.0000001) {
      mismatches.push({
        type: 'amount_mismatch',
        txHash: payment.txHash,
        studentId: payment.studentId,
        dbAmount: payment.amount,
        chainAmount: onChain.amount,
        message: `Amount mismatch for ${payment.txHash}: DB=${payment.amount}, chain=${onChain.amount}`,
      });
    }

    if (onChain.memo && onChain.memo !== payment.studentId) {
      mismatches.push({
        type: 'student_mismatch',
        txHash: payment.txHash,
        dbStudentId: payment.studentId,
        chainMemo: onChain.memo,
        message: `Student mismatch for ${payment.txHash}: DB studentId=${payment.studentId}, chain memo=${onChain.memo}`,
      });
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    totalDbPayments: dbPayments.length,
    totalChainTxsScanned: chainMap.size,
    mismatchCount: mismatches.length,
    mismatches,
  };
}

module.exports = { checkConsistency };
