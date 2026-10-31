'use strict';

/**
 * Harvests readable text from the brand's own pages. Used for the Gemini step:
 * the frontend normally forwards the text the scraper already downloaded, and
 * this is the fallback when it does not (or when it is too short to be useful).
 */

const DEFAULT_PATHS = ['/', '/contact', '/contact-us', '/about', '/about-us'];
const MAX_HTML_BYTES = 200000;

/** Very small HTML -> text conversion; enough for an LLM prompt. */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|section|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#64;|&#x40;|&commat;/gi, '@')
    .replace(/&#46;|&period;/gi, '.')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/**
 * @returns {Promise<{text: string, pages: string[]}>} whatever answered in time
 */
async function fetchSiteText(options = {}) {
  const domain = String(options.domain || '').trim();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger;
  const timeoutMs = options.timeoutMs || 6000;
  const maxChars = options.maxChars || 20000;
  const paths = Array.isArray(options.paths) && options.paths.length ? options.paths : DEFAULT_PATHS;

  if (!domain || typeof fetchImpl !== 'function') return { text: '', pages: [] };

  const deadline = Date.now() + timeoutMs;
  const chunks = [];
  const pages = [];
  let length = 0;

  for (const pathname of paths) {
    const remaining = deadline - Date.now();
    if (remaining < 300 || length >= maxChars) break;

    const url = `https://${domain}${pathname}`;
    try {
      const signal =
        typeof AbortSignal !== 'undefined' && AbortSignal.timeout
          ? AbortSignal.timeout(remaining)
          : undefined;
      const response = await fetchImpl(url, { signal, redirect: 'follow', headers: { Accept: 'text/html' } });
      if (!response || !response.ok) continue;
      const html = String(await response.text()).slice(0, MAX_HTML_BYTES);
      const text = htmlToText(html);
      if (text.length < 20) continue;
      pages.push(url);
      chunks.push(text);
      length += text.length;
    } catch (err) {
      if (logger && logger.debug) logger.debug('site text fetch failed', { url, error: err.message });
    }
  }

  return { text: chunks.join('\n').slice(0, maxChars), pages };
}

module.exports = { fetchSiteText, htmlToText, DEFAULT_PATHS };
