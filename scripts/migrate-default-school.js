#!/usr/bin/env node
'use strict';

/**
 * Migration: migrate-default-school
 *
 * Run this ONCE on an existing single-school deployment before deploying
 * the multi-school feature branch.
 *
 * What it does:
 *   1. Reads SCHOOL_WALLET_ADDRESS from the environment
 *   2. Creates one "Default School" document in the schools collection
 *   3. Back-fills schoolId = "SCH-DEFAULT" on all existing Students,
 *      Payments, FeeStructures, PaymentIntents, and PendingVerifications
 *
 * Safe to re-run — uses upsert / updateMany with $set so it is idempotent.
 *
 * Usage:
 *   MONGO_URI=mongodb://... SCHOOL_WALLET_ADDRESS=G... node scripts/migrate-default-school.js
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGO_URI             = process.env.MONGO_URI;
const SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS;
const STELLAR_NETWORK       = process.env.STELLAR_NETWORK || 'testnet';

if (!MONGO_URI) {
  console.error('ERROR: MONGO_URI is required');
  process.exit(1);
}
if (!SCHOOL_WALLET_ADDRESS) {
  console.error('ERROR: SCHOOL_WALLET_ADDRESS is required for migration');
  process.exit(1);
}

// Inline schema imports (avoid app bootstrap side-effects)
const School              = require('../backend/src/models/schoolModel');
const Student             = require('../backend/src/models/studentModel');
const Payment             = require('../backend/src/models/paymentModel');
const FeeStructure        = require('../backend/src/models/feeStructureModel');
const PaymentIntent       = require('../backend/src/models/paymentIntentModel');
const PendingVerification = require('../backend/src/models/pendingVerificationModel');

const DEFAULT_SCHOOL_ID = 'SCH-DEFAULT';

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Connected to MongoDB');

  // 1. Create or update the default school
  const school = await School.findOneAndUpdate(
    { schoolId: DEFAULT_SCHOOL_ID },
    {
      schoolId:       DEFAULT_SCHOOL_ID,
      name:           'Default School',
      slug:           'default',
      stellarAddress: SCHOOL_WALLET_ADDRESS,
      network:        STELLAR_NETWORK,
      isActive:       true,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  console.log(`School record: ${school.name} (${school.schoolId})`);

  // 2. Back-fill schoolId on all existing documents that lack one
  const collections = [
    { model: Student,             name: 'students' },
    { model: Payment,             name: 'payments' },
    { model: FeeStructure,        name: 'feeStructures' },
    { model: PaymentIntent,       name: 'paymentIntents' },
    { model: PendingVerification, name: 'pendingVerifications' },
  ];

  for (const { model, name } of collections) {
    const result = await model.updateMany(
      { schoolId: { $exists: false } },
      { $set: { schoolId: DEFAULT_SCHOOL_ID } }
    );
    console.log(`  ${name}: ${result.modifiedCount} document(s) updated`);
  }

  console.log('\nMigration complete. You can now deploy the multi-school feature branch.');
  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
