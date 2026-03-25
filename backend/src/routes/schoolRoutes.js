'use strict';

const express = require('express');
const router = express.Router();
const {
  createSchool,
  getAllSchools,
  getSchool,
  updateSchool,
  deactivateSchool,
} = require('../controllers/schoolController');

router.post('/',                createSchool);
router.get('/',                 getAllSchools);
router.get('/:schoolSlug',      getSchool);
router.patch('/:schoolSlug',    updateSchool);
router.delete('/:schoolSlug',   deactivateSchool);

module.exports = router;
