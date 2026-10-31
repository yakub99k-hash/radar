'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createContactFinder, REASONS } = require('../src/contactFinder');
const { AppError, UpstreamError } = require('../src/errors');
const { createTtlCache } = require('../src/cache');
const { silentLogger } = require('../src/logger');

function makeApollo(config = {}) {
  const calls = { search: [], enrich: [] };
  return {
    calls,
    async searchPeople(params) {
      calls.search.push(params);
      const list =
        calls.search.length > 1 && config.fallbackPeople ? config.fallbackPeople : config.people || [];
      return { people: list, total: list.length };
    },
    async enrichPerson(params) {
      calls.enrich.push(params);
      const person = (config.peopleById && config.peopleById[params.id]) || config.person || null;
      return { person, matchConfidence: person ? 'high' : 'none' };
    }
  };
}

function makeHunter(config = {}) {
  const calls = { find: [], verify: [], domainSearch: [] };
  return {
    calls,
    async findEmail(params) {
      calls.find.push(params);
      if (typeof config.find === 'function') return config.find(params);
      return config.find === undefined ? { email: 'jane@brand.com', score: 92 } : config.find;
    },
    async domainSearch(params) {
      calls.domainSearch.push(params);
      if (typeof config.domainSearch === 'function') return config.domainSearch(params);
      return config.domainSearch === undefined ? { emails: [] } : config.domainSearch;
    },
    async verifyEmail(email) {
      calls.verify.push(email);
      if (typeof config.verify === 'function') return config.verify(email);
      return config.verify || { status: 'valid', result: 'deliverable', score: 95 };
    }
  };
}

/** A Hunter client from before domain search existed (no `domainSearch`). */
function makeHunterWithoutSearch(config = {}) {
  const hunter = makeHunter(config);
  delete hunter.domainSearch;
  return hunter;
}

const INFLUENCER = {
  id: 'p1',
  title: 'Influencer Marketing Manager',
  organization: { name: 'Brand' }
};

const JANE = {
  name: 'Jane Doe',
  title: 'Influencer Marketing Manager',
  linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21'
};

function makeGemini(config = {}) {
  const calls = { findEmails: [], pickBestContact: [] };
  return {
    calls,
    hasKey: config.hasKey !== false,
    async findEmails(params) {
      calls.findEmails.push(params);
      if (typeof config.findEmails === 'function') return config.findEmails(params);
      if (config.findEmails instanceof Error) throw config.findEmails;
      return config.findEmails || { emails: [], raw: '' };
    },
    async pickBestContact(params) {
      calls.pickBestContact.push(params);
      if (typeof config.pickBestContact === 'function') return config.pickBestContact(params);
      if (config.pickBestContact instanceof Error) throw config.pickBestContact;
      return config.pickBestContact || null;
    }
  };
}

function makeFinder({ apollo, hunter, options, cache, now, gemini, hunterFor, fetchSiteText }) {
  return createContactFinder({
    apollo,
    hunter,
    gemini,
    hunterFor,
    fetchSiteText,
    logger: silentLogger,
    cache: cache === null ? null : cache || createTtlCache({ ttlMs: 60000 }),
    now,
    options: Object.assign({ maxEnrichedCandidates: 2, maxEmailsToVerify: 2 }, options)
  });
}


test('happy path returns the four fields the frontend needs', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({
    domain: 'https://www.brand.com/pages/contact',
    brand: 'Brand'
  });

  assert.equal(result.contact_name, 'Jane Doe');
  assert.equal(result.title, 'Influencer Marketing Manager');
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(result.email_status, 'valid');
  assert.equal(result.linkedin_url, 'https://www.linkedin.com/in/jane-doe-4a7c21');
  assert.equal(result.found, true);
  assert.equal(result.is_fallback, false);
  assert.equal(result.meta.domain, 'brand.com');

  // LinkedIn handle is the most precise Hunter input and is tried first.
  assert.equal(hunter.calls.find[0].linkedinHandle, 'jane-doe-4a7c21');
  assert.equal(hunter.calls.verify[0], 'jane@brand.com');
  assert.equal(apollo.calls.enrich[0].id, 'p1');
});

