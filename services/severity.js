/**
 * Severity engine (PRD §6.2)
 *
 *   severity = baseWeight + (duplicateCount × multiplier) − (hoursSinceLastReport × decayRate)
 *
 * Floored at baseWeight. Pure function so any score is reproducible by hand.
 */

const { CATEGORY_BASE_WEIGHTS, SEVERITY } = require('../config/constants');

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * @param {object} input
 * @param {string} input.category        hazard | infra | minor
 * @param {number} input.duplicateCount  extra reports merged into this issue
 * @param {Date|string|number} input.lastReportedAt
 * @param {Date} [now]
 * @returns {number} score rounded to 2 decimals
 */
const computeSeverity = ({ category, duplicateCount = 0, lastReportedAt }, now = new Date()) => {
  const baseWeight = CATEGORY_BASE_WEIGHTS[category];
  if (baseWeight === undefined) {
    throw new Error(`Unknown issue category: ${category}`);
  }

  const last = lastReportedAt ? new Date(lastReportedAt).getTime() : now.getTime();
  const hoursSinceLastReport = Math.max(0, (now.getTime() - last) / MS_PER_HOUR);

  const raw =
    baseWeight +
    duplicateCount * SEVERITY.duplicateMultiplier -
    hoursSinceLastReport * SEVERITY.decayPerHour;

  return Math.round(Math.max(baseWeight, raw) * 100) / 100;
};

/**
 * The same formula as a MongoDB aggregation expression, so stored scores can be
 * refreshed for every open issue in a single updateMany (no per-document round trips).
 *
 * @param {*} nowExpr  a Date or '$$NOW'
 */
const severityExpression = (nowExpr = '$$NOW') => {
  const base = {
    $switch: {
      branches: Object.entries(CATEGORY_BASE_WEIGHTS).map(([category, weight]) => ({
        case: { $eq: ['$category', category] },
        then: weight,
      })),
      default: 0,
    },
  };
  const hours = {
    $max: [0, { $divide: [{ $subtract: [nowExpr, '$lastReportedAt'] }, MS_PER_HOUR] }],
  };
  const raw = {
    $subtract: [
      { $add: [base, { $multiply: ['$duplicateCount', SEVERITY.duplicateMultiplier] }] },
      { $multiply: [hours, SEVERITY.decayPerHour] },
    ],
  };
  return { $round: [{ $max: [base, raw] }, 2] };
};

module.exports = { computeSeverity, severityExpression, MS_PER_HOUR };
