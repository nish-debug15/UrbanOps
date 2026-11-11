const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeSeverity } = require('../services/severity');

const now = new Date('2026-01-01T12:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * 3600 * 1000);

test('fresh report scores its category base weight', () => {
  assert.equal(computeSeverity({ category: 'hazard', duplicateCount: 0, lastReportedAt: now }, now), 50);
  assert.equal(computeSeverity({ category: 'infra', duplicateCount: 0, lastReportedAt: now }, now), 30);
  assert.equal(computeSeverity({ category: 'minor', duplicateCount: 0, lastReportedAt: now }, now), 10);
});

test('each duplicate adds the multiplier (5)', () => {
  assert.equal(computeSeverity({ category: 'infra', duplicateCount: 4, lastReportedAt: now }, now), 50);
});

test('decays 0.5 per hour since last report', () => {
  // 30 + 4*5 - 10*0.5 = 45
  assert.equal(computeSeverity({ category: 'infra', duplicateCount: 4, lastReportedAt: hoursAgo(10) }, now), 45);
});

test('never drops below the base weight', () => {
  assert.equal(computeSeverity({ category: 'hazard', duplicateCount: 1, lastReportedAt: hoursAgo(500) }, now), 50);
});

test('future timestamps do not inflate the score', () => {
  assert.equal(computeSeverity({ category: 'minor', duplicateCount: 0, lastReportedAt: hoursAgo(-5) }, now), 10);
});

test('unknown category throws', () => {
  assert.throws(() => computeSeverity({ category: 'nope', lastReportedAt: now }, now), /Unknown issue category/);
});
