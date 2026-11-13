'use strict';

const express = require('express');

const PORT = Number(process.env.PORT) || 8787;
const YOUTUBE_BASE = 'https://www.googleapis.com/youtube/v3';
const MAX_SEARCH_RESULTS = 50;
const MAX_CHANNEL_IDS_PER_CALL = 50;

const app = express();
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});
app.disable('x-powered-by');

// Handle CORS preflight OPTIONS requests immediately, before any other
// middleware or route handler, so preflight requests are always answered
// successfully and never reach route handlers that only accept POST.
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json({ limit: '256kb' }));

// CORS so the frontend can call the API from the same origin or another host.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// Compact request log.
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    console.log(req.method + ' ' + req.path + ' ' + res.statusCode + ' ' + (Date.now() - startedAt) + 'ms');
  });
  next();
});

function sendJson(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  res.status(status).json(payload);
}

function formatNumber(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function fetchYouTubeJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // ignore parse errors for non-2xx; handled below
  }
  if (!response.ok) {
    const err = new Error(
      (data && data.error && data.error.message) || 'YouTube API returned HTTP ' + response.status
    );
    err.status = response.status;
    err.code = data && data.error && data.error.code ? data.error.code : null;
    err.reason =
      data && data.error && Array.isArray(data.error.errors) && data.error.errors.length
        ? data.error.errors[0].reason
        : null;
    throw err;
  }
  return data;
}

function readableError(err) {
  const status = Number(err.status || 0);
  const reason = String(err.reason || '');
  const message = String(err.message || '');

  if (status === 403 || reason === 'quotaExceeded' || /quota/i.test(message)) {
    return {
      status: 403,
      code: 'QUOTA_EXCEEDED',
      message:
        'YouTube API quota exceeded. Check your key\u2019s remaining quota in the Google Cloud Console, or try again later.'
    };
  }
  if (status === 400 || reason === 'keyInvalid' || reason === 'keyExpired' || /invalid api key/i.test(message)) {
    return {
      status: 400,
      code: 'INVALID_API_KEY',
      message: 'The YouTube Data API key is invalid. Please check it and try again.'
    };
  }
  if (status === 403) {
    return {
      status: 403,
      code: 'API_KEY_FORBIDDEN',
      message: 'The YouTube Data API key is not authorized for this request.'
    };
  }
  return {
    status: 502,
    code: 'YOUTUBE_API_ERROR',
    message: 'The YouTube API request failed. Please try again.'
  };
}

/**
 * OPTIONS /api/find-creators
 * Handles CORS preflight requests for the find-creators endpoint.
 */
app.options('/api/find-creators', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
  return res.status(204).end();
});

/**
 * POST /api/find-creators
 * Body: { keyword, minSubs, maxSubs }
 * Header: x-api-key (the visitor's own YouTube Data API key)
 */