test('generic role mailboxes are marked as fallback, not as a contact', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ find: { email: 'press@brand.com', score: 88 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.is_fallback, true);
  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.GENERIC_EMAIL);
  assert.equal(result.email, 'press@brand.com');
  assert.equal(result.email_status, 'valid');
  assert.match(result.message, /fallback/i);
});

test('no matching person is reported without touching Hunter', async () => {
  const apollo = makeApollo({ people: [] });
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.NO_PERSON_FOUND);
  assert.equal(result.email, null);
  assert.equal(hunter.calls.find.length, 0);
});

test('an unverified email is never returned as a contact', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ verify: { status: 'unknown', result: 'unknown', score: 20 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.email, null);
  assert.equal(result.email_status, 'unknown');
  assert.equal(result.reason, REASONS.EMAIL_UNVERIFIED);
  assert.deepEqual(result.meta.rejected[0], {
    email: 'jane@brand.com',
    reason: 'verification_unknown'
  });
});

test('catch-all addresses are rejected by default and accepted on request', async () => {
  const verify = { status: 'accept_all', result: 'risky', score: 70 };

  const strict = makeFinder({
    apollo: makeApollo({ people: [INFLUENCER], person: JANE }),
    hunter: makeHunter({ verify }),
    cache: null
  });
  const strictResult = await strict.findContact({ domain: 'brand.com', brand: 'Brand' });
  assert.equal(strictResult.found, false);
  assert.equal(strictResult.reason, REASONS.EMAIL_UNVERIFIED);

  const relaxed = makeFinder({
    apollo: makeApollo({ people: [INFLUENCER], person: JANE }),
    hunter: makeHunter({ verify }),
    options: { allowAcceptAll: true },
    cache: null
  });
  const relaxedResult = await relaxed.findContact({ domain: 'brand.com', brand: 'Brand' });
  assert.equal(relaxedResult.found, true);
  assert.equal(relaxedResult.email_status, 'accept_all');
});

test('off-domain addresses are refused when the brand domain is required', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({ find: { email: 'jane@gmail.com', score: 90 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.NO_EMAIL_FOUND);
  assert.equal(hunter.calls.verify.length, 0, 'no credits spent verifying a gmail address');
});


test('a better second candidate wins over a generic first candidate', async () => {
  const people = [
    { id: 'p1', title: 'Head of Influencer Marketing' },
    { id: 'p2', title: 'Partnerships Manager' }
  ];
  const apollo = makeApollo({
    people,
    peopleById: {
      p1: { name: 'Pat Press', linkedin_url: 'https://www.linkedin.com/in/pat-press-111111' },
      p2: { name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/jane-doe-4a7c21' }
    }
  });
  const hunter = makeHunter({
    find: (params) =>
      params.linkedinHandle === 'jane-doe-4a7c21'
        ? { email: 'jane@brand.com', score: 95 }
        : { email: 'press@brand.com', score: 80 }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.contact_name, 'Jane Doe');
  assert.equal(result.email, 'jane@brand.com');
  assert.ok(result.meta.rejected.some((item) => item.reason === 'generic'));
});

test('unknown domains fall back to a brand keyword search and drop other companies', async () => {
  const apollo = makeApollo({
    people: [],
    fallbackPeople: [
      { id: 'x1', title: 'Partnerships Manager', organization: { name: 'Totally Different Co' } },
      { id: 'x2', title: 'Partnerships Manager', organization: { name: 'Acme Bikes' } }
    ],
    peopleById: { x2: { name: 'Jane Doe', linkedin_url: 'https://www.linkedin.com/in/jane-doe' } }
  });
  const hunter = makeHunter({ find: { email: 'jane@acmebikes.com', score: 90 } });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'acmebikes.com', brand: 'Acme Bikes' });

  assert.equal(apollo.calls.search.length, 2);
  assert.equal(apollo.calls.search[1].keywords, 'Acme Bikes');
  assert.deepEqual(apollo.calls.enrich.map((call) => call.id), ['x2']);
  assert.equal(result.found, true);
});

test('results are cached and concurrent lookups share one run', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const apollo = {
    calls: 0,
    async searchPeople() {
      this.calls += 1;
      await gate;
      return { people: [INFLUENCER], total: 1 };
    },
    async enrichPerson() {
      return { person: JANE, matchConfidence: 'high' };
    }
  };
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const first = finder.findContact({ domain: 'brand.com', brand: 'Brand' });
  const second = finder.findContact({ domain: 'brand.com', brand: 'Brand' });
  release();
  const [a, b] = await Promise.all([first, second]);

  assert.equal(apollo.calls, 1, 'one Apollo search for two simultaneous requests');
  assert.deepEqual(a, b);

  const cached = await finder.findContact({ domain: 'https://brand.com', brand: 'Brand' });
  assert.equal(apollo.calls, 1, 'cached lookup did not call Apollo again');
  assert.equal(cached.meta.cached, true);
});

