'use strict';

const { AppError } = require('./errors');
const { requestJson } = require('./http');

const IDENTITY_TOOLKIT = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';

/**
 * Optional auth layer that understands the exact token the existing frontend
 * already sends: "Authorization: Bearer <firebase id token>".
 *
 * When REQUIRE_AUTH=false the endpoint stays open (useful while testing), but
 * an open endpoint spends your Apollo/Hunter credits, so enable this in prod.
 */
function createAuthMiddleware(options = {}) {
  const webApiKey = options.firebaseWebApiKey || '';
  const requireAuth = Boolean(options.requireAuth);
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const cache = options.cache;
  const timeoutMs = options.timeoutMs || 8000;

  async function verifyToken(token) {
    if (cache) {
      const known = cache.get(token);
      if (known) return known;
    }

    const url = `${IDENTITY_TOOLKIT}?key=${encodeURIComponent(webApiKey)}`;
    let data;
    try {
      const response = await requestJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ idToken: token }),
        timeoutMs,
        retries: 1,
        fetchImpl,
        logger,
        provider: 'Firebase'
      });
      data = response.data;
    } catch (err) {
      if (err && err.provider === 'Firebase' && (err.upstreamStatus === 400 || err.upstreamStatus === 401)) {
        throw new AppError('Your login expired or is invalid. Sign in again.', {
          status: 401,
          code: 'INVALID_TOKEN'
        });
      }
      throw err;
    }

    const user = data && Array.isArray(data.users) ? data.users[0] : null;
    if (!user || !user.localId) {
      throw new AppError('Your login expired or is invalid. Sign in again.', {
        status: 401,
        code: 'INVALID_TOKEN'
      });
    }

    const info = {
      uid: user.localId,
      email: user.email || null,
      emailVerified: Boolean(user.emailVerified)
    };
    if (cache) cache.set(token, info);
    return info;
  }

  return async function authMiddleware(req, res, next) {
    if (!requireAuth) {
      req.user = null;
      return next();
    }
    if (!webApiKey) {
      return next(
        new AppError('REQUIRE_AUTH is enabled but FIREBASE_WEB_API_KEY is not set.', {
          status: 503,
          code: 'AUTH_NOT_CONFIGURED'
        })
      );
    }

    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return next(new AppError('Please sign in again (missing login token).', {
        status: 401,
        code: 'UNAUTHENTICATED'
      }));
    }

    try {
      req.user = await verifyToken(match[1].trim());
      return next();
    } catch (err) {
      if (err instanceof AppError && err.status === 401) return next(err);
      return next(
        new AppError('Could not check your login right now. Try again in a moment.', {
          status: 503,
          code: 'AUTH_UNAVAILABLE',
          cause: err
        })
      );
    }
  };
}

module.exports = { createAuthMiddleware };
