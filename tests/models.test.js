const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const ngeohash = require('ngeohash');

const { connectTestDb, clearTestDb, dropTestDb } = require('./_db');
const User = require('../models/User');
const Issue = require('../models/Issue');

before(connectTestDb);
beforeEach(clearTestDb);
after(dropTestDb);

const MG_ROAD = [77.605, 12.975]; // [lng, lat]

test('Issue derives geohash and severity on save', async () => {
  const issue = await Issue.create({
    category: 'hazard',
    subcategory: 'Water leak',
    location: { type: 'Point', coordinates: MG_ROAD },
  });
  assert.equal(issue.geohash, ngeohash.encode(MG_ROAD[1], MG_ROAD[0], 9));
  assert.equal(issue.severityScore, 50);
  assert.equal(issue.status, 'open');
  assert.equal(issue.duplicateCount, 0);
});

test('Issue rejects out-of-range coordinates', async () => {
  await assert.rejects(
    Issue.create({ category: 'infra', location: { type: 'Point', coordinates: [200, 12] } }),
    /coordinates must be/
  );
});

test('Issue rejects unknown category and status', async () => {
  await assert.rejects(Issue.create({ category: 'banana', location: { coordinates: MG_ROAD } }), /category/);
  await assert.rejects(
    Issue.create({ category: 'infra', status: 'closed', location: { coordinates: MG_ROAD } }),
    /status/
  );
});

test('Issue collection has the PRD indexes', async () => {
  const indexes = await Issue.collection.indexes();
  const keys = indexes.map((i) => JSON.stringify(i.key));
  assert.ok(keys.includes(JSON.stringify({ location: '2dsphere' })), 'location 2dsphere');
  assert.ok(keys.includes(JSON.stringify({ geohash: 1 })), 'geohash');
  assert.ok(keys.includes(JSON.stringify({ status: 1, severityScore: -1 })), 'status+severity');
});

test('$geoNear finds issues within 100m and excludes farther ones', async () => {
  await Issue.create({ category: 'infra', location: { coordinates: MG_ROAD } });
  // ~1.1km north
  await Issue.create({ category: 'infra', location: { coordinates: [77.605, 12.985] } });

  const near = await Issue.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates: [77.6053, 12.9752] }, // ~40m away
        distanceField: 'distance',
        maxDistance: 100,
        spherical: true,
      },
    },
  ]);
  assert.equal(near.length, 1);
  assert.ok(near[0].distance < 100);
});

test('User email is unique, lowercased, and passwordHash is hidden', async () => {
  await User.init();
  const u = await User.create({ name: 'A', email: 'Disp@City.gov', passwordHash: 'x' });
  assert.equal(u.email, 'disp@city.gov');
  assert.equal(u.role, 'citizen');
  assert.equal(u.toJSON().passwordHash, undefined);

  const fetched = await User.findById(u._id);
  assert.equal(fetched.passwordHash, undefined);
  const withHash = await User.findById(u._id).select('+passwordHash');
  assert.equal(withHash.passwordHash, 'x');

  await assert.rejects(User.create({ name: 'B', email: 'disp@city.gov', passwordHash: 'y' }), /duplicate key/);
});

test('User rejects invalid role', async () => {
  await assert.rejects(User.create({ name: 'A', email: 'a@b.co', passwordHash: 'x', role: 'god' }), /role/);
});
