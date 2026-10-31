'use strict';

const path = require('node:path');
const fs = require('node:fs');

/**
 * Load .env files without overwriting variables that are already set.
 * Lookup order: real process env, then <repo>/.env, then <server>/.env.
 * dotenv is optional at runtime so the module stays importable in tests.
 */
function loadEnvFiles(logger) {
  let dotenv;
  try {
    // eslint-disable-next-line global-require
    dotenv = require('dotenv');
  } catch (err) {
    if (logger) logger.warn('dotenv is not installed; relying on real environment variables');
    return;
  }
  const candidates = [
    path.resolve(__dirname, '../../.env'),
    path.resolve(__dirname, '../.env')
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    dotenv.config({ path: file, override: false });
  }
}

const DEFAULT_TITLES = [
  'Influencer Marketing',
  'Partnerships',
  'Creator Relations',
  'Social Media Manager'
];

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function toList(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function buildConfig(env = process.env) {
  return {
    port: toInt(env.PORT, 8787),
    trustProxy: toBool(env.TRUST_PROXY, true),

    apollo: {
      apiKey: String(env.APOLLO_API_KEY || '').trim(),
      baseUrl: stripTrailingSlash(env.APOLLO_BASE_URL || 'https://api.apollo.io/api/v1'),
      perPage: Math.min(Math.max(toInt(env.APOLLO_PER_PAGE, 10), 1), 100)
    },

    hunter: {
      apiKey: String(env.HUNTER_API_KEY || '').trim(),
      baseUrl: stripTrailingSlash(env.HUNTER_BASE_URL || 'https://api.hunter.io'),
      acceptStatuses: toList(env.HUNTER_ACCEPT_STATUSES, ['valid', 'deliverable']).map((s) =>
        s.toLowerCase()
      ),
      pollAttempts: Math.min(Math.max(toInt(env.HUNTER_POLL_ATTEMPTS, 3), 1), 10),
      pollDelayMs: Math.max(toInt(env.HUNTER_POLL_DELAY_MS, 1500), 250)
    },

    pipeline: {
      titles: toList(env.CONTACT_TITLES, DEFAULT_TITLES),
      maxCandidates: Math.min(Math.max(toInt(env.MAX_CANDIDATES, 6), 1), 25),
      maxEnrichedCandidates: Math.min(Math.max(toInt(env.MAX_ENRICHED_CANDIDATES, 2), 1), 10),
      maxEmailsToVerify: Math.min(Math.max(toInt(env.MAX_EMAILS_TO_VERIFY, 2), 1), 10),
      minTitleScore: toInt(env.MIN_TITLE_SCORE, 25),
      allowAcceptAll: toBool(env.ALLOW_ACCEPT_ALL, false),
      requireBrandDomain: toBool(env.REQUIRE_BRAND_DOMAIN, true),
      cacheTtlMs: Math.max(toInt(env.CACHE_TTL_SECONDS, 21600), 0) * 1000,
      negativeCacheTtlMs: Math.max(toInt(env.CACHE_NEGATIVE_TTL_SECONDS, 1800), 0) * 1000,
      maxConcurrentLookups: Math.min(Math.max(toInt(env.MAX_CONCURRENT_LOOKUPS, 3), 1), 16)
    },

    auth: {
      firebaseWebApiKey: String(env.FIREBASE_WEB_API_KEY || '').trim(),
      requireAuth: toBool(env.REQUIRE_AUTH, false)
    },

    cors: {
      allowedOrigins: toList(env.ALLOWED_ORIGINS, [])
    },

    http: {
      timeoutMs: Math.min(Math.max(toInt(env.HTTP_TIMEOUT_MS, 15000), 1000), 60000),
      retries: Math.min(Math.max(toInt(env.HTTP_RETRIES, 2), 0), 5)
    },

    logLevel: String(env.LOG_LEVEL || 'info')
  };
}

/**
 * Human friendly list of what is missing, used at boot and in /healthz.
 */
function configSummary(config) {
  return {
    apollo: Boolean(config.apollo.apiKey),
    hunter: Boolean(config.hunter.apiKey),
    auth: config.auth.requireAuth ? Boolean(config.auth.firebaseWebApiKey) : false
  };
}

module.exports = { buildConfig, configSummary, loadEnvFiles, DEFAULT_TITLES };
