'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createGeminiClient,
  extractEmails,
  parseEmailList,
  parsePick
} = require('../src/gemini');
const { silentLogger } = require('../src/logger');

function fakeSdk(answer) {
  const calls = [];
  const factory = (options) => ({
    options,
    models: {
      async generateContent(request) {
        calls.push(request);
        if (typeof answer === 'function') return answer(request);
        return { text: answer };
      }
    }
  });
  factory.calls = calls;
  return factory;
}

test('extractEmails pulls distinct addresses out of any text', () => {
  const emails = extractEmails('Write to Press@Brand.com or press@brand.com, or hello@acme.io');
  assert.deepEqual(emails.sort(), ['hello@acme.io', 'press@brand.com'], 'deduped, lowercased');
  assert.deepEqual(extractEmails('jane@example is not a full address'), [], 'needs a real TLD');
});

test('parseEmailList understands JSON, a bare array and plain prose', () => {
  assert.deepEqual(parseEmailList('{"emails": ["a@brand.com"]}'), ['a@brand.com']);
  assert.deepEqual(parseEmailList('["b@brand.com"]'), ['b@brand.com']);
  assert.deepEqual(parseEmailList('The address is c@brand.com, thanks!'), ['c@brand.com']);
  assert.deepEqual(parseEmailList('no addresses here'), []);
});

test('parsePick understands JSON and messy answers', () => {
  assert.deepEqual(parsePick('{"email":"Jane@Brand.com","reason":"head of influencer"}'), {
    email: 'jane@brand.com',
    reason: 'head of influencer'
  });
  assert.equal(parsePick('{"email": null}').email, null);
  assert.equal(parsePick('I would ask sam@brand.com').email, 'sam@brand.com');
});

test('findEmails sends the page text to Gemini and returns the addresses', async () => {
  const sdk = fakeSdk('{"emails": ["press@brand.com", "jane@brand.com"]}');
  const gemini = createGeminiClient({ apiKey: 'g-key', sdkFactory: sdk, logger: silentLogger });

  const result = await gemini.findEmails({
    text: 'Contact our partnerships team at press [at] brand [dot] com for creator campaigns.',
    domain: 'brand.com',
    brand: 'Brand'
  });

  assert.deepEqual(result.emails, ['press@brand.com', 'jane@brand.com']);
  assert.equal(sdk.calls.length, 1);
  assert.equal(sdk.calls[0].config.temperature, 0);
  assert.match(sdk.calls[0].contents, /brand\.com/);
  assert.match(sdk.calls[0].contents, /press \[at\] brand/);
  assert.equal(sdk.calls[0].model, 'gemini-2.5-flash');
});

test('findEmails skips Gemini when there is no usable text', async () => {
  const sdk = fakeSdk('{"emails": ["jane@brand.com"]}');
  const gemini = createGeminiClient({ apiKey: 'g-key', sdkFactory: sdk, logger: silentLogger });

  const result = await gemini.findEmails({ text: '   ', domain: 'brand.com' });
  assert.deepEqual(result.emails, []);
  assert.equal(sdk.calls.length, 0, 'no tokens spent on empty text');
});

test('pickBestContact only ever returns an address from the list', async () => {
  const candidates = [
    { email: 'sam@brand.com', contact_name: 'Sam Poe', title: 'Partnerships Manager' },
    { email: 'lee@brand.com', contact_name: 'Lee Ann', title: 'Head of Influencer Marketing' }
  ];

  const good = fakeSdk('{"email":"lee@brand.com","reason":"runs influencer marketing"}');
  const picked = await createGeminiClient({ apiKey: 'k', sdkFactory: good }).pickBestContact({
    brand: 'Brand',
    domain: 'brand.com',
    candidates
  });
  assert.equal(picked.email, 'lee@brand.com');
  assert.match(good.calls[0].contents, /in charge of Influencer Marketing/);
  assert.match(good.calls[0].contents, /Sam Poe \| Partnerships Manager \| sam@brand\.com/);

  // A hallucinated address must never be trusted.
  const bad = fakeSdk('{"email":"someone-else@other.com"}');
  const rejected = await createGeminiClient({ apiKey: 'k', sdkFactory: bad }).pickBestContact({
    brand: 'Brand',
    domain: 'brand.com',
    candidates
  });
  assert.equal(rejected, null);
});

test('pickBestContact does nothing with a single candidate', async () => {
  const sdk = fakeSdk('{"email":"sam@brand.com"}');
  const picked = await createGeminiClient({ apiKey: 'k', sdkFactory: sdk }).pickBestContact({
    candidates: [{ email: 'sam@brand.com', title: 'Partnerships Manager' }]
  });
  assert.equal(picked, null);
  assert.equal(sdk.calls.length, 0, 'no tokens spent when there is nothing to choose');
});

test('a missing key and a slow model both fail with a typed error', async () => {
  const noKey = createGeminiClient({ apiKey: '', logger: silentLogger });
  await assert.rejects(
    () => noKey.findEmails({ text: 'x'.repeat(80) }),
    (err) => err.status === 503 && err.code === 'GEMINI_KEY_MISSING'
  );

  const slow = createGeminiClient({
    apiKey: 'k',
    timeoutMs: 10,
    logger: silentLogger,
    sdkFactory: () => ({ models: { generateContent: () => new Promise(() => {}) } })
  });
  await assert.rejects(
    () => slow.findEmails({ text: 'y'.repeat(80) }),
    (err) => err.code === 'GEMINI_TIMEOUT'
  );
});
