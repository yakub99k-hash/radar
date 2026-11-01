'use strict';

const { AppError } = require('./errors');

/**
 * Google Gemini helpers.
 *
 * Two jobs, both strictly optional: if Gemini is not configured, times out or
 * answers with nonsense, the caller falls back to Hunter exactly as before.
 *  - findEmails(): read the brand's page text and pull out printed addresses the
 *    scraper's regex missed ("name [at] brand.com", JSON-LD, footers...).
 *  - pickBestContact(): choose the best influencer/partnership person from a
 *    list of Hunter candidates.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
const MAX_TEXT_CHARS = 40000;
const MAX_CANDIDATES = 10;

/** Every distinct address inside a blob of text. */
function extractEmails(text) {
  const found = new Set();
  String(text || '').replace(EMAIL_RE, (match) => {
    found.add(match.toLowerCase());
    return match;
  });
  return Array.from(found);
}

/** Reads Gemini's answer for the "which emails are on this page" prompt. */
function parseEmailList(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start > -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      const list = Array.isArray(parsed) ? parsed : parsed && parsed.emails;
      if (Array.isArray(list) && list.length) {
        const cleaned = list
          .map((item) => (typeof item === 'string' ? item : item && item.email))
          .filter(Boolean);
        if (cleaned.length) return cleaned;
      }
    } catch (err) {
      // Not JSON - fall back to scanning the raw answer below.
    }
  }
  return extractEmails(text);
}

/** Reads Gemini's answer for the "who should I contact" prompt. */
function parsePick(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start > -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        return {
          email: typeof parsed.email === 'string' ? parsed.email.trim().toLowerCase() : null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : null
        };
      }
    } catch (err) {
      // Not JSON - fall back to the first address mentioned.
    }
  }
  const emails = extractEmails(text);
  return { email: emails.length ? emails[0] : null, reason: null };
}

/**
 * Reads Gemini's answer for the "which of these people should I contact" prompt.
 * Providers such as Prospeo return people without an email yet, so the answer is
 * a 1-based position in the list instead of an address.
 *
 * @returns {{index: number|null, reason: string|null}} index is 0-based
 */
function parsePersonPick(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start > -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') {
        const position = Number(parsed.index ?? parsed.position ?? parsed.pick);
        return {
          index: Number.isInteger(position) && position > 0 ? position - 1 : null,
          reason: typeof parsed.reason === 'string' ? parsed.reason : null
        };
      }
    } catch (err) {
      // Not JSON - fall back to the first number in the answer below.
    }
  }
  const number = text.match(/\d+/);
  return {
    index: number ? Number.parseInt(number[0], 10) - 1 : null,
    reason: null
  };
}