test('an invalid domain is rejected before any paid call', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const finder = makeFinder({ apollo, hunter: makeHunter() });

  await assert.rejects(
    () => finder.findContact({ domain: 'not a domain', brand: 'Brand' }),
    (err) => err.status === 400 && err.code === REASONS.INVALID_DOMAIN
  );
  assert.equal(apollo.calls.search.length, 0);
});

test('Apollo outages fall back to the Hunter domain search', async () => {
  const apollo = {
    async searchPeople() {
      const err = new Error('Apollo rate limit or credit limit reached.');
      err.code = 'APOLLO_429';
      throw err;
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'jane@brand.com',
          type: 'personal',
          confidence: 94,
          firstName: 'Jane',
          lastName: 'Doe',
          position: 'Influencer Marketing Manager',
          linkedinUrl: 'https://www.linkedin.com/in/jane-doe-4a7c21',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(result.contact_name, 'Jane Doe');
  assert.equal(result.meta.strategy, 'hunter-domain-search');
  assert.match(result.meta.apollo_error, /rate limit/);
  assert.equal(hunter.calls.domainSearch[0].domain, 'brand.com');
  assert.equal(hunter.calls.verify.length, 0, 'domain search already reported "valid"');
});

test('Apollo outages still answer UPSTREAM_ERROR when Hunter cannot search domains', async () => {
  const apollo = {
    async searchPeople() {
      const err = new Error('Apollo rate limit or credit limit reached.');
      err.code = 'APOLLO_429';
      throw err;
    }
  };
  const finder = makeFinder({ apollo, hunter: makeHunterWithoutSearch() });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.UPSTREAM_ERROR);
  assert.match(result.message, /Apollo search failed/);
  assert.ok(result.meta.elapsed_ms >= 0);
});

test('missing Apollo credentials no longer surface as a 503', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo API key is not configured', {
        status: 503,
        code: 'APOLLO_KEY_MISSING'
      });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'jane@brand.com',
          firstName: 'Jane',
          lastName: 'Doe',
          position: 'Creator Relations Lead',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(result.meta.strategy, 'hunter-domain-search');
});

test('APOLLO_KEY_MISSING is still a 503 when Hunter cannot search domains', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo API key is not configured', {
        status: 503,
        code: 'APOLLO_KEY_MISSING'
      });
    }
  };
  const finder = makeFinder({ apollo, hunter: makeHunterWithoutSearch() });

  await assert.rejects(
    () => finder.findContact({ domain: 'brand.com', brand: 'Brand' }),
    (err) => err.status === 503 && err.code === 'APOLLO_KEY_MISSING'
  );
});

test('Apollo knowing nobody hands the domain over to Hunter', async () => {
  const apollo = makeApollo({ people: [] });
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'jane@brand.com',
          firstName: 'Jane',
          lastName: 'Doe',
          position: 'Head of Influencer Marketing',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(hunter.calls.find.length, 0, 'the finder is not needed when domain search answers');
});

test('Hunter domain search only pays for a verification it does not already know', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'sam@brand.com',
          firstName: 'Sam',
          lastName: 'Poe',
          position: 'Partnerships Manager',
          confidence: 55
        }
      ]
    },
    verify: { status: 'valid', result: 'deliverable', score: 91 }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.deepEqual(hunter.calls.verify, ['sam@brand.com']);
  assert.equal(result.meta.hunter_score, 55);
});

test('Hunter domain search drops off-domain addresses without verifying them', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'jane@gmail.com',
          position: 'Influencer Marketing Manager',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.NO_EMAIL_FOUND);
  assert.equal(hunter.calls.verify.length, 0);
  assert.deepEqual(result.meta.rejected[0], { email: 'jane@gmail.com', reason: 'off_domain' });
});

