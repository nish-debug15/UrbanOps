process.env.AUTH_RATE_LIMIT = '1000';
process.env.REPORT_RATE_LIMIT = '1000';

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

// Photos written by these tests go to a throwaway folder, never the real ./uploads.
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'urbanops-masking-'));
process.env.UPLOAD_DIR = UPLOADS;

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { connectTestDb, clearTestDb, dropTestDb } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const Issue = require('../models/Issue');
const { signToken } = require('../services/auth');
const { publicImages } = require('../services/masking');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const BLURRED = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('faces-and-plates-blurred-by-the-fake')]);

// Stand-in for the Python service (./masking): same contract, no models.
//   'blur' → 200 + a "masked" image     'clean' → 204, nothing to hide     'down' → 500
const masker = { mode: 'blur', calls: [], server: null };
before(async () => {
  masker.server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      masker.calls.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) });
      if (masker.mode === 'down') return res.writeHead(500).end('boom');
      if (masker.mode === 'clean') return res.writeHead(204, { 'X-Faces': '0', 'X-Plates': '0' }).end();
      return res.writeHead(200, { 'Content-Type': 'image/jpeg', 'X-Faces': '1', 'X-Plates': '0' }).end(BLURRED);
    });
  });
  await new Promise((resolve) => { masker.server.listen(0, '127.0.0.1', resolve); });
  process.env.MASKING_URL = `http://127.0.0.1:${masker.server.address().port}/`;
  await connectTestDb();
});
beforeEach(async () => {
  await clearTestDb();
  fs.readdirSync(UPLOADS).forEach((name) => fs.rmSync(path.join(UPLOADS, name)));
  masker.mode = 'blur';
  masker.calls.length = 0;
  delete process.env.MASKING_TOKEN;
});
after(async () => {
  await dropTestDb();
  await new Promise((resolve) => { masker.server.close(resolve); });
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

const SPOT = { lat: 12.975, lng: 77.605 };
let seq = 0;
const makeUser = async (role = 'citizen') => {
  seq += 1;
  const scoped = role === 'dispatcher' || role === 'admin';
  const user = await User.create({
    name: `${role}${seq}`, email: `${role}${seq}@m.io`, passwordHash: 'x', role,
    ...(scoped && { region: 'india/karnataka', regionName: 'Karnataka, India' }),
  });
  return { user, auth: { Authorization: `Bearer ${signToken(user)}` } };
};

const reportWith = (auth, photos) => {
  let req = request(app).post('/api/v1/issues').set(auth)
    .field('subcategory', 'Water leak').field('lat', String(SPOT.lat)).field('lng', String(SPOT.lng));
  photos.forEach((buf, i) => { req = req.attach('photos', buf, { filename: `p${i}.jpg`, contentType: 'image/jpeg' }); });
  return req;
};
const fileCount = () => fs.readdirSync(UPLOADS).length;

describe('photo masking', () => {
  test('a report photo gets a masked copy; citizens only ever see that copy', async () => {
    const citizen = await makeUser();
    const res = await reportWith(citizen.auth, [JPEG]);
    assert.equal(res.status, 201);

    assert.equal(masker.calls.length, 1);
    assert.equal(masker.calls[0].url, '/mask');
    assert.deepEqual(masker.calls[0].body, JPEG, 'the service receives the uploaded bytes');

    const stored = (await Issue.findById(res.body.issue._id).lean()).images[0];
    assert.match(stored.original, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
    assert.match(stored.masked, /^\/uploads\/[0-9a-f]{32}\.jpg$/);
    assert.notEqual(stored.masked, stored.original);

    // The reporter (response, list, detail) and another citizen nearby get the masked path only.
    assert.deepEqual(res.body.issue.images, [{ masked: stored.masked }]);
    const mine = await request(app).get('/api/v1/issues/mine').set(citizen.auth);
    assert.deepEqual(mine.body.data[0].images, [{ masked: stored.masked }]);
    const other = await makeUser();
    const nearby = await request(app).get(`/api/v1/issues/nearby?lat=${SPOT.lat}&lng=${SPOT.lng}`).set(other.auth);
    assert.deepEqual(nearby.body.data[0].images, [{ masked: stored.masked }]);
    assert.ok(!JSON.stringify([res.body, mine.body, nearby.body]).includes(stored.original), 'the original path never reaches a citizen');

    // Staff get both.
    const dispatcher = await makeUser('dispatcher');
    const seen = await request(app).get(`/api/v1/issues/${res.body.issue._id}`).set(dispatcher.auth);
    assert.deepEqual(seen.body.issue.images, [{ original: stored.original, masked: stored.masked }]);

    const file = await request(app).get(stored.masked).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.deepEqual(file.body, BLURRED, 'the masked path serves what the masking service returned');
  });

  test('when there is nothing to hide, no second file is stored', async () => {
    masker.mode = 'clean';
    const citizen = await makeUser();
    const res = await reportWith(citizen.auth, [JPEG, PNG]);
    assert.equal(res.status, 201);
    assert.equal(fileCount(), 2);
    const { images } = await Issue.findById(res.body.issue._id).lean();
    images.forEach((img) => assert.equal(img.masked, img.original));
    assert.deepEqual(res.body.issue.images, images.map((img) => ({ masked: img.original })));
  });

  test('if the masking service is down the report is still accepted, and the photo is withheld from citizens', async () => {
    masker.mode = 'down';
    const citizen = await makeUser();
    const res = await reportWith(citizen.auth, [JPEG]);
    assert.equal(res.status, 201, 'a masking failure never loses a report');
    assert.deepEqual(res.body.issue.images, []);
    assert.equal(fileCount(), 1);

    const dispatcher = await makeUser('dispatcher');
    const seen = await request(app).get(`/api/v1/issues/${res.body.issue._id}`).set(dispatcher.auth);
    assert.equal(seen.body.issue.images.length, 1);
    assert.equal(seen.body.issue.images[0].masked, undefined);
    assert.match(seen.body.issue.images[0].original, /^\/uploads\//);
  });

  test('the shared token is sent when configured', async () => {
    process.env.MASKING_TOKEN = 's3cret';
    const citizen = await makeUser();
    await reportWith(citizen.auth, [JPEG]);
    assert.equal(masker.calls[0].auth, 'Bearer s3cret');
  });

  test('photos of the fix are masked too, and reopening deletes both copies', async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');
    const created = await request(app).post('/api/v1/issues').set(citizen.auth).send({ subcategory: 'Water leak', location: SPOT });
    const id = created.body.issue._id;
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched' });

    const resolved = await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth)
      .field('status', 'resolved').field('note', 'Pipe replaced')
      .attach('photos', JPEG, { filename: 'after.jpg', contentType: 'image/jpeg' });
    assert.equal(resolved.status, 200);
    const [after] = resolved.body.issue.resolutionImages;
    assert.ok(after.original && after.masked && after.masked !== after.original);
    assert.equal(fileCount(), 2);

    const seen = await request(app).get(`/api/v1/issues/${id}`).set(citizen.auth);
    assert.deepEqual(seen.body.issue.resolutionImages, [{ masked: after.masked }]);

    const reopened = await request(app).patch(`/api/v1/issues/${id}`).set(admin.auth).send({ status: 'open' });
    assert.equal(reopened.status, 200);
    await new Promise((resolve) => { setTimeout(resolve, 80); });
    assert.equal(fileCount(), 0, 'original and masked copy are both removed');
  });

  test('a rejected update leaves neither copy behind', async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const created = await request(app).post('/api/v1/issues').set(citizen.auth).send({ subcategory: 'Water leak', location: SPOT });
    // Photos of the fix are not allowed on an issue that is still open.
    const res = await request(app).patch(`/api/v1/issues/${created.body.issue._id}`).set(dispatcher.auth)
      .attach('photos', JPEG, { filename: 'after.jpg', contentType: 'image/jpeg' });
    assert.equal(res.status, 400);
    assert.equal(fileCount(), 0);
  });

  test('publicImages: masked only; unmasked photos are shown only when masking is off', () => {
    const images = [{ original: '/uploads/a.jpg', masked: '/uploads/b.jpg' }, { original: '/uploads/c.jpg' }];
    assert.deepEqual(publicImages(images), [{ masked: '/uploads/b.jpg' }]);
    const url = process.env.MASKING_URL;
    delete process.env.MASKING_URL;
    try {
      assert.deepEqual(publicImages(images), [{ masked: '/uploads/b.jpg' }, { original: '/uploads/c.jpg' }]);
      assert.deepEqual(publicImages(undefined), []);
    } finally {
      process.env.MASKING_URL = url;
    }
  });
});