function createGeminiClient(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  const model = String(options.model || 'gemini-2.5-flash').trim();
  const logger = options.logger;
  const timeoutMs = options.timeoutMs || 15000;
  // Tests inject a fake SDK factory; production uses the real @google/genai.
  const sdkFactory = options.sdkFactory;
  let client = null;

  function getClient() {
    if (client) return client;
    if (typeof sdkFactory === 'function') {
      client = sdkFactory({ apiKey });
      return client;
    }
    // eslint-disable-next-line global-require
    const { GoogleGenAI } = require('@google/genai');
    client = new GoogleGenAI({ apiKey });
    return client;
  }

  function withTimeout(promise) {
    let timer;
    const guard = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new AppError('Gemini did not answer in time.', { status: 504, code: 'GEMINI_TIMEOUT' }));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  async function ask(prompt) {
    if (!apiKey) {
      throw new AppError('Gemini API key is not configured (set GEMINI_API_KEY in .env).', {
        status: 503,
        code: 'GEMINI_KEY_MISSING'
      });
    }
    const ai = getClient();
    const response = await withTimeout(
      ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0, maxOutputTokens: 512, responseMimeType: 'application/json' }
      })
    );
    const answer = String((response && response.text) || '').trim();
    if (logger && logger.debug) logger.debug('gemini answered', { chars: answer.length });
    return answer;
  }

  /**
   * @returns {Promise<{emails: string[], raw: string}>}
   */
  async function findEmails(params = {}) {
    const body = String(params.text || '').slice(0, MAX_TEXT_CHARS).trim();
    if (body.length < 40) return { emails: [], raw: '' };

    const brand = params.brand || params.domain || 'this brand';
    const prompt = [
      `You are reading text taken from the website of ${brand} (${params.domain || 'unknown domain'}).`,
      'Find every email address that appears in the text, including ones written obfuscated',
      '(for example "press [at] brand [dot] com" or "hello at brand.com").',
      'Do not invent addresses and do not complete partially hidden ones.',
      'Answer as JSON only: {"emails": ["first@example.com"]}, or {"emails": []} when there are none.',
      'TEXT:',
      '"""',
      body,
      '"""'
    ].join('\n');

    const raw = await ask(prompt);
    return { emails: parseEmailList(raw), raw };
  }

  /**
   * @param {{brand?: string, domain?: string, candidates: Array<{email: string,
   *          contact_name?: string, title?: string}>}} params
   * @returns {Promise<{email: string, reason: string|null}|null>} null = no opinion
   */
  async function pickBestContact(params = {}) {
    const list = (Array.isArray(params.candidates) ? params.candidates : [])
      .filter((candidate) => candidate && candidate.email)
      .slice(0, MAX_CANDIDATES);
    if (list.length < 2) return null;

    const prompt = [
      `You are choosing the best sponsorship contact at ${params.brand || params.domain}.`,
      'Which of these people is most likely in charge of Influencer Marketing, Brand Partnerships, or is the Founder?',
      'Pick exactly one person from the list.',
      ...list.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.contact_name || 'Unknown name'} | ${candidate.title || 'unknown title'} | ${candidate.email}`
      ),
      'Answer as JSON only: {"email": "<one email from the list>", "reason": "<short reason>"}.',
      'If none of them fits, answer {"email": null}.'
    ].join('\n');

    const raw = await ask(prompt);
    const pick = parsePick(raw);
    if (!pick.email) return null;
    // Never trust a hallucinated address: it must be one of the candidates.
    const match = list.find((candidate) => candidate.email.toLowerCase() === pick.email);
    if (!match) return null;
    return { email: match.email, reason: pick.reason, raw };
  }

  /**
   * Chooses the best person to email when the provider has not revealed any
   * address yet (Prospeo search results). Gemini only orders the list, so a
   * nonsense answer can never drop a candidate.
   *
   * @param {{brand?: string, domain?: string,
   *          candidates: Array<{contact_name?: string, title?: string}>}} params
   * @returns {Promise<{index: number, reason: string|null}|null>} null = no opinion
   */
  async function pickBestPerson(params = {}) {
    const list = (Array.isArray(params.candidates) ? params.candidates : [])
      .filter(Boolean)
      .slice(0, MAX_CANDIDATES);
    if (list.length < 2) return null;

    const prompt = [
      `You are choosing the best sponsorship contact at ${params.brand || params.domain}.`,
      'Which of these people is most likely in charge of Influencer Marketing, Brand Partnerships, or is the Founder?',
      'Pick exactly one person from the list.',
      ...list.map(
        (candidate, index) =>
          `${index + 1}. ${candidate.contact_name || 'Unknown name'} | ${candidate.title || 'unknown title'}`
      ),
      'Answer as JSON only: {"index": <the number of the chosen person>, "reason": "<short reason>"}.',
      'If none of them fits, answer {"index": null}.'
    ].join('\n');

    const raw = await ask(prompt);
    const pick = parsePersonPick(raw);
    if (pick.index === null || pick.index < 0 || pick.index >= list.length) return null;
    return { index: pick.index, reason: pick.reason, raw };
  }

  return { findEmails, pickBestContact, pickBestPerson, hasKey: Boolean(apiKey), model };
}

module.exports = {
  createGeminiClient,
  extractEmails,
  parseEmailList,
  parsePick,
  parsePersonPick
};

