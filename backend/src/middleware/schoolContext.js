'use strict';

const School = require('../models/schoolModel');

/**
 * resolveSchool — middleware that identifies the current school from the request.
 *
 * Lookup strategy (in order of precedence):
 *   1. X-School-ID header   — opaque schoolId string (e.g. "SCH-3F2A")
 *   2. X-School-Slug header — human slug (e.g. "lincoln-high")
 *
 * On success: attaches req.school (lean School doc) and req.schoolId (string).
 * On failure: 400 if no header provided, 404 if school not found or inactive.
 *
 * Usage:
 *   router.use(resolveSchool);           // apply to all routes in a router
 *   router.get('/students', resolveSchool, handler);  // apply to one route
 */
async function resolveSchool(req, res, next) {
  try {
    const schoolId   = req.headers['x-school-id'];
    const schoolSlug = req.headers['x-school-slug'];

    if (!schoolId && !schoolSlug) {
      return res.status(400).json({
        error: 'School context is required. Provide X-School-ID or X-School-Slug header.',
        code: 'MISSING_SCHOOL_CONTEXT',
      });
    }

    const query = schoolId
      ? { schoolId, isActive: true }
      : { slug: schoolSlug.toLowerCase().trim(), isActive: true };

    const school = await School.findOne(query).lean();

    if (!school) {
      return res.status(404).json({
        error: 'School not found or inactive.',
        code: 'SCHOOL_NOT_FOUND',
      });
    }

    req.school   = school;
    req.schoolId = school.schoolId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { resolveSchool };
