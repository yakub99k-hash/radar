'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTtlCache } = require('../src/cache');

test('entries expire after the TTL', () => {
  let clock = 0;
  const cache = createTtlCache({ ttlMs: 1000, now: () => clock });

  cache.set('brand.com', { found: true });
  assert.deepEqual(cache.get('brand.com'), { found: true });

  clock = 999;
  assert.deepEqual(cache.get('brand.com'), { found: true });

  clock = 1001;
  assert.equal(cache.get('brand.com'), null);
  assert.equal(cache.size, 0);
});

test('a per-entry TTL override wins (shorter negative caching)', () => {
  let clock = 0;
  const cache = createTtlCache({ ttlMs: 10000, now: () => clock });

  cache.set('found.com', { found: true });
  cache.set('missing.com', { found: false }, 500);

  clock = 600;
  assert.deepEqual(cache.get('found.com'), { found: true });
  assert.equal(cache.get('missing.com'), null);
});

test('the size cap evicts the oldest entry', () => {
  const cache = createTtlCache({ ttlMs: 1000, maxEntries: 2 });
  cache.set('a', 1);
  cache.set('b', 2);
  cache.get('a'); // make "a" the most recently used
  cache.set('c', 3);

  assert.equal(cache.get('b'), null);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('TTL 0 disables caching entirely', () => {
  const cache = createTtlCache({ ttlMs: 0 });
  cache.set('a', 1);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.size, 0);
});
