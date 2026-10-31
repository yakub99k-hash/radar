'use strict';

const { AppError } = require('./errors');
const {
  normalizeDomain,
  emailOnDomain,
  analyzeEmail,
  splitName,
  linkedinHandle,
  nameFromLinkedinUrl,
  rankCandidates,
  isAcceptedVerification,
  emailStatusLabel
} = require('./filters');

const REASONS = Object.freeze({
  INVALID_DOMAIN: 'INVALID_DOMAIN',
  NO_PERSON_FOUND: 'NO_PERSON_FOUND',
  NO_EMAIL_FOUND: 'NO_EMAIL_FOUND',
  EMAIL_UNVERIFIED: 'EMAIL_UNVERIFIED',
  GENERIC_EMAIL: 'GENERIC_EMAIL',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR'
});

/** The shape the frontend always receives, even when nothing was found. */
function buildResult(partial) {
  return {
    contact_name: partial.contact_name || null,
    title: partial.title || null,
    email: partial.email || null,
    email_status: partial.email_status || null,
    linkedin_url: partial.linkedin_url || null,
    is_fallback: Boolean(partial.is_fallback),
    found: Boolean(partial.found),
    reason: partial.reason || null,
    message: partial.message || '',
    meta: partial.meta || {}
  };
}

function normText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function cleanName(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}.)]+$/u, '')
    .trim()
    .slice(0, 120);
}

/**
 * Creates the pipeline:
 *   Apollo people search -> title ranking -> Apollo people/match (name + LinkedIn)
 *   -> Hunter email finder -> Hunter verifier -> generic mailbox filter.
 */
