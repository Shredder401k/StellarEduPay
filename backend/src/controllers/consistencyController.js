const { checkConsistency } = require('../services/consistencyService');

async function runConsistencyCheck(req, res, next) {
  try {
    const report = await checkConsistency();
    const status = report.mismatchCount > 0 ? 207 : 200;
    res.status(status).json(report);
  } catch (err) {
    next(err);
  }
}

module.exports = { runConsistencyCheck };
