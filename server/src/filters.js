'use strict';

/**
 * Pure helpers for the contact pipeline: domain cleanup, title ranking,
 * name handling, generic mailbox detection and verification acceptance.
 * Keeping these pure makes them easy to unit test and reuse.
 */

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const TLD_RE = /(\.[a-z]{2,}|\.xn--[a-z0-9-]+)$/;

/**
 * Turns "https://www.Brand.com/about?x=1" or "@brand.com" into "brand.com".
 * Returns null when the input cannot be a public domain.
 */
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let value = input.trim().toLowerCase();
  if (!value) return null;

  value = value.replace(/^@+/, '').replace(/^\/\//, '');

  // Non ASCII domains are converted to punycode by the URL parser.
  if (/[^\x20-\x7e]/.test(value) || /^https?:\/\//.test(value) || value.includes('/')) {
    try {
      const candidate = /^https?:\/\//.test(value) ? value : `http://${value}`;
      value = new URL(candidate).hostname;
    } catch (err) {
      return null;
    }
  }

  value = value.split(/[/?#]/)[0].split(':')[0].replace(/\.+$/, '').replace(/^www\./, '');

  if (!value || value.length > 253) return null;
  if (!HOSTNAME_RE.test(value) || !TLD_RE.test(value)) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null; // IP address, not a brand domain
  return value;
}

/** True when the mailbox belongs to the brand (sub-domains included). */
function emailOnDomain(email, domain) {
  if (!email || !domain || !email.includes('@')) return false;
  const host = email.split('@').pop().toLowerCase().trim();
  const target = String(domain).toLowerCase().trim();
  return host === target || host.endsWith(`.${target}`) || target.endsWith(`.${host}`);
}

/**
 * Role mailboxes (info@, press@, support@...) are not a person. They are kept
 * as a "fallback" so a brand with no named contact still has something usable.
 */
const GENERIC_MAILBOXES = new Set([
  'info', 'information', 'support', 'help', 'helpdesk', 'hello', 'hi', 'contact',
  'contactus', 'enquiries', 'enquiry', 'inquiries', 'inquiry', 'sales', 'press',
  'media', 'pr', 'publicrelations', 'marketing', 'partnerships', 'partnership',
  'partners', 'partner', 'sponsorship', 'sponsorships', 'influencer', 'influencers',
  'creator', 'creators', 'affiliate', 'affiliates', 'team', 'admin', 'office',
  'billing', 'accounts', 'accounting', 'jobs', 'careers', 'recruitment', 'hr',
  'legal', 'privacy', 'abuse', 'security', 'webmaster', 'postmaster', 'noreply',
  'community', 'social', 'socialmedia', 'events', 'service', 'customerservice',
  'customercare', 'feedback', 'general', 'mail', 'email', 'news', 'newsletter',
  'orders', 'shop', 'store', 'wholesale', 'returns', 'deals', 'growth', 'brand'
]);

const GENERIC_PATTERNS = [
  /^no-?reply/i,
  /^do-?not-?reply/i,
  /^(info|support|help|hello|contact|sales|press|media|pr|marketing|partners?|team|office|admin)[._-][a-z0-9._-]+$/i,
  /^(info|support|help|hello|contact|sales|press|media|pr|marketing|partners?|team|office|admin)[0-9]+$/i
];

/**
 * @returns {{generic: boolean, mailbox: string|null, reason: string|null}}
 */
function analyzeEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return { generic: false, mailbox: null, reason: null };

  const mailbox = value.slice(0, at).split('+')[0].replace(/[._-]+$/, '');
  if (!mailbox) return { generic: false, mailbox: null, reason: null };

  if (GENERIC_MAILBOXES.has(mailbox)) {
    return { generic: true, mailbox, reason: `role mailbox "${mailbox}@"` };
  }
  const base = mailbox.replace(/[._-]?\d+$/, '');
  if (GENERIC_MAILBOXES.has(base)) {
    return { generic: true, mailbox, reason: `role mailbox "${base}@"` };
  }
  if (GENERIC_PATTERNS.some((re) => re.test(mailbox))) {
    return { generic: true, mailbox, reason: `role mailbox "${mailbox}@"` };
  }
  return { generic: false, mailbox, reason: null };
}

function isGenericEmail(email) {
  return analyzeEmail(email).generic;
}


const NAME_SUFFIXES = new Set(['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'v', 'phd', 'ph.d.', 'md', 'mba', 'esq', 'cpa']);

/** Splits "Jane M. van der Doe Jr." into first/last names for Hunter. */
function splitName(fullName) {
  const cleaned = String(fullName || '')
    .replace(/[^\p{L}\p{M}' .-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return { firstName: '', lastName: '' };

  const parts = cleaned.split(' ').filter(Boolean);
  while (parts.length > 2 && NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts[parts.length - 1] };
}

/** Extracts "jane-doe-4a7c21" from a LinkedIn profile URL. */
function linkedinHandle(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  const match = value.match(/linkedin\.com\/(?:in|pub)\/([^/?#]+)/i);
  const slug = match ? match[1] : null;
  if (!slug) return null;
  let handle;
  try {
    handle = decodeURIComponent(slug);
  } catch (err) {
    handle = slug;
  }
  handle = handle.replace(/\/+$/, '').trim();
  return handle && handle.length <= 120 ? handle : null;
}

/**
 * Apollo obfuscates last names ("Do***e") and the search endpoint returns no
 * LinkedIn URL, so a readable name is often derived from the profile handle.
 */
function nameFromLinkedinUrl(url) {
  const handle = linkedinHandle(url);
  if (!handle) return null;
  const withoutId = handle
    .replace(/(?:[-_][0-9a-f]{4,})+$/i, '')
    .replace(/(?:[-_]\d{3,})+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!withoutId || !/[a-z]/i.test(withoutId)) return null;
  const name = withoutId
    .split(' ')
    .filter((word) => word.length > 0 && !/^\d+$/.test(word) && word.length <= 40)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
  return name.length >= 2 ? name : null;
}


const TITLE_RULES = [
  { re: /\binfluencers?\b/i, score: 100 },
  { re: /\bkol\b/i, score: 95 },
  { re: /\bcreators?\b/i, score: 92 },
  { re: /\bpartnerships?\b/i, score: 88 },
  { re: /\bsocial media\b/i, score: 70 },
  { re: /\bbrand (?:marketing|partnerships?|collab)/i, score: 62 },
  { re: /\bsponsorship\b/i, score: 60 },
  { re: /\baffiliates?\b/i, score: 52 },
  { re: /\bpublic relations\b|\bpr\b/i, score: 48 },
  { re: /\btalent\b/i, score: 45 },
  { re: /\bcommunity\b/i, score: 40 },
  { re: /\bmarketing\b/i, score: 38 },
  { re: /\bcommunications?\b/i, score: 34 },
  { re: /\bbrand\b/i, score: 30 }
];

const SENIORITY_BONUS = [
  { re: /\b(?:head|director|vp|vice president|chief|global head|lead)\b/i, score: 12 },
  { re: /\bmanager\b/i, score: 8 },
  { re: /\bsenior\b|\bsr\.?\b/i, score: 4 }
];

const NEGATIVE_RULES = [
  { re: /\bintern(?:ship)?\b/i, score: -60 },
  { re: /\bassistant\b/i, score: -30 },
  { re: /\bcoordinator\b/i, score: -18 },
  { re: /\btrainee\b|\bstudent\b|\bapprentice\b/i, score: -40 },
  { re: /\brecruit(?:er|ment)\b|\btalent acquisition\b/i, score: -45 },
  { re: /\bsales\b|\baccount executive\b|\bbusiness development\b/i, score: -30 },
  { re: /\bengineer\b|\bdeveloper\b|\bdesigner\b/i, score: -40 },
  { re: /\bfinance\b|\blegal\b|\baccountant\b/i, score: -40 }
];

const RELEVANT_TITLE_RE = /\b(influencers?|creators?|partnerships?|partners?|sponsorships?|sponsors?|social media|marketing|brand|talent|community|affiliates?|public relations|pr|communications?)\b/i;

/** Scores how likely a job title is to own influencer/creator partnerships. */
function titleScore(title) {
  const value = String(title || '');
  if (!value.trim() || !RELEVANT_TITLE_RE.test(value)) return 0;

  let best = 0;
  for (const rule of TITLE_RULES) {
    if (rule.re.test(value)) best = Math.max(best, rule.score);
  }
  for (const rule of SENIORITY_BONUS) {
    if (rule.re.test(value)) best += rule.score;
  }
  for (const rule of NEGATIVE_RULES) {
    if (rule.re.test(value)) best += rule.score;
  }
  return Math.max(0, best);
}

/**
 * Normalises the Apollo people array and sorts the best contact first.
 * @param {Array<object>} people raw Apollo `people` entries
 * @param {{minScore?: number}} options
 */
function rankCandidates(people, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 25;
  const list = Array.isArray(people) ? people : [];

  return list
    .map((person, index) => {
      const title = (person && person.title) || null;
      return {
        raw: person,
        id: person && (person.id || person.person_id || null),
        title,
        linkedinUrl: (person && (person.linkedin_url || person.linkedinUrl)) || null,
        hasEmail: Boolean(person && person.has_email),
        score: titleScore(title),
        index
      };
    })
    .filter((candidate) => candidate.id && candidate.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.hasEmail !== b.hasEmail) return a.hasEmail ? -1 : 1;
      return a.index - b.index;
    });
}


/**
 * Hunter reports `status` (valid/invalid/accept_all/webmail/disposable/unknown)
 * and `result` (deliverable/undeliverable/risky/unknown).
 */
function isAcceptedVerification(verification, options = {}) {
  const acceptStatuses = (options.acceptStatuses || ['valid', 'deliverable']).map((s) =>
    String(s).toLowerCase()
  );
  const allowAcceptAll = Boolean(options.allowAcceptAll);
  const status = String((verification && verification.status) || '').toLowerCase();
  const result = String((verification && verification.result) || '').toLowerCase();

  if (verification && (verification.disposable === true || verification.block === true)) {
    return false;
  }
  if (status === 'accept_all' || result === 'risky') {
    return allowAcceptAll && status !== 'invalid' && result !== 'undeliverable';
  }
  return acceptStatuses.includes(status) || acceptStatuses.includes(result);
}

/** "valid" (status) or "deliverable" (result) - what the frontend displays. */
function emailStatusLabel(verification) {
  const status = String((verification && verification.status) || '').toLowerCase();
  const result = String((verification && verification.result) || '').toLowerCase();
  if (status === 'valid') return 'valid';
  if (result === 'deliverable') return 'deliverable';
  return status || result || 'unknown';
}

module.exports = {
  normalizeDomain,
  emailOnDomain,
  analyzeEmail,
  isGenericEmail,
  splitName,
  linkedinHandle,
  nameFromLinkedinUrl,
  titleScore,
  rankCandidates,
  isAcceptedVerification,
  emailStatusLabel,
  GENERIC_MAILBOXES
};
