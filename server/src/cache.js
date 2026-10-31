'use strict';

/**
 * Very small TTL cache with a size cap. Apollo/Hunter calls cost real credits,
 * so identical lookups inside the TTL window are served from memory.
 */
function createTtlCache(options = {}) {
  const ttlMs = Math.max(Number(options.ttlMs) || 0, 0);
  const maxEntries = Math.max(Number(options.maxEntries) || 500, 1);
  const now = options.now || Date.now;
  const store = new Map();

  function prune() {
    const ts = now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= ts) store.delete(key);
    }
  }

  return {
    get(key) {
      if (ttlMs === 0) return null;
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        store.delete(key);
        return null;
      }
      // refresh recency for the size cap
      store.delete(key);
      store.set(key, entry);
      return entry.value;
    },
    set(key, value, ttlOverrideMs) {
      const ttl =
        Number.isFinite(ttlOverrideMs) && ttlOverrideMs >= 0 ? ttlOverrideMs : ttlMs;
      if (ttl === 0) return;
      if (store.size >= maxEntries) {
        prune();
        while (store.size >= maxEntries) {
          const oldest = store.keys().next();
          if (oldest.done) break;
          store.delete(oldest.value);
        }
      }
      store.set(key, { value, expiresAt: now() + ttl });
    },
    clear() {
      store.clear();
    },
    get size() {
      return store.size;
    }
  };
}

module.exports = { createTtlCache };
