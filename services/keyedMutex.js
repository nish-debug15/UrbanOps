/**
 * Minimal keyed async mutex: callers with the same key run one at a time, callers
 * with different keys run in parallel. Used to make "check for duplicate, then
 * insert" atomic per (category, area) within this process.
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

/**
 * Hold several locks at once. Keys are de-duplicated and always taken in sorted
 * order, so two callers with overlapping key sets can never deadlock.
 */
const withLocks = (keys, fn) => {
  const ordered = [...new Set(keys)].sort();
  const run = ordered.reduceRight((inner, key) => () => withLock(key, inner), fn);
  return run();
};

module.exports = { withLock, withLocks };