app.post('/api/find-creators', async (req, res, next) => {
  try {
    const apiKey = String(req.get('x-api-key') || '').trim();
    if (!apiKey) {
      return sendJson(res, 400, {
        error: 'YouTube Data API key is required. Paste it in the API Key field and try again.',
        code: 'API_KEY_MISSING'
      });
    }

    const { keyword, minSubs, maxSubs } = req.body || {};
    const q = String(keyword || '').trim();
    if (!q) {
      return sendJson(res, 400, {
        error: 'A keyword is required, e.g. "ebike review".',
        code: 'MISSING_KEYWORD'
      });
    }

    const min = Number.parseInt(String(minSubs === undefined ? '' : minSubs), 10);
    const max = Number.parseInt(String(maxSubs === undefined ? '' : maxSubs), 10);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return sendJson(res, 400, {
        error: 'Enter both a minimum and a maximum subscriber count.',
        code: 'MISSING_RANGE'
      });
    }
    if (min < 0 || max < 0) {
      return sendJson(res, 400, {
        error: 'Subscriber counts must be zero or greater.',
        code: 'INVALID_RANGE'
      });
    }
    if (min > max) {
      return sendJson(res, 400, {
        error: 'Minimum subscribers cannot be greater than the maximum.',
        code: 'INVALID_RANGE'
      });
    }

    // a) search.list: top 50 recent videos matching the keyword.
    const searchUrl =
      YOUTUBE_BASE +
      '/search?part=snippet&type=video&order=date&maxResults=' +
      MAX_SEARCH_RESULTS +
      '&q=' +
      encodeURIComponent(q) +
      '&key=' +
      encodeURIComponent(apiKey);
    const searchData = await fetchYouTubeJson(searchUrl);

    const items = Array.isArray(searchData.items) ? searchData.items : [];
    // b) unique channelIds from the video results.
    const channelIds = [
      ...new Set(
        items.map((item) => (item && item.snippet ? item.snippet.channelId : null)).filter(Boolean)
      )
    ];

    if (channelIds.length === 0) {
      return sendJson(res, 200, {
        creators: [],
        searched: 0,
        keyword: q,
        min: min,
        max: max
      });
    }

    // c) channels.list: statistics for the channel IDs (chunked to 50 per call).
    const channelsById = new Map();
    for (let i = 0; i < channelIds.length; i += MAX_CHANNEL_IDS_PER_CALL) {
      const chunk = channelIds.slice(i, i + MAX_CHANNEL_IDS_PER_CALL);
      const channelUrl =
        YOUTUBE_BASE +
        '/channels?part=statistics,snippet&id=' +
        chunk.join(',') +
        '&key=' +
        encodeURIComponent(apiKey);
      const channelData = await fetchYouTubeJson(channelUrl);
      for (const ch of Array.isArray(channelData.items) ? channelData.items : []) {
        if (ch && ch.id) channelsById.set(ch.id, ch);
      }
    }

    // d) keep only channels within the subscriber range.
    const creators = [];
    for (const [channelId, ch] of channelsById) {
      const stats = ch && ch.statistics ? ch.statistics : {};
      const subscriberCount = Number.parseInt(String(stats.subscriberCount || 0), 10);
      const hasPublicSubs = Object.prototype.hasOwnProperty.call(stats, 'subscriberCount');
      if (!hasPublicSubs) continue; // subscriber count hidden by the channel
      if (subscriberCount >= min && subscriberCount <= max) {
        creators.push({
          channelId: channelId,
          channelName: ch.snippet && ch.snippet.title ? ch.snippet.title : 'Unknown Channel',
          subscriberCount: subscriberCount,
          subscriberCountFormatted: formatNumber(subscriberCount),
          url: 'https://www.youtube.com/channel/' + channelId
        });
      }
    }

    creators.sort((a, b) => b.subscriberCount - a.subscriberCount);

    // e) clean JSON list of filtered creators.
    return sendJson(res, 200, {
      creators: creators,
      total: creators.length,
      searched: channelIds.length,
      keyword: q,
      min: min,
      max: max
    });
  } catch (err) {
    const handled = readableError(err);
    if (handled.status >= 500) {
      console.error('youtube api error', { path: req.path, status: handled.status, error: err.message });
    }
    return sendJson(res, handled.status, { error: handled.message, code: handled.code });
  }
});

app.use((req, res) => {
  sendJson(res, 404, { error: 'Not found.', code: 'NOT_FOUND' });
});

app.use((err, req, res, next) => {
  const status =
    err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  const message = err && err.message ? err.message : 'Something went wrong.';
  if (status >= 500) console.error('server error', { path: req.path, status: status, error: message });
  sendJson(res, status, { error: message, code: err && err.code ? err.code : 'INTERNAL_ERROR' });
});

const server = app.listen(PORT, () => {
  console.log('creator finder listening', { port: PORT });
});

function shutdown(signal) {
  console.log('shutting down', { signal: signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  // The server is already listening above.
}

module.exports = { app };