test('a verified role mailbox from Hunter domain search is a fallback', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [{ email: 'press@brand.com', type: 'generic', verification: { status: 'valid' } }]
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.is_fallback, true);
  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.GENERIC_EMAIL);
  assert.equal(result.email, 'press@brand.com');
});

test('a valid Apollo result never spends Hunter domain search credits', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter();
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.meta.strategy, 'apollo+hunter');
  assert.equal(hunter.calls.domainSearch.length, 0);
});


test('Gemini finds an email in the page text and no credits are spent', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter();
  const gemini = makeGemini({ findEmails: { emails: ['sam.poe@brand.com'] } });
  const finder = makeFinder({ apollo, hunter, gemini });

  const result = await finder.findContact({
    domain: 'brand.com',
    brand: 'Brand',
    pageText: 'Sponsorships: write to sam.poe [at] brand [dot] com and we will reply quickly.'
  });

  assert.equal(result.found, true);
  assert.equal(result.email, 'sam.poe@brand.com');
  assert.equal(result.email_source, 'gemini');
  assert.equal(result.meta.strategy, 'gemini-text');
  assert.equal(apollo.calls.search.length, 0, 'Apollo was never asked');
  assert.equal(hunter.calls.domainSearch.length, 0, 'Hunter was never asked');
  assert.equal(hunter.calls.find.length, 0);
  assert.equal(gemini.calls.findEmails[0].domain, 'brand.com');
  assert.match(gemini.calls.findEmails[0].text, /sam\.poe \[at\] brand/);
});

test('without browser text the backend reads the site for Gemini', async () => {
  const pageText = 'Contact our creator partnerships team any time at hello@brand.com today.';
  const fetchSiteText = async (domain) => ({ text: pageText, pages: [`https://${domain}/`] });
  const gemini = makeGemini({ findEmails: { emails: ['hello@brand.com'] } });
  const finder = makeFinder({
    apollo: makeApollo({ people: [] }),
    hunter: makeHunter(),
    gemini,
    fetchSiteText
  });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.email, 'hello@brand.com');
  assert.equal(gemini.calls.findEmails[0].text, pageText);
});

test('a Gemini failure falls back to the normal Hunter flow', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter();
  const gemini = makeGemini({ findEmails: new Error('Gemini quota exceeded') });
  const finder = makeFinder({ apollo, hunter, gemini });

  const result = await finder.findContact({
    domain: 'brand.com',
    brand: 'Brand',
    pageText: 'A long enough page text so that Gemini is actually called for this brand.'
  });

  assert.equal(result.found, true);
  assert.equal(result.email, 'jane@brand.com');
  assert.equal(result.meta.strategy, 'apollo+hunter');
});

test('a role mailbox from Gemini is only used when everything else failed', async () => {
  const apollo = makeApollo({ people: [] });
  const hunter = makeHunter({ domainSearch: { emails: [] } });
  const gemini = makeGemini({ findEmails: { emails: ['press@brand.com'] } });
  const finder = makeFinder({ apollo, hunter, gemini });

  const result = await finder.findContact({
    domain: 'brand.com',
    brand: 'Brand',
    pageText: 'Press enquiries go to press [at] brand [dot] com, influencer requests too.'
  });

  assert.equal(result.is_fallback, true);
  assert.equal(result.found, false);
  assert.equal(result.email, 'press@brand.com');
  assert.equal(result.email_source, 'gemini');
  assert.equal(result.reason, REASONS.GENERIC_EMAIL);
});


test('Gemini picks the best person out of several Hunter candidates', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'sam@brand.com',
          firstName: 'Sam',
          lastName: 'Poe',
          position: 'Influencer Marketing Manager',
          confidence: 80,
          verification: { status: 'valid' }
        },
        {
          email: 'lee@brand.com',
          firstName: 'Lee',
          lastName: 'Ann',
          position: 'Partnerships Manager',
          confidence: 70,
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const gemini = makeGemini({
    pickBestContact: { email: 'lee@brand.com', reason: 'owns brand partnerships' }
  });
  const finder = makeFinder({ apollo, hunter, gemini });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.email, 'lee@brand.com');
  assert.equal(result.contact_name, 'Lee Ann');
  assert.equal(result.meta.gemini_pick, 'lee@brand.com');
  assert.equal(result.meta.gemini_reason, 'owns brand partnerships');
  assert.equal(gemini.calls.pickBestContact[0].candidates.length, 2);
  assert.equal(gemini.calls.pickBestContact[0].candidates[0].title, 'Influencer Marketing Manager');
  assert.equal(gemini.calls.pickBestContact[0].brand, 'Brand');
});

