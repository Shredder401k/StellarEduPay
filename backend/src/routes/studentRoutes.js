'use strict';

const express = require('express');
const router = express.Router();
const { registerStudent, getAllStudents, getStudent } = require('../controllers/studentController');
const { validateRegisterStudent, validateStudentIdParam } = require('../middleware/validate');
const { resolveSchool } = require('../middleware/schoolContext');

// All student routes require school context
router.use(resolveSchool);

router.post('/',             validateRegisterStudent, registerStudent);
router.get('/',              getAllStudents);
router.get('/:studentId',    validateStudentIdParam, getStudent);

module.exports = router;
