const Student = require('../models/studentModel');
const FeeStructure = require('../models/feeStructureModel');
const { get, set, del, KEYS, TTL } = require('../cache');

// POST /api/students
async function registerStudent(req, res, next) {
  try {
    const { studentId, name, class: className, feeAmount } = req.body;

    let assignedFee = feeAmount;
    if (assignedFee == null && className) {
      const feeStructure = await FeeStructure.findOne({ className, isActive: true });
      if (feeStructure) assignedFee = feeStructure.feeAmount;
    }

    if (assignedFee == null) {
      const err = new Error(`No fee amount provided and no fee structure found for class "${className}". Please create a fee structure first or provide feeAmount.`);
      err.code = 'VALIDATION_ERROR';
      return next(err);
    }

    const student = await Student.create({ studentId, name, class: className, feeAmount: assignedFee });
    // Invalidate student list cache since a new student was added
    del(KEYS.studentsAll());
    res.status(201).json(student);
  } catch (err) {
    next(err);
  }
}

// GET /api/students
async function getAllStudents(req, res, next) {
  try {
    const cacheKey = KEYS.studentsAll();
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const students = await Student.find().sort({ createdAt: -1 });
    set(cacheKey, students, TTL.STUDENTS);
    res.json(students);
  } catch (err) {
    next(err);
  }
}

// GET /api/students/:studentId
async function getStudent(req, res, next) {
  try {
    const { studentId } = req.params;
    const cacheKey = KEYS.student(studentId);
    const cached = get(cacheKey);
    if (cached !== undefined) return res.json(cached);

    const student = await Student.findOne({ studentId });
    if (!student) {
      const err = new Error('Student not found');
      err.code = 'NOT_FOUND';
      return next(err);
    }
    set(cacheKey, student, TTL.STUDENT);
    res.json(student);
  } catch (err) {
    next(err);
  }
}

module.exports = { registerStudent, getAllStudents, getStudent };
