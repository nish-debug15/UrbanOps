const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../app');
const RawData = require('../models/RawData');
const { connectTestDb, dropTestDb } = require('./_db');

describe('with database down', () => {
  test('health reports degraded with 503', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 503);
    assert.equal(res.body.db, 'disconnected');
  });

  test('v1 routes fail fast with 503 (no 10s hang)', async () => {
    const started = Date.now();
    const res = await request(app)
      .post('/api/v1/telemetry/ingest')
      .send({ source: 's', eventType: 'e', payload: {} });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started < 1000, 'responds immediately');
  });
});

describe('with database up', () => {
  before(connectTestDb);
  after(dropTestDb);

  test('health is ok', async () => {
    const res = await request(app).get('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.db, 'connected');
  });

  test('unknown route returns JSON 404', async () => {
    const res = await request(app).get('/api/v1/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.success, false);
  });

  test('malformed JSON returns 400, not 500', async () => {
    const res = await request(app)
      .post('/api/v1/telemetry/ingest')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Malformed JSON/);
  });

  test('telemetry validates required fields', async () => {
    const res = await request(app).post('/api/v1/telemetry/ingest').send({ eventType: 'x' });
    assert.equal(res.status, 400);
    assert.ok(res.body.missing.some((f) => f.includes('source')));
    assert.ok(res.body.missing.some((f) => f.includes('payload')));
  });

  test('telemetry persists a document and ignores spoofed X-Forwarded-For', async () => {
    const res = await request(app)
      .post('/api/v1/telemetry/ingest')
      .set('X-Forwarded-For', '203.0.113.195')
      .set('User-Agent', 'UrbanOps Test Agent')
      .send({ source: 'urbanops-web', eventType: 'REPORT_SUBMITTED', payload: { a: 1 } });
    assert.equal(res.status, 201);

    const doc = await RawData.findById(res.body.data.id).lean();
    assert.equal(doc.source, 'urbanops-web');
    assert.deepEqual(doc.payload, { a: 1 });
    assert.equal(doc.metadata.userAgent, 'UrbanOps Test Agent');
    assert.notEqual(doc.metadata.ipAddress, '203.0.113.195', 'proxy header must not be trusted by default');
  });

  test('telemetry is rate limited per IP', async () => {
    const limit = Number(process.env.TELEMETRY_RATE_LIMIT) || 60;
    const body = { source: 's', eventType: 'e', payload: 1 };
    let last;
    // One request was already used above; send enough to cross the limit.
    for (let i = 0; i < limit + 1; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app).post('/api/v1/telemetry/ingest').send(body);
    }
    assert.equal(last.status, 429);
    assert.equal(mongoose.connection.readyState, 1);
  });
});
