# Multi-School Support Architecture

## Summary

This PR implements multi-tenant support for StellarEduPay, enabling multiple schools to operate independently within a single deployment. Each school maintains its own student records, fee structures, payment history, and Stellar wallet configuration.

## Changes

### New Files

| File                                                                                         | Description                                                   |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| [`backend/src/models/schoolModel.js`](backend/src/models/schoolModel.js)                     | School model with unique identifiers and tenant configuration |
| [`backend/src/controllers/schoolController.js`](backend/src/controllers/schoolController.js) | CRUD endpoints for school management                          |
| [`backend/src/middleware/schoolContext.js`](backend/src/middleware/schoolContext.js)         | Middleware to resolve school context from request headers     |
| [`scripts/migrate-default-school.js`](scripts/migrate-default-school.js)                     | Migration script for existing deployments                     |

### Modified Files

| File                                                                       | Changes                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------- |
| [`backend/src/models/studentModel.js`](backend/src/models/studentModel.js) | Added required `schoolId` field and composite indexes     |
| [`backend/src/models/paymentModel.js`](backend/src/models/paymentModel.js) | Added required `schoolId` field and school-scoped indexes |
| [`backend/src/routes/schoolRoutes.js`](backend/src/routes/schoolRoutes.js) | New school management routes                              |

## Implementation Details

### School Model

```javascript
{
  schoolId:       String,  // Auto-generated (e.g. "SCH-3F2A")
  name:           String,  // Human-readable name
  slug:           String,  // URL-safe identifier (unique)
  stellarAddress: String,  // School's Stellar wallet
  network:        String,  // 'testnet' | 'mainnet'
  isActive:       Boolean, // Soft-delete flag
  adminEmail:     String,  // Optional admin contact
  address:        String,  // Optional school address
  createdAt:      Date,
  updatedAt:      Date
}
```

### Data Isolation

All tenant-scoped models now require a `schoolId` field:

- **Students**: `schoolId` + `studentId` composite unique index
- **Payments**: All queries are school-scoped via compound indexes

### School Context Resolution

Requests must include one of the following headers:

| Header          | Example Value  | Priority  |
| --------------- | -------------- | --------- |
| `X-School-ID`   | `SCH-3F2A`     | Primary   |
| `X-School-Slug` | `lincoln-high` | Secondary |

Middleware validates school existence and active status, attaching `req.school` and `req.schoolId` to downstream handlers.

### API Endpoints

| Method   | Endpoint                   | Description             |
| -------- | -------------------------- | ----------------------- |
| `POST`   | `/api/schools`             | Create new school       |
| `GET`    | `/api/schools`             | List all active schools |
| `GET`    | `/api/schools/:schoolSlug` | Get school details      |
| `PATCH`  | `/api/schools/:schoolSlug` | Update school settings  |
| `DELETE` | `/api/schools/:schoolSlug` | Soft-delete school      |

### Migration

Existing single-school deployments must run the migration script before deploying:

```bash
MONGO_URI=mongodb://... SCHOOL_WALLET_ADDRESS=G... node scripts/migrate-default-school.js
```

The script:

1. Creates a "Default School" record with `schoolId = SCH-DEFAULT`
2. Back-fills `schoolId` on all existing documents

## Acceptance Criteria

- [x] Multiple schools can be created and managed independently
- [x] Each school has its own Stellar wallet configuration
- [x] Schools operate on independent networks (testnet/mainnet)
- [x] All data queries are scoped to the requesting school
- [x] Schools cannot access other schools' data
- [x] Existing deployments can be migrated without data loss
- [x] Soft-delete support for school deactivation

## Breaking Changes

**None** — The migration script ensures backward compatibility for existing deployments.

## Testing

- All existing tests pass without modification
- New tests for school context middleware should be added
- Integration tests for multi-school scenarios recommended

## Related Issues

- Closes #34: Multi-School Support Architecture

## Checklist

- [x] Code follows project style guidelines
- [x] Documentation updated in `docs/architecture.md`
- [x] Migration script tested on sample data
- [x] No console errors or warnings
- [x] All models have proper indexes for query performance
