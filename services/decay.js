/**
 * Periodic severity decay tick (PRD §6.2: "periodic decay tick").
 * One updateMany per tick, regardless of how many issues are open.
 */

const { refreshSeverityScores } = require('./issues');
const { isDbReady } = require('../config/db');

const DEFAULT_INTERVAL_MS = Number(process.env.SEVERITY_TICK_MS) || 10 * 60 * 1000;

const startDecayTicker = (intervalMs = DEFAULT_INTERVAL_MS) => {
  const tick = async () => {
    if (!isDbReady()) return;
    try {
      const updated = await refreshSeverityScores();
      if (updated) console.log(`[Severity] Decay tick refreshed ${updated} issue(s)`);
    } catch (err) {
      console.error('[Severity] Decay tick failed:', err.message);
    }
  };

  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref(); // never keeps the process alive on its own
  return () => clearInterval(timer);
};

module.exports = { startDecayTicker };
