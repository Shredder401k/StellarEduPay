'use strict';

const StellarSdk = require('@stellar/stellar-sdk');
const config = require('./index');

const server = new StellarSdk.Horizon.Server(config.HORIZON_URL);

const networkPassphrase = config.IS_TESTNET
  ? StellarSdk.Networks.TESTNET
  : StellarSdk.Networks.PUBLIC;

const SCHOOL_WALLET = config.SCHOOL_WALLET_ADDRESS;

// Accepted assets — add new entries here to support additional tokens
const ACCEPTED_ASSETS = {
  XLM: {
    code: 'XLM',
    type: 'native',
    issuer: null,
    displayName: 'Stellar Lumens',
    decimals: 7,
  },
  USDC: {
    code: 'USDC',
    type: 'credit_alphanum4',
    issuer: config.USDC_ISSUER,
    displayName: 'USD Coin',
    decimals: 7,
  },
};

/**
 * Check whether an asset (by code and type) is accepted by the system.
 * @param {string} assetCode  e.g. 'XLM', 'USDC'
 * @param {string} assetType  Stellar asset type string ('native', 'credit_alphanum4', …)
 * @returns {{ accepted: boolean, asset: object|null }}
 */
function isAcceptedAsset(assetCode, assetType) {
  const asset = ACCEPTED_ASSETS[assetCode];
  if (!asset) return { accepted: false, asset: null };
  if (asset.type !== assetType) return { accepted: false, asset: null };
  return { accepted: true, asset };
}

/**
 * Resolve a Stellar SDK Asset from an accepted-asset code.
 * @param {string} assetCode
 * @returns {StellarSdk.Asset|null}
 */
function resolveAsset(assetCode) {
  const cfg = ACCEPTED_ASSETS[assetCode];
  if (!cfg) return null;
  if (cfg.type === 'native') return StellarSdk.Asset.native();
  return new StellarSdk.Asset(cfg.code, cfg.issuer);
}

const CONFIRMATION_THRESHOLD = config.CONFIRMATION_THRESHOLD;

module.exports = {
  server,
  networkPassphrase,
  SCHOOL_WALLET,
  StellarSdk,
  ACCEPTED_ASSETS,
  CONFIRMATION_THRESHOLD,
  isAcceptedAsset,
  resolveAsset,
};
