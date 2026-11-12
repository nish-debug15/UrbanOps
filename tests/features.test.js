process.env.AUTH_RATE_LIMIT = '1000';
process.env.REPORT_RATE_LIMIT = '1000';
process.env.BCRYPT_ROUNDS = '4';

const os = require('os');
const path = require('path');
const fs = require('fs');

// Photos written by these tests go to a throwaway folder, never the real ./uploads.
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'urbanops-uploads-'));
process.env.UPLOAD_DIR = UPLOADS;

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { connectTestDb, clearTestDb, dropTestDb, sentMails } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const Issue = require('../models/Issue');
const { signToken, hashPassword } = require('../services/auth');
const { lockKeysFor } = require('../services/issues');
const { withLocks } = require('../services/keyedMutex');
const { notifyStatusChange } = require('../services/notifications');
const { issueEvents } = require('../services/events');

before(connectTestDb);
beforeEach(async () => {
  await clearTestDb();
  sentMails.length = 0;
});
after(async () => {
  await dropTestDb();
  fs.rmSync(UPLOADS, { recursive: true, force: true });
});

const SPOT = { lat: 12.975, lng: 77.605 }; // MG Road, Bengaluru
const metersNorth = (m) => ({ lat: SPOT.lat + m / 111320, lng: SPOT.lng });

let seq = 0;
const makeUser = async (role = 'citizen', region = 'india/karnataka') => {
  seq += 1;
  const scoped = role === 'dispatcher' || role === 'admin';
  const user = await User.create({
    name: `${role}${seq}`, email: `${role}${seq}@f.io`, passwordHash: 'x', role,
    ...(scoped && { region, regionName: region }),
  });
  return { user, auth: { Authorization: `Bearer ${signToken(user)}` } };
};

const report = (auth, body) => request(app).post('/api/v1/issues').set(auth).send(body);
const leak = (location = SPOT) => ({ subcategory: 'Water leak', description: 'Pipe burst', location });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);

