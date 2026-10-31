'use strict';

const { buildConfig, configSummary, loadEnvFiles } = require('./config');
const { createLogger } = require('./logger');
const { createApolloClient } = require('./apollo');
const { createHunterClient } = require('./hunter');
const { createContactFinder } = require('./contactFinder');
const { createTtlCache } = require('./cache');
const { createSemaphore } = require('./semaphore');
const { createAuthMiddleware } = require('./auth');
const { createApp } = require('./app');

function buildServices(config, logger, options = {}) {
  const fetchImpl = options.fetchImpl;

  const apollo = createApolloClient({
    ...config.apollo,
    logger,
    timeoutMs: config.http.timeoutMs,
    retries: config.http.retries,
    fetchImpl
  });

  const hunter = createHunterClient({
    ...config.hunter,
    logger,
    timeoutMs: config.http.timeoutMs,
    retries: config.http.retries,
    fetchImpl
  });

  const finder = createContactFinder({
    apollo,
    hunter,
    logger,
    cache: createTtlCache({ ttlMs: config.pipeline.cacheTtlMs, maxEntries: 500 }),
    options: {
      titles: config.pipeline.titles,
      perPage: config.apollo.perPage,
      maxCandidates: config.pipeline.maxCandidates,
      maxEnrichedCandidates: config.pipeline.maxEnrichedCandidates,
      maxEmailsToVerify: config.pipeline.maxEmailsToVerify,
      minTitleScore: config.pipeline.minTitleScore,
      allowAcceptAll: config.pipeline.allowAcceptAll,
      requireBrandDomain: config.pipeline.requireBrandDomain,
      negativeCacheTtlMs: config.pipeline.negativeCacheTtlMs,
      acceptStatuses: config.hunter.acceptStatuses,
      domainSearchLimit: config.hunter.domainSearchLimit
    }
  });

  // Cap parallel brand lookups so a burst cannot burn the whole credit balance.
  const semaphore = createSemaphore(config.pipeline.maxConcurrentLookups);
  const pipeline = {
    findContact: (params) => semaphore.run(() => finder.findContact(params))
  };

  const authMiddleware = createAuthMiddleware({
    firebaseWebApiKey: config.auth.firebaseWebApiKey,
    requireAuth: config.auth.requireAuth,
    logger,
    timeoutMs: config.http.timeoutMs,
    fetchImpl,
    cache: createTtlCache({ ttlMs: 120000, maxEntries: 1000 })
  });

  return { apollo, hunter, finder, pipeline, authMiddleware };
}

function main() {
  const logger = createLogger({ level: process.env.LOG_LEVEL });
  loadEnvFiles(logger);

  const config = buildConfig();
  const summary = configSummary(config);

  if (!summary.apollo) {
    logger.warn('APOLLO_API_KEY is missing: using the Hunter domain search pipeline instead.');
  }
  if (!summary.hunter) {
    logger.warn('HUNTER_API_KEY is missing: /api/brand-contact will answer 503 until it is set.');
  }
  if (config.auth.requireAuth && !summary.auth) {
    logger.warn('REQUIRE_AUTH is on but FIREBASE_WEB_API_KEY is missing: every request will be rejected.');
  }
  if (!config.cors.allowedOrigins.length) {
    logger.warn('ALLOWED_ORIGINS is empty: the API accepts browser calls from any origin.');
  }

  const services = buildServices(config, logger);
  const app = createApp({ config, logger, pipeline: services.pipeline, authMiddleware: services.authMiddleware });

  const server = app.listen(config.port, () => {
    logger.info('radar contact finder listening', {
      port: config.port,
      apollo: summary.apollo,
      hunter: summary.hunter,
      auth: summary.auth
    });
  });

  function shutdown(signal) {
    logger.info('shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

if (require.main === module) main();

module.exports = { main, buildServices };
