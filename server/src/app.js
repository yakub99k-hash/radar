'use strict';

const express = require('express');
const { AppError, MISSING_USER_KEY_MESSAGE } = require('./errors');

/** Browsers send the chosen provider and their own key in these headers. */
const PROVIDER_HEADER = 'x-provider';
const API_KEY_HEADER = 'x-api-key';
/** Older cached pages of index.html still send this one; it maps to Hunter. */
const LEGACY_HUNTER_KEY_HEADER = 'x-hunter-api-key';
const MAX_PAGE_TEXT_CHARS = 40000;
const MAX_API_KEY_CHARS = 200;
const PROVIDERS = ['hunter', 'prospeo'];
const DEFAULT_PROVIDER = 'hunter';

/** CORS that matches the static frontend (GitHub Pages + local dev). */
function corsMiddleware(allowedOrigins) {
  const allowed = Array.isArray(allowedOrigins) ? allowedOrigins : [];
  return function cors(req, res, next) {
    const origin = req.headers.origin;
    if (!allowed.length) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    // X-Provider + X-Api-Key let a visitor spend their own Hunter/Prospeo credits
    // from the browser. X-Hunter-Api-Key stays for pages cached before the switch.
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization,Content-Type,X-Provider,X-Api-Key,X-Hunter-Api-Key'
    );
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') return res.status(204).end();
    return next();
  };
}

function firstValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

/**
 * Express app factory. Dependencies are injected so the HTTP layer can be
 * tested without Apollo/Hunter or real credentials.
 */
function createApp(deps = {}) {
  const config = deps.config || {};
  const logger = deps.logger || { info() {}, warn() {}, error() {} };
  const pipeline = deps.pipeline;
  const authMiddleware = deps.authMiddleware || ((req, res, next) => next());
  const version = deps.version || '1.0.0';

  if (!pipeline || typeof pipeline.findContact !== 'function') {
    throw new Error('createApp needs a pipeline with findContact()');
  }

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', true);

  app.use(corsMiddleware(config.cors && config.cors.allowedOrigins));
  // Page text for the Gemini step can be a few tens of kB.
  app.use(express.json({ limit: '256kb' }));

  // Compact request log without tokens or query secrets.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - startedAt
      });
    });
    next();
  });

  const health = {
    ok: true,
    service: 'radar-contact-finder',
    version,
    // Hunter and Prospeo are always answered with the visitor's own key.
    providers: PROVIDERS,
    userKeysRequired: true,
    apollo: Boolean(config.pipeline && config.pipeline.useApollo && config.apollo && config.apollo.apiKey),
    gemini: Boolean(config.gemini && config.gemini.apiKey),
    auth: Boolean(config.auth && config.auth.requireAuth),
    uptime_s: Math.round(process.uptime())
  };

  app.get('/', (req, res) => {
    res.json({
      ...health,
      endpoints: {
        contact: 'GET /api/brand-contact?domain=brand.com&brand=Brand'
      }
    });
  });

  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(health);
  });

  /** Reads the provider the browser wants; anything unknown is a clear 400. */
  function providerFrom(req, source) {
    const raw = firstValue(req.get(PROVIDER_HEADER), source.provider, source.provider_name);
    const provider = raw.toLowerCase();
    if (!provider) return DEFAULT_PROVIDER;
    if (!PROVIDERS.includes(provider)) {
      throw new AppError(`Unknown provider "${raw}". Use "hunter" or "prospeo".`, {
        status: 400,
        code: 'INVALID_PROVIDER'
      });
    }
    return provider;
  }

  /**
   * The visitor's own key, from the headers only (a body field is accepted for
   * curl users). No server-side key exists, so a missing key is a hard error
   * instead of a silent charge to the site owner's account.
   */
  function apiKeyFrom(req, source) {
    const headerKey = firstValue(req.get(API_KEY_HEADER), req.get(LEGACY_HUNTER_KEY_HEADER));
    return firstValue(headerKey, source.apiKey, source.api_key, source.hunter_api_key).slice(
      0,
      MAX_API_KEY_CHARS
    );
  }

  async function contactHandler(req, res, next) {
    try {
      const source = req.method === 'POST' ? req.body || {} : req.query || {};
      const domain = firstValue(source.domain, source.website, source.url, source.site);
      const brand = firstValue(source.brand, source.brand_name, source.brandName, source.company);

      if (!domain) {
        throw new AppError('A "domain" query parameter is required, e.g. ?domain=brand.com', {
          status: 400,
          code: 'MISSING_DOMAIN'
        });
      }

      const provider = providerFrom(req, source);
      const apiKey = apiKeyFrom(req, source);
      if (!apiKey) {
        throw new AppError(MISSING_USER_KEY_MESSAGE, {
          status: 400,
          code: 'API_KEY_MISSING'
        });
      }

      // Page text the browser already scraped, so Gemini can look for hidden emails.
      const pageText = String(
        firstValue(source.pageText, source.page_text, source.website_text, source.text)
      ).slice(0, MAX_PAGE_TEXT_CHARS);

      const params = { domain, brand, provider, apiKey };
      if (pageText) params.pageText = pageText;

      const result = await pipeline.findContact(params);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      next(err);
    }
  }

  app.get('/api/brand-contact', authMiddleware, contactHandler);
  app.post('/api/brand-contact', authMiddleware, contactHandler);

  app.use((req, res, next) => {
    next(new AppError('Not found.', { status: 404, code: 'NOT_FOUND' }));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err && err.status >= 400 && err.status < 600 ? err.status : 500;
    const payload = {
      error: (err && err.message) || 'Something went wrong.',
      code: (err && err.code) || 'INTERNAL_ERROR'
    };
    if (err && err.details) payload.details = err.details;

    if (status >= 500) {
      logger.error('request failed', {
        path: req.path,
        status,
        code: payload.code,
        error: payload.error
      });
    } else {
      logger.warn('request rejected', { path: req.path, status, code: payload.code });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(status).json(payload);
  });

  return app;
}

module.exports = { createApp, corsMiddleware };
