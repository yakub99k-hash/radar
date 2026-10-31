'use strict';

const { AppError, isCreditLimitError, CREDIT_LIMIT_MESSAGE } = require('./errors');
const {
  normalizeDomain,
  emailOnDomain,
  analyzeEmail,
  splitName,
  linkedinHandle,
  nameFromLinkedinUrl,
  titleScore,
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
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  CREDIT_LIMIT: 'HUNTER_CREDIT_LIMIT'
});

const STRATEGIES = Object.freeze({
  APOLLO: 'apollo+hunter',
  HUNTER: 'hunter-domain-search',
  GEMINI: 'gemini-text'
});

/** Loose shape check; the strict rules live in filters.analyzeEmail/emailOnDomain. */
const EMAIL_SHAPE_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

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
    email_source: partial.email_source || null,
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
  const gemini = deps.gemini;
  const hunterFor = deps.hunterFor;
  const fetchSiteText = deps.fetchSiteText;
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
  const domainSearchLimit = options.domainSearchLimit || 10;
  const negativeCacheTtlMs = options.negativeCacheTtlMs;
  const geminiEmailScan = options.geminiEmailScan !== false;
  // Gemini is optional: without a key every AI step is skipped silently.
  const ai = gemini && gemini.hasKey ? gemini : null;

  /**
   * Per-request Hunter client: a key sent by the browser wins, otherwise the
   * owner's key from HUNTER_API_KEY (the client injected as `hunter`) is used.
   */
  function hunterClientFor(hunterApiKey) {
    const key = typeof hunterApiKey === 'string' ? hunterApiKey.trim() : '';
    if (key && typeof hunterFor === 'function') {
      const client = hunterFor(key);
      if (client) return client;
    }
    return hunter;
  }

  /** The card message the frontend shows when Hunter is out of credits. */
  function creditLimitResult(meta) {
    return buildResult({
      reason: REASONS.CREDIT_LIMIT,
      message: CREDIT_LIMIT_MESSAGE,
      meta
    });
  }

  const inflight = new Map();

  function verificationOptions() {
    return { acceptStatuses, allowAcceptAll };
  }


  /** Asks Hunter for an email using the most precise identifier first. */
  async function lookupEmails(person, domain, h) {
    const client = h || hunter;
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
        match = await client.findEmail(strategy);
      } catch (err) {
        // Out of credits: tell the user instead of silently trying more calls.
        if (isCreditLimitError(err)) throw err;
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
   * Apollo path: people search -> title ranking -> people/match -> Hunter
   * email finder -> Hunter verifier.
   * @returns {Promise<object>} result object (never throws for "empty" outcomes)
   */
  async function runApolloPath(domain, brand, h) {
    const client = h || hunter;
    const startedAt = now();
    const baseMeta = { domain, brand: brand || null, strategy: STRATEGIES.APOLLO };
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
      let matches;
      try {
        matches = await lookupEmails({ fullName, firstName, lastName, linkedinUrl }, domain, client);
      } catch (err) {
        if (isCreditLimitError(err)) {
          return creditLimitResult({ ...baseMeta, elapsed_ms: now() - startedAt });
        }
        throw err;
      }
      if (!matches.length) continue;

      for (const match of matches) {
        const generic = analyzeEmail(match.email);

        if (requireBrandDomain && !emailOnDomain(match.email, domain)) {
          rejected.push({ email: match.email, reason: 'off_domain' });
          continue;
        }

        let verification;
        try {
          verification = await client.verifyEmail(match.email);
        } catch (err) {
          if (err instanceof AppError && err.code === 'HUNTER_KEY_MISSING') throw err;
          if (isCreditLimitError(err)) {
            return creditLimitResult({ ...baseMeta, elapsed_ms: now() - startedAt });
          }
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
   * Reuses the verification status Hunter already returned for a domain search
   * row, so the verifier (a paid call) is only spent when the status is unclear.
   * @returns {object|null} null when the row carries no usable status
   */
  function verificationFromDomainSearch(entry) {
    const status = String(
      (entry && entry.verification && entry.verification.status) || ''
    ).toLowerCase();
    if (!status || status === 'unknown') return null;
    return {
      email: entry.email,
      status,
      result: status === 'valid' ? 'deliverable' : 'unknown',
      score: Number.isFinite(entry.confidence) ? entry.confidence : null,
      disposable: false,
      webmail: false,
      acceptAll: status === 'accept_all',
      block: false,
      smtpCheck: false,
      mxRecords: false
    };
  }

  /**
   * Hunter-only path: Hunter does the heavy lifting. Its domain search lists
   * every address it knows for the brand, we rank them with the same job title
   * rules used for Apollo, keep only the brand's own domain and verify just the
   * best few - reusing the status domain search already reported.
   * @returns {Promise<object>} result in the same shape as the Apollo path
   */
  async function runHunterPath(domain, brand, apolloFailure, h) {
    const client = h || hunter;
    const startedAt = now();
    const baseMeta = { domain, brand: brand || null, strategy: STRATEGIES.HUNTER };
    if (apolloFailure) baseMeta.apollo_error = String(apolloFailure.message || apolloFailure);
    const rejected = [];

    let search;
    try {
      search = await client.domainSearch({ domain, limit: domainSearchLimit });
    } catch (err) {
      if (
        err instanceof AppError &&
        (err.code === 'HUNTER_KEY_MISSING' || err.code === 'HUNTER_BAD_INPUT')
      ) {
        throw err;
      }
      if (isCreditLimitError(err)) {
        return creditLimitResult({ ...baseMeta, elapsed_ms: now() - startedAt });
      }
      if (logger) {
        logger.error('hunter domain search failed', { domain, error: err.message, code: err.code });
      }
      return buildResult({
        reason: REASONS.UPSTREAM_ERROR,
        message: `Hunter domain search failed: ${err.message}`,
        meta: { ...baseMeta, elapsed_ms: now() - startedAt }
      });
    }

    const emails = search && Array.isArray(search.emails) ? search.emails : [];

    // Named people with a matching title first, then other people, then role
    // mailboxes (info@, press@) which can only ever be a fallback.
    const ranked = emails
      .filter((entry) => entry && entry.email)
      .filter((entry) => {
        if (requireBrandDomain && !emailOnDomain(entry.email, domain)) {
          rejected.push({ email: entry.email, reason: 'off_domain' });
          return false;
        }
        return true;
      })
      .map((entry, index) => {
        const mailbox = analyzeEmail(entry.email);
        const fullName = cleanName(
          [entry.firstName, entry.lastName].filter(Boolean).join(' ') ||
            nameFromLinkedinUrl(entry.linkedinUrl)
        );
        return {
          ...entry,
          generic: mailbox.generic,
          fullName: fullName || null,
          score: mailbox.generic ? 0 : titleScore(entry.position),
          index
        };
      })
      .sort((a, b) => {
        if (a.generic !== b.generic) return a.generic ? 1 : -1;
        if (b.score !== a.score) return b.score - a.score;
        const aConfidence = Number.isFinite(a.confidence) ? a.confidence : -1;
        const bConfidence = Number.isFinite(b.confidence) ? b.confidence : -1;
        if (bConfidence !== aConfidence) return bConfidence - aConfidence;
        return a.index - b.index;
      });

    const named = ranked.filter((entry) => !entry.generic);
    const preferred = named.filter((entry) => entry.score >= minTitleScore);
    const others = named.filter((entry) => entry.score < minTitleScore);
    const mailboxes = ranked.filter((entry) => entry.generic);

    const meta = () => ({
      ...baseMeta,
      candidates: emails.length,
      rejected: rejected.slice(0, 5),
      elapsed_ms: now() - startedAt
    });

    let unverified = null;
    let paidVerifications = 0;
    const shortlist = [...preferred, ...others].slice(0, Math.max(maxCandidates, maxEmailsToVerify));

    // Several candidates? Let Gemini pick the influencer/partnership owner, then
    // verify that one first. Any Gemini failure keeps the Hunter ranking.
    let ordered = shortlist;
    if (ai && shortlist.length > 1) {
      try {
        const pick = await ai.pickBestContact({
          brand,
          domain,
          candidates: shortlist.map((entry) => ({
            email: entry.email,
            contact_name: entry.fullName,
            title: entry.position
          }))
        });
        if (pick && pick.email) {
          const chosen = shortlist.find((entry) => entry.email === pick.email);
          if (chosen) {
            ordered = [chosen, ...shortlist.filter((entry) => entry !== chosen)];
            baseMeta.gemini_pick = pick.email;
            if (pick.reason) baseMeta.gemini_reason = pick.reason;
          }
        }
      } catch (err) {
        if (logger) {
          logger.warn('gemini ranking failed, keeping the Hunter order', {
            domain,
            error: err.message
          });
        }
      }
    }

    for (const entry of ordered) {
      if (paidVerifications >= maxEmailsToVerify) break;

      let verification = verificationFromDomainSearch(entry);
      if (!verification) {
        paidVerifications += 1;
        try {
          verification = await client.verifyEmail(entry.email);
        } catch (err) {
          if (err instanceof AppError && err.code === 'HUNTER_KEY_MISSING') throw err;
          if (isCreditLimitError(err)) return creditLimitResult(meta());
          if (logger) logger.warn('hunter verifier failed', { email: entry.email, error: err.message });
          rejected.push({ email: entry.email, reason: 'verifier_error' });
          continue;
        }
      }

      const status = emailStatusLabel(verification);
      if (!isAcceptedVerification(verification, verificationOptions())) {
        if (!unverified) unverified = { email: entry.email, status };
        rejected.push({ email: entry.email, reason: `verification_${status}` });
        continue;
      }

      return buildResult({
        contact_name: entry.fullName,
        title: entry.position || null,
        email: entry.email,
        email_status: status,
        linkedin_url: entry.linkedinUrl || null,
        is_fallback: false,
        found: true,
        message: `${entry.fullName || 'A contact'}${
          entry.position ? ` (${entry.position})` : ''
        } found via Hunter domain search.`,
        meta: { ...meta(), hunter_score: entry.confidence }
      });
    }

    // No named contact: a verified role mailbox still beats "nothing found".
    for (const entry of mailboxes.slice(0, 1)) {
      let verification = verificationFromDomainSearch(entry);
      if (!verification) {
        try {
          verification = await client.verifyEmail(entry.email);
        } catch (err) {
          if (err instanceof AppError && err.code === 'HUNTER_KEY_MISSING') throw err;
          if (isCreditLimitError(err)) return creditLimitResult(meta());
          if (logger) logger.warn('hunter verifier failed', { email: entry.email, error: err.message });
          rejected.push({ email: entry.email, reason: 'verifier_error' });
          continue;
        }
      }
      const status = emailStatusLabel(verification);
      if (!isAcceptedVerification(verification, verificationOptions())) {
        rejected.push({ email: entry.email, reason: `verification_${status}` });
        continue;
      }
      return buildResult({
        title: entry.position || null,
        email: entry.email,
        email_status: status,
        linkedin_url: entry.linkedinUrl || null,
        is_fallback: true,
        found: false,
        reason: REASONS.GENERIC_EMAIL,
        message: `Only the generic mailbox ${entry.email} was found at ${domain}, so it is marked as a fallback.`,
        meta: meta()
      });
    }

    if (unverified) {
      return buildResult({
        reason: REASONS.EMAIL_UNVERIFIED,
        email_status: unverified.status,
        message: `Hunter found ${unverified.email} at ${domain} but could not verify it (status: ${unverified.status}).`,
        meta: meta()
      });
    }

    return buildResult({
      reason: REASONS.NO_EMAIL_FOUND,
      message: emails.length
        ? `Hunter listed ${emails.length} address(es) at ${domain}, but none is a verified influencer or partnership contact.`
        : `Hunter has no email on file for ${domain}.`,
      meta: meta()
    });
  }

  /**
   * Asks Gemini for addresses in the brand's page text. Never throws: a missing
   * key, a timeout or nonsense output simply means "no AI answer".
   */
  async function scanTextWithGemini(domain, brand, pageText) {
    if (!ai || !geminiEmailScan) return null;
    let text = String(pageText || '').trim();
    if (text.length < 60 && typeof fetchSiteText === 'function') {
      try {
        const page = await fetchSiteText(domain);
        text = String((page && page.text) || '').trim();
      } catch (err) {
        if (logger) logger.warn('could not read website text for Gemini', { domain, error: err.message });
      }
    }
    if (text.length < 60) return null;
    try {
      const found = await ai.findEmails({ text, domain, brand });
      const emails = Array.isArray(found && found.emails) ? found.emails : [];
      return emails.length ? emails : null;
    } catch (err) {
      if (logger) {
        logger.warn('gemini email scan failed, continuing with Hunter', { domain, error: err.message });
      }
      return null;
    }
  }

  /** Filters Gemini's findings: brand-domain only, people vs role mailboxes. */
  function classifyGeminiEmails(emails, domain) {
    const personal = [];
    const generic = [];
    const seen = new Set();
    for (const raw of emails || []) {
      const email = String(raw || '').trim().toLowerCase();
      if (!EMAIL_SHAPE_RE.test(email) || seen.has(email)) continue;
      if (requireBrandDomain && !emailOnDomain(email, domain)) continue;
      seen.add(email);
      if (analyzeEmail(email).generic) generic.push(email);
      else personal.push(email);
    }
    return { personal, generic };
  }

  /**
   * Runs the Apollo path, then the Hunter path, without the Gemini text scan.
   * @returns {Promise<object>} result object (never throws for "empty" outcomes)
   */
  async function runStrategies(domain, brand, h, startedAt) {
    const canAskHunter = typeof h.domainSearch === 'function';
    let apolloResult = null;
    let apolloFailure = null;

    try {
      apolloResult = await runApolloPath(domain, brand, h);
    } catch (err) {
      // Thrown for APOLLO_KEY_MISSING only; other outages come back as a result.
      apolloFailure = err.message || String(err);
      if (!canAskHunter) {
        // Nothing else can answer: keep the old contract for the HTTP layer.
        if (err instanceof AppError && err.code === 'APOLLO_KEY_MISSING') throw err;
        return buildResult({
          reason: REASONS.UPSTREAM_ERROR,
          message: `Apollo search failed: ${err.message}`,
          meta: {
            domain,
            brand: brand || null,
            strategy: STRATEGIES.APOLLO,
            elapsed_ms: now() - startedAt
          }
        });
      }
      if (logger) {
        logger.warn('apollo unavailable, using Hunter domain search instead', {
          domain,
          error: err.message,
          code: err.code
        });
      }
    }

    if (apolloResult && apolloResult.reason === REASONS.UPSTREAM_ERROR) {
      // runApolloPath() reports outages (401, 429, 5xx) as a result, not a throw.
      apolloFailure = apolloResult.message;
      if (logger) {
        logger.warn('apollo search failed, using Hunter domain search instead', {
          domain,
          message: apolloResult.message
        });
      }
    }

    const apolloAnswered =
      apolloResult &&
      apolloResult.reason !== REASONS.UPSTREAM_ERROR &&
      apolloResult.reason !== REASONS.NO_PERSON_FOUND;
    if (apolloAnswered) return apolloResult;
    if (!canAskHunter) return apolloResult;

    const hunterResult = await runHunterPath(domain, brand, apolloFailure, h);
    // Apollo knew nobody and Hunter had nothing better to say: keep Apollo's message.
    if (
      apolloResult &&
      apolloResult.reason === REASONS.NO_PERSON_FOUND &&
      (hunterResult.reason === REASONS.UPSTREAM_ERROR ||
        hunterResult.reason === REASONS.NO_EMAIL_FOUND)
    ) {
      return apolloResult;
    }
    return hunterResult;
  }

  /**
   * Runs the pipeline for one brand domain.
   *
   * 1. Gemini reads the page text first: a printed address there costs no credits.
   * 2. Apollo answers when it can (titles + LinkedIn), Hunter otherwise.
   * 3. A role mailbox found by Gemini is offered when nothing else worked.
   *
   * @param {{domain: string, brand?: string, pageText?: string,
   *          hunterApiKey?: string}} params
   * @returns {Promise<object>} result object (never throws for "empty" outcomes)
   */
  async function run(domain, brand, request = {}) {
    const startedAt = now();
    const h = hunterClientFor(request.hunterApiKey);

    const scanned = await scanTextWithGemini(domain, brand, request.pageText);
    const fromText = classifyGeminiEmails(scanned, domain);
    if (fromText.personal.length) {
      const email = fromText.personal[0];
      return buildResult({
        email,
        email_status: 'unverified',
        is_fallback: false,
        found: true,
        email_source: 'gemini',
        message: `Gemini found ${email} in the brand's page text, so no Hunter credits were used.`,
        meta: {
          domain,
          brand: brand || null,
          strategy: STRATEGIES.GEMINI,
          gemini_emails: fromText.personal.slice(0, 3),
          elapsed_ms: now() - startedAt
        }
      });
    }

    const result = await runStrategies(domain, brand, h, startedAt);
    if (fromText.generic.length && !result.found && !result.is_fallback) {
      const email = fromText.generic[0];
      return buildResult({
        email,
        email_status: 'unverified',
        is_fallback: true,
        found: false,
        email_source: 'gemini',
        reason: REASONS.GENERIC_EMAIL,
        message: `Only the generic mailbox ${email} was found in the page text by Gemini.`,
        meta: { ...result.meta, gemini_fallback: true }
      });
    }
    return result;
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

    const task = run(domain, brand, params)
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
