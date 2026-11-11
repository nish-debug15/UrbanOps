/**
 * Minimal keyed async mutex: callers with the same key run one at a time, callers
 * with different keys run in parallel. Used to make "check for duplicate, then
 * insert" atomic per issue category within this process.
 */

const tails = new Map();

const withLock = async (key, fn) => {
  const previous = tails.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Drop the entry once nobody is queued behind us, so the map doesn't grow.
    if (tails.get(key) === tail) tails.delete(key);
  }
};

module.exports = { withLock };