/** Wait for fire-and-forget work (emails) started by the previous request. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 60); });

describe('security headers', () => {
  test('helmet headers are set and the framework is not advertised', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['cross-origin-resource-policy'], 'cross-origin');
    assert.equal(res.headers['x-powered-by'], undefined);
  });
});

describe('report photos', () => {
  const multipart = (auth, photos, fields = {}) => {
    let req = request(app).post('/api/v1/issues').set(auth)
      .field('subcategory', fields.subcategory || 'Pothole')
      .field('lat', String(fields.lat ?? SPOT.lat))
      .field('lng', String(fields.lng ?? SPOT.lng));
    photos.forEach(([buf, name, type]) => { req = req.attach('photos', buf, { filename: name, contentType: type }); });
    return req;
  };

  test('multipart report stores photos and serves them back', async () => {
    const { auth } = await makeUser();
    const res = await multipart(auth, [[PNG, 'a.png', 'image/png'], [JPEG, 'b.jpg', 'image/jpeg']]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.issue.images.length, 2);
    assert.match(res.body.issue.images[0].original, /^\/uploads\/[0-9a-f]{32}\.png$/);
    assert.match(res.body.issue.images[1].original, /^\/uploads\/[0-9a-f]{32}\.jpg$/);

    const file = await request(app).get(res.body.issue.images[0].original);
    assert.equal(file.status, 200);
    assert.equal(file.headers['content-type'], 'image/png');
    assert.equal(Buffer.compare(file.body, PNG), 0);
  });

  test('a file that is not really an image is rejected, whatever it claims to be', async () => {
    const { auth } = await makeUser();
    const res = await multipart(auth, [[Buffer.from('<script>alert(1)</script> padding'), 'x.png', 'image/png']]);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /JPEG, PNG or WebP/);
    assert.equal(await Issue.countDocuments(), 0);
    assert.deepEqual(fs.readdirSync(UPLOADS).filter((f) => f.endsWith('.html')), []);
  });

  test('more than 3 photos is a 400 and nothing is stored', async () => {
    const { auth } = await makeUser();
    const before = fs.readdirSync(UPLOADS).length;
    const res = await multipart(auth, [1, 2, 3, 4].map((n) => [PNG, `${n}.png`, 'image/png']));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at most 3 photos/);
    assert.equal(fs.readdirSync(UPLOADS).length, before);
  });

  test('an invalid report with photos leaves no files behind', async () => {
    const { auth } = await makeUser();
    const before = fs.readdirSync(UPLOADS).length;
    const res = await multipart(auth, [[PNG, 'a.png', 'image/png']], { lat: 999 });
    assert.equal(res.status, 400);
    assert.equal(fs.readdirSync(UPLOADS).length, before);
  });

  test('photos on a duplicate report are added to the existing issue', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await multipart(a.auth, [[PNG, 'a.png', 'image/png']]);
    const second = await multipart(b.auth, [[JPEG, 'b.jpg', 'image/jpeg']]);
    assert.equal(second.body.merged, true);
    assert.equal(second.body.issue._id, first.body.issue._id);
    assert.equal(second.body.issue.images.length, 2);
  });

  test('unknown upload path is a JSON 404 and cannot escape the folder', async () => {
    assert.equal((await request(app).get('/uploads/nope.png')).status, 404);
    const res = await request(app).get('/uploads/..%2F..%2Fpackage.json');
    assert.ok([400, 403, 404].includes(res.status));
    assert.equal(res.body.name, undefined);
  });

  test('JSON reports still work', async () => {
    const { auth } = await makeUser();
    const res = await report(auth, leak());
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.issue.images, []);
  });
});

describe('nearby + confirm', () => {
  test('nearby lists open issues around a point, nearest first, public view only', async () => {
    const a = await makeUser();
    const b = await makeUser();
    await report(a.auth, leak(metersNorth(200)));
    await report(a.auth, { subcategory: 'Pothole', location: metersNorth(50) });
    await report(a.auth, { subcategory: 'Garbage', location: metersNorth(900) });

    const res = await request(app).get(`/api/v1/issues/nearby?lat=${SPOT.lat}&lng=${SPOT.lng}`).set(b.auth);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((i) => i.subcategory), ['Pothole', 'Water leak']);
    assert.ok(res.body.data[0].distance >= 45 && res.body.data[0].distance <= 55);
    assert.equal(res.body.data[0].reporterIds, undefined);
    assert.equal(res.body.data[0].history, undefined);
    assert.equal(res.body.data[0].reportedByMe, undefined);

    const mine = await request(app).get(`/api/v1/issues/nearby?lat=${SPOT.lat}&lng=${SPOT.lng}`).set(a.auth);
    assert.equal(mine.body.data[0].reportedByMe, true);
  });

  test('nearby skips resolved issues and validates input', async () => {
    const a = await makeUser();
    const admin = await makeUser('admin');
    const first = await report(a.auth, leak());
    await request(app).patch(`/api/v1/issues/${first.body.issue._id}`).set(admin.auth).send({ status: 'resolved' });

    const res = await request(app).get(`/api/v1/issues/nearby?lat=${SPOT.lat}&lng=${SPOT.lng}`).set(a.auth);
    assert.equal(res.body.data.length, 0);
    assert.equal((await request(app).get('/api/v1/issues/nearby?lat=abc&lng=1').set(a.auth)).status, 400);
    assert.equal((await request(app).get('/api/v1/issues/nearby?lat=1&lng=1&radius=-5').set(a.auth)).status, 400);
    assert.equal((await request(app).get('/api/v1/issues/nearby?lat=1&lng=1')).status, 401);
  });

  test('confirm adds the caller once and raises severity', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const first = await report(a.auth, leak());
    const id = first.body.issue._id;

    const res = await request(app).post(`/api/v1/issues/${id}/confirm`).set(b.auth);
    assert.equal(res.status, 200);
    assert.equal(res.body.alreadyReported, false);
    assert.equal(res.body.issue.reportCount, 2);
    assert.equal(res.body.issue.severityScore, 55);

    const again = await request(app).post(`/api/v1/issues/${id}/confirm`).set(b.auth);
    assert.equal(again.body.alreadyReported, true);
    assert.equal(again.body.issue.reportCount, 2);

    const listed = await request(app).get('/api/v1/issues/mine').set(b.auth);
    assert.equal(listed.body.data.length, 1);
  });

  test('confirm on a resolved or missing issue fails cleanly', async () => {
    const a = await makeUser();
    const admin = await makeUser('admin');
    const first = await report(a.auth, leak());
    const id = first.body.issue._id;
    await request(app).patch(`/api/v1/issues/${id}`).set(admin.auth).send({ status: 'resolved' });

    assert.equal((await request(app).post(`/api/v1/issues/${id}/confirm`).set(a.auth)).status, 409);
    assert.equal((await request(app).post('/api/v1/issues/000000000000000000000000/confirm').set(a.auth)).status, 404);
    assert.equal((await request(app).post('/api/v1/issues/nope/confirm').set(a.auth)).status, 400);
  });
});

describe('resolution notes', () => {
  test('a note given when resolving is stored, shown to the reporter, and cleared on reopen', async () => {
    const citizen = await makeUser();
    const admin = await makeUser('admin');
    const first = await report(citizen.auth, leak());
    const id = first.body.issue._id;

    const res = await request(app).patch(`/api/v1/issues/${id}`).set(admin.auth)
      .send({ status: 'resolved', note: '  Valve replaced and road patched.  ' });
    assert.equal(res.status, 200);
    assert.equal(res.body.issue.resolutionNote, 'Valve replaced and road patched.');
    assert.equal(res.body.issue.history.at(-1).note, 'Valve replaced and road patched.');

    const seen = await request(app).get(`/api/v1/issues/${id}`).set(citizen.auth);
    assert.equal(seen.body.issue.resolutionNote, 'Valve replaced and road patched.');
    assert.equal(seen.body.issue.history, undefined);

    const reopened = await request(app).patch(`/api/v1/issues/${id}`).set(admin.auth).send({ status: 'open' });
    assert.equal(reopened.body.issue.resolutionNote, null);
  });

  test('a note is refused unless the issue is being resolved, and is length-limited', async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const first = await report(citizen.auth, leak());
    const id = first.body.issue._id;

    const wrong = await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched', note: 'hi' });
    assert.equal(wrong.status, 400);
    const stored = await Issue.findById(id).lean();
    assert.equal(stored.status, 'open', 'the rejected request changed nothing');

    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched' });
    const long = await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth)
      .send({ status: 'resolved', note: 'x'.repeat(1001) });
    assert.equal(long.status, 400);
  });
});

describe('reporter notifications', () => {
  test('reporters are emailed on dispatch and on resolve (with the note), not the person who did it', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const first = await report(a.auth, leak());
    const id = first.body.issue._id;
    await request(app).post(`/api/v1/issues/${id}/confirm`).set(b.auth);
    await settle();
    assert.equal(sentMails.length, 0, 'reports and merges do not send email');

    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched' });
    await settle();
    assert.deepEqual(sentMails.map((m) => m.to).sort(), [a.user.email, b.user.email].sort());
    assert.match(sentMails[0].subject, /crew is on it/i);

    sentMails.length = 0;
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'resolved', note: 'Pipe <fixed> & sealed' });
    await settle();
    assert.equal(sentMails.length, 2);
    assert.match(sentMails[0].subject, /^Resolved:/);
    assert.match(sentMails[0].text, /What was done: Pipe <fixed> & sealed/);
    assert.match(sentMails[0].html, /Pipe &lt;fixed&gt; &amp; sealed/, 'note is HTML-escaped');
  });

  test('assignment changes and undoing a dispatch send nothing', async () => {
    const a = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const first = await report(a.auth, leak());
    const id = first.body.issue._id;
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched' });
    await settle();
    sentMails.length = 0;

    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ assignedTo: String(dispatcher.user._id) });
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'open' });
    await settle();
    assert.equal(sentMails.length, 0);
  });

  test('NOTIFY_REPORTERS=off disables it', async () => {
    const a = await makeUser();
    const issue = await Issue.create({
      category: 'hazard', location: { type: 'Point', coordinates: [SPOT.lng, SPOT.lat] }, reporterIds: [a.user._id],
    });
    process.env.NOTIFY_REPORTERS = 'off';
    try {
      assert.equal(await notifyStatusChange(issue.toObject(), { from: 'open', to: 'resolved' }), 0);
    } finally {
      delete process.env.NOTIFY_REPORTERS;
    }
    assert.equal(await notifyStatusChange(issue.toObject(), { from: 'open', to: 'resolved' }), 1);
  });
});

describe('staff do not file reports', () => {
  test('dispatchers, admins and superadmins cannot report or confirm; citizens can', async () => {
    const citizen = await makeUser();
    const first = await report(citizen.auth, leak());
    assert.equal(first.status, 201);

    for (const role of ['dispatcher', 'admin', 'superadmin']) {
      // eslint-disable-next-line no-await-in-loop
      const staff = await makeUser(role);
      // eslint-disable-next-line no-await-in-loop
      const filed = await report(staff.auth, leak(metersNorth(400)));
      assert.equal(filed.status, 403, role);
      assert.match(filed.body.error, /cannot report/);
      // eslint-disable-next-line no-await-in-loop
      const confirmed = await request(app).post(`/api/v1/issues/${first.body.issue._id}/confirm`).set(staff.auth);
      assert.equal(confirmed.status, 403, role);
      // eslint-disable-next-line no-await-in-loop
      const me = await request(app).get('/api/v1/auth/me').set(staff.auth);
      assert.equal(me.body.permissions.canReport, false, role);
    }

    assert.equal(await Issue.countDocuments(), 1);
    const stored = await Issue.findOne().lean();
    assert.equal(stored.duplicateCount, 0, 'staff attempts did not raise the severity');
    const me = await request(app).get('/api/v1/auth/me').set(citizen.auth);
    assert.equal(me.body.permissions.canReport, true);
  });
});

describe('photos of the fix', () => {
  const patchWithPhotos = (auth, id, fields, photos) => {
    let req = request(app).patch(`/api/v1/issues/${id}`).set(auth);
    Object.entries(fields).forEach(([k, v]) => { req = req.field(k, v); });
    photos.forEach((buf, i) => { req = req.attach('photos', buf, { filename: `after${i}.png`, contentType: 'image/png' }); });
    return req;
  };
  const setup = async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');
    const first = await report(citizen.auth, leak());
    const id = first.body.issue._id;
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'dispatched' });
    return { citizen, dispatcher, admin, id };
  };

  test('photos can be attached while resolving, and the reporter sees them', async () => {
    const { citizen, dispatcher, id } = await setup();
    const res = await patchWithPhotos(dispatcher.auth, id, { status: 'resolved', note: 'Pipe replaced' }, [PNG, JPEG]);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.issue.status, 'resolved');
    assert.equal(res.body.issue.resolutionNote, 'Pipe replaced');
    assert.equal(res.body.issue.resolutionImages.length, 2);
    assert.deepEqual(res.body.issue.images, [], 'the citizen\'s own photos are a separate list');

    const seen = await request(app).get(`/api/v1/issues/${id}`).set(citizen.auth);
    assert.equal(seen.body.issue.resolutionImages.length, 2);
    const file = await request(app).get(seen.body.issue.resolutionImages[0].original);
    assert.equal(file.status, 200);
  });

  test('more photos can be added after it is resolved, up to 6, and it is logged', async () => {
    const { dispatcher, id } = await setup();
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'resolved', note: 'Done' });

    const added = await patchWithPhotos(dispatcher.auth, id, {}, [PNG]);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.issue.resolutionImages.length, 1);
    assert.equal(added.body.issue.status, 'resolved');
    assert.equal(added.body.issue.history.at(-1).action, 'photos');

    await patchWithPhotos(dispatcher.auth, id, {}, [PNG, PNG, PNG]);
    const before = fs.readdirSync(UPLOADS).length;
    const tooMany = await patchWithPhotos(dispatcher.auth, id, {}, [PNG, PNG, PNG]);
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /at most 6/);
    assert.equal(fs.readdirSync(UPLOADS).length, before, 'rejected photos are not kept');
    assert.equal((await Issue.findById(id).lean()).resolutionImages.length, 4);
  });

  test('photos are refused on an issue that is not resolved, and nothing is stored', async () => {
    const { dispatcher, id } = await setup();
    const before = fs.readdirSync(UPLOADS).length;
    const res = await patchWithPhotos(dispatcher.auth, id, {}, [PNG]);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /only be added when resolving/);
    assert.equal(fs.readdirSync(UPLOADS).length, before);

    const fake = await patchWithPhotos(dispatcher.auth, id, { status: 'resolved' }, [Buffer.from('not an image at all....')]);
    assert.equal(fake.status, 400);
    assert.equal((await Issue.findById(id).lean()).status, 'dispatched', 'a bad photo does not resolve the issue');
  });

  test('reopening removes the photos of the old fix, from the issue and from disk', async () => {
    const { dispatcher, admin, id } = await setup();
    const res = await patchWithPhotos(dispatcher.auth, id, { status: 'resolved', note: 'Done' }, [PNG]);
    const name = path.basename(res.body.issue.resolutionImages[0].original);
    assert.ok(fs.existsSync(path.join(UPLOADS, name)));

    const reopened = await request(app).patch(`/api/v1/issues/${id}`).set(admin.auth).send({ status: 'open' });
    assert.deepEqual(reopened.body.issue.resolutionImages, []);
    await settle();
    assert.equal(fs.existsSync(path.join(UPLOADS, name)), false);
  });

  test('citizens cannot add them, and staff of another state cannot either', async () => {
    const { citizen, dispatcher, id } = await setup();
    await request(app).patch(`/api/v1/issues/${id}`).set(dispatcher.auth).send({ status: 'resolved' });
    const other = await makeUser('dispatcher', 'india/maharashtra');
    assert.equal((await patchWithPhotos(citizen.auth, id, {}, [PNG])).status, 403);
    assert.equal((await patchWithPhotos(other.auth, id, {}, [PNG])).status, 404);
    assert.equal((await Issue.findById(id).lean()).resolutionImages.length, 0);
  });
});

describe('analytics', () => {
  const analytics = (auth, query = '') => request(app).get(`/api/v1/issues/analytics${query}`).set(auth);

  test('admins get daily trends for their own state; dispatchers and citizens do not', async () => {
    const citizen = await makeUser();
    const other = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const admin = await makeUser('admin');

    const leakIssue = await report(citizen.auth, leak());
    await report(other.auth, leak(metersNorth(20))); // merged: 1 issue, 2 reports
    await report(citizen.auth, { subcategory: 'Pothole', location: metersNorth(500) });
    await report(citizen.auth, { subcategory: 'Garbage', location: { lat: 19.07, lng: 72.87 } }); // Maharashtra
    await request(app).patch(`/api/v1/issues/${leakIssue.body.issue._id}`).set(admin.auth).send({ status: 'resolved' });

    assert.equal((await analytics(citizen.auth)).status, 403);
    assert.equal((await analytics(dispatcher.auth)).status, 403);

    const res = await analytics(admin.auth, '?days=7');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const { data } = res.body;
    assert.equal(data.days, 7);
    assert.equal(data.daily.length, 7);
    assert.deepEqual(data.totals, { issues: 2, reports: 3, resolved: 1, avgResolutionHours: data.totals.avgResolutionHours });
    assert.ok(data.totals.avgResolutionHours >= 0);
    const today = data.daily.at(-1);
    assert.equal(today.date, new Date().toISOString().slice(0, 10));
    assert.deepEqual([today.issues, today.reports, today.resolved], [2, 3, 1]);
    assert.ok(data.daily.slice(0, -1).every((d) => d.issues === 0 && d.resolved === 0 && d.avgResolutionHours === null));
    assert.deepEqual(data.byCategory, { hazard: 1, infra: 1, minor: 0 });
    assert.equal(data.resolutionByCategory.hazard.resolved, 1);
    assert.deepEqual(data.topTypes.map((t) => t.name).sort(), ['Pothole', 'Water leak']);
    assert.equal(data.byRegion, null, 'a state admin gets no cross-state table');
  });

  test('superadmin sees every state, can narrow to one, and bad input is a 400', async () => {
    const citizen = await makeUser();
    const superadmin = await makeUser('superadmin');
    await report(citizen.auth, leak());
    await report(citizen.auth, { subcategory: 'Garbage', location: { lat: 19.07, lng: 72.87 } });

    const all = await analytics(superadmin.auth);
    assert.equal(all.body.data.days, 30);
    assert.equal(all.body.data.totals.issues, 2);
    assert.deepEqual(all.body.data.byRegion.map((r) => r.region).sort(), ['india/karnataka', 'india/maharashtra']);

    const one = await analytics(superadmin.auth, '?region=india/maharashtra&tz=Asia/Kolkata');
    assert.equal(one.body.data.totals.issues, 1);
    assert.equal(one.body.data.byRegion, null);
    assert.equal(one.body.data.timezone, 'Asia/Kolkata');

    assert.equal((await analytics(superadmin.auth, '?days=0')).status, 400);
    assert.equal((await analytics(superadmin.auth, '?days=2.5')).status, 400);
    assert.equal((await analytics(superadmin.auth, '?days=9999')).status, 400);
    assert.equal((await analytics(superadmin.auth, '?tz=Not/AZone')).status, 400);
  });
});

describe('password reset + token invalidation', () => {
  const makeAccount = async (email = 'reset@f.io') => {
    const user = await User.create({ name: 'Resetter', email, passwordHash: await hashPassword('old-password-1'), role: 'citizen' });
    return user;
  };
  const tokenFromMail = (mail) => decodeURIComponent(mail.text.match(/reset-password\?token=([0-9a-f]+)/)[1]);

  test('forgot-password answers the same for known and unknown emails, and only mails the known one', async () => {
    await makeAccount();
    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'RESET@f.io' });
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@f.io' });
    await settle();
    assert.equal(known.status, 200);
    assert.deepEqual(known.body, unknown.body);
    assert.equal(sentMails.length, 1);
    assert.equal(sentMails[0].to, 'reset@f.io');
    assert.equal((await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nope' })).status, 400);
  });

  test('the emailed link sets a new password once; old password and old sessions stop working', async () => {
    const user = await makeAccount();
    // A session from before the reset (issued two seconds earlier).
    const oldLogin = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'old-password-1' });
    const oldAuth = { Authorization: `Bearer ${oldLogin.body.token}` };
    assert.equal((await request(app).get('/api/v1/auth/me').set(oldAuth)).status, 200);

    await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
    await settle();
    const token = tokenFromMail(sentMails[0]);

    const stored = await User.findById(user._id).select('+resetTokenHash').lean();
    assert.notEqual(stored.resetTokenHash, token, 'only a hash of the token is stored');

    await new Promise((resolve) => { setTimeout(resolve, 1100); }); // cross a whole second (JWT iat resolution)
    const weak = await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'short' });
    assert.equal(weak.status, 400);

    const res = await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'new-password-2' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.token);
    assert.equal((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${res.body.token}` })).status, 200);

    const reuse = await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'another-pass-3' });
    assert.equal(reuse.status, 400, 'the link works once');

    const stale = await request(app).get('/api/v1/auth/me').set(oldAuth);
    assert.equal(stale.status, 401);
    assert.match(stale.body.error, /Password was changed/);

    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'old-password-1' })).status, 401);
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'new-password-2' })).status, 200);
  });

  test('an expired or made-up token is rejected', async () => {
    const user = await makeAccount();
    await request(app).post('/api/v1/auth/forgot-password').send({ email: user.email });
    await settle();
    const token = tokenFromMail(sentMails[0]);
    await User.updateOne({ _id: user._id }, { $set: { resetTokenExpires: new Date(Date.now() - 1000) } });

    assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'new-password-2' })).status, 400);
    assert.equal((await request(app).post('/api/v1/auth/reset-password').send({ token: 'f'.repeat(64), newPassword: 'new-password-2' })).status, 400);
    assert.equal((await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'old-password-1' })).status, 200);
  });

  test('change-password invalidates earlier tokens but the returned one works', async () => {
    const user = await makeAccount('change@f.io');
    const login = await request(app).post('/api/v1/auth/login').send({ email: user.email, password: 'old-password-1' });
    const oldAuth = { Authorization: `Bearer ${login.body.token}` };
    await new Promise((resolve) => { setTimeout(resolve, 1100); });

    const changed = await request(app).post('/api/v1/auth/change-password').set(oldAuth)
      .send({ currentPassword: 'old-password-1', newPassword: 'new-password-2' });
    assert.equal(changed.status, 200);
    assert.equal((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${changed.body.token}` })).status, 200);
    assert.equal((await request(app).get('/api/v1/auth/me').set(oldAuth)).status, 401);
  });
});

describe('report locking', () => {
  test('reports that could merge always share a lock; distant or different-category ones do not', () => {
    const at = (p) => [p.lng, p.lat];
    const shares = (a, b) => a.some((k) => b.includes(k));
    const here = lockKeysFor('hazard', at(SPOT));
    assert.ok(here.length >= 1 && here.length <= 16);

    // Every direction, right at the edge of the dedup radius.
    for (let deg = 0; deg < 360; deg += 15) {
      const rad = (deg * Math.PI) / 180;
      const p = {
        lat: SPOT.lat + (99 * Math.cos(rad)) / 111320,
        lng: SPOT.lng + (99 * Math.sin(rad)) / (111320 * Math.cos((SPOT.lat * Math.PI) / 180)),
      };
      assert.ok(shares(here, lockKeysFor('hazard', at(p))), `shares a lock at bearing ${deg}`);
    }

    assert.equal(shares(here, lockKeysFor('hazard', at(metersNorth(5000)))), false);
    assert.equal(shares(here, lockKeysFor('infra', at(SPOT))), false);
  });

  test('withLocks runs overlapping key sets one at a time, without deadlock', async () => {
    const order = [];
    const job = (name, keys, ms) => withLocks(keys, async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => { setTimeout(resolve, ms); });
      order.push(`${name}:end`);
    });
    await Promise.all([job('a', ['x', 'y'], 30), job('b', ['y', 'x'], 5), job('c', ['z'], 1)]);
    assert.ok(order.indexOf('a:end') < order.indexOf('b:start'), 'a and b never overlap');
    assert.ok(order.indexOf('c:end') < order.indexOf('a:end'), 'c is not held up by a');
  });

  test('30 simultaneous reports of one spot still produce exactly one issue', async () => {
    const users = await Promise.all(Array.from({ length: 30 }, () => makeUser()));
    const results = await Promise.all(users.map((u, i) => report(u.auth, leak(metersNorth(i % 2 ? 40 : -40)))));
    assert.ok(results.every((r) => r.status === 200 || r.status === 201));
    assert.equal(await Issue.countDocuments(), 1);
    const [issue] = await Issue.find().lean();
    assert.equal(issue.reporterIds.length, 30);
    assert.equal(issue.duplicateCount, 29);
  });
});

describe('events', () => {
  test('status changes carry { from, to } for subscribers; assignments do not', async () => {
    const citizen = await makeUser();
    const dispatcher = await makeUser('dispatcher');
    const first = await report(citizen.auth, leak());
    const seen = [];
    const listener = (issue, meta) => seen.push(meta);
    issueEvents.on('issue:updated', listener);
    try {
      await request(app).patch(`/api/v1/issues/${first.body.issue._id}`).set(dispatcher.auth).send({ status: 'dispatched' });
      await request(app).patch(`/api/v1/issues/${first.body.issue._id}`).set(dispatcher.auth).send({ assignedTo: null });
    } finally {
      issueEvents.off('issue:updated', listener);
    }
    assert.deepEqual(seen[0].change, { from: 'open', to: 'dispatched' });
    assert.equal(seen[1].change, undefined);
  });
});
