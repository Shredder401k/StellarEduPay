/**
 * Unified configuration loader.
 *
 * All environment variables are read, validated, and exported from here.
 * Nothing else in the codebase should read process.env directly.
 *
 * The app will throw immediately on startup if any required variable is missing,
 * rather than failing silently at runtime.
 */

'use strict';

// ── Required variables ────────────────────────────────────────────────────────
const REQUIRED = [
  'MONGO_URI',
  'SCHOOL_WALLET_ADDRESS',
];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length) {
  throw new Error(
    `[Config] Missing required environment variables: ${missing.join(', ')}\n` +
    'Check your .env file against .env.example.'
  );
}

// ── Server ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);

// ── Database ──────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;

// ── Stellar network ───────────────────────────────────────────────────────────
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';
const IS_TESTNET = STELLAR_NETWORK !== 'mainnet';

const HORIZON_URL =
  process.env.HORIZON_URL ||
  (IS_TESTNET
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org');

const SCHOOL_WALLET_ADDRESS = process.env.SCHOOL_WALLET_ADDRESS;

const USDC_ISSUER =
  process.env.USDC_ISSUER ||
  (IS_TESTNET
    ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    : 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN');

const CONFIRMATION_THRESHOLD = parseInt(process.env.CONFIRMATION_THRESHOLD || '2', 10);

// ── Polling ───────────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);

// ── Payment Limits ────────────────────────────────────────────────────────────
// Minimum payment amount (default: 0.01 XLM/USDC)
const MIN_PAYMENT_AMOUNT = parseFloat(process.env.MIN_PAYMENT_AMOUNT || '0.01');

// Maximum payment amount (default: 100000 XLM/USDC)
const MAX_PAYMENT_AMOUNT = parseFloat(process.env.MAX_PAYMENT_AMOUNT || '100000');

// Validate payment limits
if (MIN_PAYMENT_AMOUNT < 0) {
  throw new Error('[Config] MIN_PAYMENT_AMOUNT must be a positive number');
}

if (MAX_PAYMENT_AMOUNT <= MIN_PAYMENT_AMOUNT) {
  throw new Error('[Config] MAX_PAYMENT_AMOUNT must be greater than MIN_PAYMENT_AMOUNT');
}

// ── Freeze to prevent accidental mutation at runtime ─────────────────────────
const config = Object.freeze({
  PORT,
  MONGO_URI,
  STELLAR_NETWORK,
  IS_TESTNET,
  HORIZON_URL,
  SCHOOL_WALLET_ADDRESS,
  USDC_ISSUER,
  CONFIRMATION_THRESHOLD,
  POLL_INTERVAL_MS,
  MIN_PAYMENT_AMOUNT,
  MAX_PAYMENT_AMOUNT,
});

module.exports = config;
