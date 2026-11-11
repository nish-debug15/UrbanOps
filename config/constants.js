/**
 * Domain constants. Tunable values can be overridden via environment variables
 * so the severity formula can be adjusted without code changes (PRD §6.2).
 */

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const ROLES = Object.freeze(['citizen', 'dispatcher', 'admin']);

const ISSUE_STATUSES = Object.freeze(['open', 'dispatched', 'resolved']);

// Category -> base severity weight (PRD §6.2)
const CATEGORY_BASE_WEIGHTS = Object.freeze({
  hazard: 50,
  infra: 30,
  minor: 10,
});

const ISSUE_CATEGORIES = Object.freeze(Object.keys(CATEGORY_BASE_WEIGHTS));

// User-facing subcategory -> severity category. Used by the report form.
const SUBCATEGORY_TO_CATEGORY = Object.freeze({
  'road hazard': 'hazard',
  'water leak': 'hazard',
  'fallen tree': 'hazard',
  pothole: 'infra',
  'street light': 'infra',
  'broken sidewalk': 'infra',
  garbage: 'minor',
  graffiti: 'minor',
  other: 'minor',
});

const SEVERITY = Object.freeze({
  duplicateMultiplier: num(process.env.SEVERITY_DUP_MULTIPLIER, 5),
  decayPerHour: num(process.env.SEVERITY_DECAY_PER_HOUR, 0.5),
});

const DEDUP_RADIUS_METERS = num(process.env.DEDUP_RADIUS_METERS, 100);

// Full precision stored on the document; live-update rooms use a shorter prefix.
const GEOHASH_PRECISION = 9;
const GEOHASH_ROOM_PRECISION = num(process.env.GEOHASH_ROOM_PRECISION, 5); // ~4.9km cells

module.exports = {
  ROLES,
  ISSUE_STATUSES,
  ISSUE_CATEGORIES,
  CATEGORY_BASE_WEIGHTS,
  SUBCATEGORY_TO_CATEGORY,
  SEVERITY,
  DEDUP_RADIUS_METERS,
  GEOHASH_PRECISION,
  GEOHASH_ROOM_PRECISION,
};
