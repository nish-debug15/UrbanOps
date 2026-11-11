process.env.AUTH_RATE_LIMIT = '1000'; // keep the brute-force limiter out of functional tests
process.env.BCRYPT_ROUNDS = '4'; // fast hashing in tests

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { connectTestDb, clearTestDb, dropTestDb } = require('./_db');
const app = require('../app');
const User = require('../models/User');
const { hashPassword, signToken, getJwtSecret } = require('../services/auth');

before(connectTestDb);
beforeEach(clearTestDb);
after(dropTestDb);

const register = (body) => request(app).post('/api/v1/auth/register').send(body);
const login = (body) => request(app).post('/api/v1/auth/login').send(body);

const makeUser = async (role, email = `${role}@city.gov`) => {
  const user = await User.create({ name: role, email, passwordHash: await hashPassword('password123'), role });
  return { user, token: signToken(user) };
};

describe('register', () => {
  test('creates a citizen and returns a token, never the hash', async () => {
    const res = await register({ name: 'Asha', email: 'Asha@Mail.com', password: 'password123' });
    assert.equal(res.status, 201);
    assert.ok(res.body.token);
    assert.equal(res.body.user.email, 'asha@mail.com');
    assert.equal(res.body.user.role, 'citizen');
    assert.equal(res.body.user.passwordHash, undefined);

    const stored = await User.findOne({ email: 'asha@mail.com' }).select('+passwordHash');
    assert.notEqual(stored.passwordHash, 'password123');
    assert.match(stored.passwordHash, /^\$2[aby]\$/);
  });

  test('ignores a client-supplied role (no self-promotion)', async () => {
    const res = await register({ name: 'X', email: 'x@mail.com', password: 'password123', role: 'admin' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'citizen');
  });

  test('validates input', async () => {
    const res = await register({ name: '', email: 'not-an-email', password: 'short' });
    assert.equal(res.status, 400);
    assert.equal(res.body.details.length, 3);
  });

  test('rejects duplicate email with 409 (case-insensitive)', async () => {
    await register({ name: 'A', email: 'dup@mail.com', password: 'password123' });
    const res = await register({ name: 'B', email: 'DUP@mail.com', password: 'password123' });
    assert.equal(res.status, 409);
  });

  test('rejects a non-string email without crashing', async () => {
    const res = await register({ name: 'A', email: { $gt: '' }, password: 'password123' });
    assert.equal(res.status, 400);
  });
});

describe('login', () => {
  beforeEach(() => register({ name: 'Asha', email: 'asha@mail.com', password: 'password123' }));

  test('succeeds with correct credentials', async () => {
    const res = await login({ email: 'ASHA@mail.com', password: 'password123' });
    assert.equal(res.status, 200);
    const claims = jwt.verify(res.body.token, getJwtSecret());
    assert.equal(claims.role, 'citizen');
    assert.equal(claims.sub, res.body.user._id);
  });

  test('same 401 message for wrong password and unknown email', async () => {
    const wrong = await login({ email: 'asha@mail.com', password: 'nope-nope' });
    const unknown = await login({ email: 'ghost@mail.com', password: 'password123' });
    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.equal(wrong.body.error, unknown.body.error);
  });

  test('NoSQL-injection style payload is rejected', async () => {
    const res = await login({ email: { $ne: null }, password: { $ne: null } });
    assert.equal(res.status, 400);
  });
});

describe('requireAuth via /me', () => {
  test('401 without a token', async () => {
    const res = await request(app).get('/api/v1/auth/me');
    assert.equal(res.status, 401);
  });

  test('401 with a garbage or forged token', async () => {
    const garbage = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer abc.def.ghi');
    assert.equal(garbage.status, 401);

    const forged = jwt.sign({ role: 'admin' }, 'wrong-secret', { subject: '507f1f77bcf86cd799439011', issuer: 'urbanops-api' });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`);
    assert.equal(res.status, 401);
  });

  test('401 with an expired token', async () => {
    const { user } = await makeUser('citizen');
    const expired = jwt.sign({ role: 'citizen' }, getJwtSecret(), {
      subject: String(user._id), issuer: 'urbanops-api', expiresIn: -10,
    });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Token expired');
  });

  test('returns the current user without the hash', async () => {
    const { token } = await makeUser('dispatcher');
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'dispatcher');
    assert.equal(res.body.user.passwordHash, undefined);
  });

  test('a deleted account is rejected even with a valid token', async () => {
    const { user, token } = await makeUser('citizen');
    await User.deleteOne({ _id: user._id });
    const res = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    assert.equal(res.status, 401);
  });
});

describe('role-gated user management', () => {
  test('citizens and dispatchers cannot list users; admins can', async () => {
    const { token: citizen } = await makeUser('citizen');
    const { token: dispatcher } = await makeUser('dispatcher');
    const { token: admin } = await makeUser('admin');

    assert.equal((await request(app).get('/api/v1/users').set('Authorization', `Bearer ${citizen}`)).status, 403);
    assert.equal((await request(app).get('/api/v1/users').set('Authorization', `Bearer ${dispatcher}`)).status, 403);

    const res = await request(app).get('/api/v1/users?role=citizen').set('Authorization', `Bearer ${admin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    assert.equal(res.body.data[0].passwordHash, undefined);
  });

  test('dispatchers can list assignable staff; citizens cannot', async () => {
    const { token: citizen } = await makeUser('citizen');
    const { token: dispatcher } = await makeUser('dispatcher');
    await makeUser('admin');

    assert.equal((await request(app).get('/api/v1/users/dispatchers').set('Authorization', `Bearer ${citizen}`)).status, 403);
    const res = await request(app).get('/api/v1/users/dispatchers').set('Authorization', `Bearer ${dispatcher}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.map((u) => u.role).sort(), ['admin', 'dispatcher']);
  });

  test('admin promotes a citizen; the new role applies to their existing token immediately', async () => {
    const { user, token: citizenToken } = await makeUser('citizen');
    const { token: admin } = await makeUser('admin');

    const res = await request(app)
      .patch(`/api/v1/users/${user._id}/role`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ role: 'dispatcher' });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'dispatcher');

    const staff = await request(app).get('/api/v1/users/dispatchers').set('Authorization', `Bearer ${citizenToken}`);
    assert.equal(staff.status, 200);
  });

  test('role change validates input and blocks self-demotion', async () => {
    const { user: adminUser, token: admin } = await makeUser('admin');
    const auth = { Authorization: `Bearer ${admin}` };

    assert.equal((await request(app).patch('/api/v1/users/not-an-id/role').set(auth).send({ role: 'admin' })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/users/${adminUser._id}/role`).set(auth).send({ role: 'god' })).status, 400);
    assert.equal((await request(app).patch(`/api/v1/users/${adminUser._id}/role`).set(auth).send({ role: 'citizen' })).status, 400);
    assert.equal((await request(app).patch('/api/v1/users/507f1f77bcf86cd799439011/role').set(auth).send({ role: 'admin' })).status, 404);
  });
});