test('a Gemini ranking failure keeps the plain Hunter order', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'sam@brand.com',
          firstName: 'Sam',
          lastName: 'Poe',
          position: 'Influencer Marketing Manager',
          verification: { status: 'valid' }
        },
        {
          email: 'lee@brand.com',
          firstName: 'Lee',
          lastName: 'Ann',
          position: 'Partnerships Manager',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const gemini = makeGemini({ pickBestContact: new Error('model overloaded') });
  const finder = makeFinder({ apollo, hunter, gemini });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, true);
  assert.equal(result.email, 'sam@brand.com', 'best Hunter title still wins');
  assert.equal(result.meta.gemini_pick, undefined);
});


test("the browser's Hunter key is used for that request only", async () => {
  const browserCalls = { domainSearch: [] };
  const browserHunter = {
    async domainSearch(params) {
      browserCalls.domainSearch.push(params);
      return {
        emails: [
          {
            email: 'lee@brand.com',
            firstName: 'Lee',
            lastName: 'Ann',
            position: 'Partnerships Manager',
            verification: { status: 'valid' }
          }
        ]
      };
    },
    async verifyEmail() {
      throw new Error('domain search already verified this address');
    },
    async findEmail() {
      return null;
    }
  };
  const keys = [];
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter();
  const finder = makeFinder({
    apollo,
    hunter,
    hunterFor: (key) => {
      keys.push(key);
      return browserHunter;
    }
  });

  const result = await finder.findContact({
    domain: 'brand.com',
    brand: 'Brand',
    hunterApiKey: 'user-key-123'
  });

  assert.deepEqual(keys, ['user-key-123']);
  assert.equal(result.found, true);
  assert.equal(result.email, 'lee@brand.com');
  assert.equal(browserCalls.domainSearch.length, 1);
  assert.equal(hunter.calls.domainSearch.length, 0, "the owner's key was not touched");
});

test('a blank browser key keeps using the server key', async () => {
  const hunter = makeHunter({
    domainSearch: {
      emails: [
        {
          email: 'jane@brand.com',
          firstName: 'Jane',
          lastName: 'Doe',
          position: 'Influencer Marketing Manager',
          verification: { status: 'valid' }
        }
      ]
    }
  });
  const usedKeys = [];
  const finder = makeFinder({
    apollo: makeApollo({ people: [] }),
    hunter,
    hunterFor: (key) => {
      usedKeys.push(key);
      return hunter;
    }
  });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand', hunterApiKey: '   ' });

  assert.equal(result.found, true);
  assert.deepEqual(usedKeys, [], 'no per-request client for an empty key');
  assert.equal(hunter.calls.domainSearch.length, 1);
});

test('an exhausted Hunter plan shows the upgrade message', async () => {
  const apollo = {
    async searchPeople() {
      throw new AppError('Apollo down', { status: 502, code: 'APOLLO_503' });
    }
  };
  const hunter = makeHunter({
    domainSearch: () => {
      throw new UpstreamError('Hunter', 402, 'Payment required: no credits left');
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.found, false);
  assert.equal(result.reason, REASONS.CREDIT_LIMIT);
  assert.equal(result.message, 'API Limit Reached - Please add your own Hunter key');
});

test('a 429 while verifying also shows the upgrade message', async () => {
  const apollo = makeApollo({ people: [INFLUENCER], person: JANE });
  const hunter = makeHunter({
    verify: () => {
      throw new UpstreamError('Hunter', 429, 'Hunter rate limit or credit limit reached.');
    }
  });
  const finder = makeFinder({ apollo, hunter });

  const result = await finder.findContact({ domain: 'brand.com', brand: 'Brand' });

  assert.equal(result.reason, REASONS.CREDIT_LIMIT);
  assert.equal(result.message, 'API Limit Reached - Please add your own Hunter key');
});