function createContactFinder(deps = {}) {
  const apollo = deps.apollo;
  const hunter = deps.hunter;
  const logger = deps.logger;
  const cache = deps.cache;
  const now = deps.now || Date.now;
  const options = deps.options || {};

  const titles = options.titles || [
    'Influencer Marketing',
    'Partnerships',
    'Creator Relations',
    'Social Media Manager'
  ];
  const acceptStatuses = options.acceptStatuses || ['valid', 'deliverable'];
  const allowAcceptAll = Boolean(options.allowAcceptAll);
  const requireBrandDomain = options.requireBrandDomain !== false;
  const minTitleScore = Number.isFinite(options.minTitleScore) ? options.minTitleScore : 25;
  const maxCandidates = options.maxCandidates || 6;
  const maxEnriched = options.maxEnrichedCandidates || 2;
  const maxEmailsToVerify = options.maxEmailsToVerify || 2;
  const negativeCacheTtlMs = options.negativeCacheTtlMs;

  const inflight = new Map();

  function verificationOptions() {
    return { acceptStatuses, allowAcceptAll };
  }


  /** Asks Hunter for an email using the most precise identifier first. */
  async function lookupEmails(person, domain) {
    const handle = linkedinHandle(person.linkedinUrl);
    const strategies = [];
    if (handle) strategies.push({ linkedinHandle: handle });
    strategies.push({
      domain,
      firstName: person.firstName,
      lastName: person.lastName,
      fullName: person.fullName
    });

    const found = [];
    const seen = new Set();
    for (const strategy of strategies) {
      let match = null;
      try {
        match = await hunter.findEmail(strategy);
      } catch (err) {
        if (logger) {
          logger.warn('hunter email-finder failed', {
            strategy: strategy.linkedinHandle ? 'linkedin' : 'domain',
            error: err.message,
            code: err.code
          });
        }
        continue;
      }
      if (!match || !match.email || seen.has(match.email)) continue;
      seen.add(match.email);
      found.push(match);
      if (found.length >= maxEmailsToVerify) break;
    }
    return found;
  }

  /**
   * Runs the pipeline for one brand domain.
   * @returns {Promise<object>} result object (never throws for "empty" outcomes)
   */
  async function run(domain, brand) {
    const startedAt = now();
    const baseMeta = { domain, brand: brand || null };
    const rejected = [];

    let people = [];
    let keywordFallback = false;
    try {
      const search = await apollo.searchPeople({ domain, titles, perPage: options.perPage || 10 });
      people = search.people;
      // A brand domain Apollo does not know: retry by company name keywords.
      if (!people.length && brand) {
        keywordFallback = true;
        const alt = await apollo.searchPeople({
          titles,
          keywords: brand,
          perPage: options.perPage || 10
        });
        people = alt.people;
      }
    } catch (err) {
      if (err instanceof AppError && err.code === 'APOLLO_KEY_MISSING') throw err;
      if (logger) {
        logger.error('apollo people search failed', { domain, error: err.message, code: err.code });
      }
      return buildResult({
        reason: REASONS.UPSTREAM_ERROR,
        message: `Apollo search failed: ${err.message}`,
        meta: { ...baseMeta, elapsed_ms: now() - startedAt }
      });
    }

    if (keywordFallback) {
      // Keyword search can return other companies: keep only brand look-alikes.
      const brandKey = normText(brand);
      people = people.filter((person) => {
        const orgKey = normText(person && person.organization && person.organization.name);
        return !brandKey || !orgKey || orgKey.includes(brandKey) || brandKey.includes(orgKey);
      });
    }

    const ranked = rankCandidates(people, { minScore: minTitleScore });
    if (!ranked.length) {
      return buildResult({
        reason: REASONS.NO_PERSON_FOUND,
        message: `No influencer or partnership contact was found at ${domain}.`,
        meta: { ...baseMeta, candidates: people.length, elapsed_ms: now() - startedAt }
      });
    }

    // Shortlist the best titles, then only enrich the top few (each match = 1 credit).
    const shortlist = ranked.slice(0, maxCandidates);
    let fallback = null;
    let unverified = null;

    for (const candidate of shortlist.slice(0, maxEnriched)) {
      let person = null;
      try {
        const enriched = await apollo.enrichPerson({
          id: candidate.id,
          domain,
          organizationName:
            (candidate.raw && candidate.raw.organization && candidate.raw.organization.name) ||
            brand ||
            undefined,
          linkedinUrl: candidate.linkedinUrl || undefined
        });
        person = enriched.person;
        if (enriched.matchConfidence === 'none') person = null;
      } catch (err) {
        if (err instanceof AppError && err.code === 'APOLLO_KEY_MISSING') throw err;
        if (logger) logger.warn('apollo people/match failed', { domain, error: err.message });
        continue;
      }

      const linkedinUrl = (person && person.linkedin_url) || candidate.linkedinUrl || null;
      const fullName = cleanName(
        (person && person.name) ||
          [person && person.first_name, person && person.last_name].filter(Boolean).join(' ') ||
          nameFromLinkedinUrl(linkedinUrl)
      );
      const { firstName, lastName } = splitName(fullName);
      // Hunter needs a first + last name (or a LinkedIn handle).
      if (!linkedinUrl && (!firstName || !lastName)) continue;

      const title = (person && person.title) || candidate.title || null;
      const matches = await lookupEmails({ fullName, firstName, lastName, linkedinUrl }, domain);
      if (!matches.length) continue;

      for (const match of matches) {
        const generic = analyzeEmail(match.email);

        if (requireBrandDomain && !emailOnDomain(match.email, domain)) {
          rejected.push({ email: match.email, reason: 'off_domain' });
          continue;
        }

        let verification;
        try {
          verification = await hunter.verifyEmail(match.email);
        } catch (err) {
          if (err instanceof AppError && err.code === 'HUNTER_KEY_MISSING') throw err;
          if (logger) logger.warn('hunter verifier failed', { email: match.email, error: err.message });
          rejected.push({ email: match.email, reason: 'verifier_error' });
          continue;
        }

        const status = emailStatusLabel(verification);
        if (!isAcceptedVerification(verification, verificationOptions())) {
          if (!unverified) unverified = { email: match.email, status };
          rejected.push({ email: match.email, reason: `verification_${status}` });
          continue;
        }

        if (generic.generic) {
          // Rejected as a person, kept as a fallback address.
          if (!fallback) {
            fallback = {
              contact_name: fullName || null,
              title,
              email: match.email,
              email_status: status,
              linkedin_url: linkedinUrl
            };
          }
          rejected.push({ email: match.email, reason: 'generic' });
          continue;
        }

        return buildResult({
          contact_name: fullName || null,
          title,
          email: match.email,
          email_status: status,
          linkedin_url: linkedinUrl,
          is_fallback: false,
          found: true,
          message: `${fullName || 'A contact'}${title ? ` (${title})` : ''} found via Apollo + Hunter.`,
          meta: {
            ...baseMeta,
            candidates: people.length,
            candidate_title: candidate.title,
            title_score: candidate.score,
            hunter_score: match.score,
            rejected: rejected.slice(0, 5),
            elapsed_ms: now() - startedAt
          }
        });
      }
    }

    const meta = {
      ...baseMeta,
      candidates: people.length,
      rejected: rejected.slice(0, 5),
      elapsed_ms: now() - startedAt
    };

    if (fallback) {
      return buildResult({
        contact_name: fallback.contact_name,
        title: fallback.title,
        email: fallback.email,
        email_status: fallback.email_status,
        linkedin_url: fallback.linkedin_url,
        is_fallback: true,
        found: false,
        reason: REASONS.GENERIC_EMAIL,
        message: `Only the generic mailbox ${fallback.email} was found, so it is marked as a fallback.`,
        meta
      });
    }

    if (unverified) {
      return buildResult({
        reason: REASONS.EMAIL_UNVERIFIED,
        email_status: unverified.status,
        message: `An email was found for a contact but Hunter could not verify it (status: ${unverified.status}).`,
        meta
      });
    }

    return buildResult({
      reason: REASONS.NO_EMAIL_FOUND,
      message: `Apollo found contacts at ${domain} but Hunter could not find a verified email for them.`,
      meta
    });
  }

  /**
   * Public entry point. Caches results and de-duplicates concurrent lookups so
   * a double click cannot spend Apollo/Hunter credits twice.
   */
  async function findContact(params = {}) {
    const domain = normalizeDomain(params.domain);
    if (!domain) {
      throw new AppError('A valid brand domain is required (for example "brand.com").', {
        status: 400,
        code: REASONS.INVALID_DOMAIN
      });
    }
    const brand = String(params.brand || '').trim().slice(0, 120);
    const cacheKey = `contact:v1:${domain}`;

    const cached = cache && cache.get(cacheKey);
    if (cached) {
      return { ...cached, meta: { ...cached.meta, cached: true } };
    }

    const pending = inflight.get(cacheKey);
    if (pending) return pending;

    const task = run(domain, brand)
      .then((result) => {
        const cacheable = result.reason !== REASONS.UPSTREAM_ERROR;
        if (cache && cacheable) {
          // "Not found" goes stale faster than a verified contact.
          cache.set(cacheKey, result, result.found ? undefined : negativeCacheTtlMs);
        }
        return result;
      })
      .finally(() => inflight.delete(cacheKey));

    inflight.set(cacheKey, task);
    return task;
  }

  return { findContact, REASONS };
}

module.exports = { createContactFinder, REASONS, buildResult };
