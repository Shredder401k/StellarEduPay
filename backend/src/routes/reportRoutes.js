'use strict';

const express = require('express');
const router = express.Router();
const { getReport } = require('../controllers/reportController');
const { resolveSchool } = require('../middleware/schoolContext');

// Reports are school-scoped
router.use(resolveSchool);

// GET /api/reports?startDate=2026-01-01&endDate=2026-12-31&format=csv
router.get('/', getReport);

module.exports = router;
