'use strict';

/**
 * Minimal counting semaphore used to cap how many brand lookups (and therefore
 * how many paid Apollo/Hunter calls) run at the same time.
 */
function createSemaphore(limit) {
  const max = Math.max(Number(limit) || 1, 1);
  let active = 0;
  const queue = [];

  function release() {
    active -= 1;
    const next = queue.shift();
    if (next) next();
  }

  return {
    get active() {
      return active;
    },
    get pending() {
      return queue.length;
    },
    async run(task) {
      if (active >= max) {
        await new Promise((resolve) => queue.push(resolve));
      }
      active += 1;
      try {
        return await task();
      } finally {
        release();
      }
    }
  };
}

module.exports = { createSemaphore };
