const Student = require('../models/studentModel');

/**
 * Generate a unique student ID of the form STU-XXXXXX (6 random uppercase alphanumeric chars).
 * Retries up to `maxAttempts` times to avoid collisions.
 */
async function generateStudentId(maxAttempts = 5) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (let i = 0; i < maxAttempts; i++) {
    const suffix = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    const id = `STU-${suffix}`;
    const exists = await Student.exists({ studentId: id });
    if (!exists) return id;
  }
  throw Object.assign(new Error('Failed to generate a unique student ID'), { code: 'INTERNAL_ERROR' });
}

module.exports = { generateStudentId };
