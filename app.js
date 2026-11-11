/**
 * Express application (no network binding — see server.js).
 * Exported separately so tests can drive it without starting a server.
 */

const express = require('express');
const cors = require('cors');

const { isDbReady } = require('./config/db');
const telemetryRoutes = require('./routes/telemetry');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const issueRoutes = require('./routes/issues');

const app = express();

// Only trust X-Forwarded-For when running behind a known reverse proxy.
// Set TRUST_PROXY=1 (one hop, e.g. Nginx/Render) in production. Default: don't trust.
const trustProxy = process.env.TRUST_PROXY;
app.set('trust proxy', trustProxy ? (Number.isNaN(Number(trustProxy)) ? trustProxy : Number(trustProxy)) : false);
app.disable('x-powered-by');

app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

const allowedOrigins = (process.env.CLIENT_ORIGIN || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim());
app.use(
  cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
    credentials: !allowedOrigins.includes('*'),
  })
);

// Health check reports DB state so monitors can tell "up" from "up but useless".
app.get('/api/health', (req, res) => {
  const db = isDbReady() ? 'connected' : 'disconnected';
  res.status(db === 'connected' ? 200 : 503).json({
    status: db === 'connected' ? 'ok' : 'degraded',
    db,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Every v1 route needs the database: answer 503 immediately when it's down.
app.use('/api/v1', (req, res, next) => {
  if (!isDbReady()) {
    return res.status(503).json({ success: false, error: 'Database unavailable' });
  }
  return next();
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/issues', issueRoutes);
app.use('/api/v1/telemetry', telemetryRoutes);

app.use((req, res) => {
  res.status(404).json({ success: false, error: 'Endpoint not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ success: false, error: 'Malformed JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'Request body too large' });
  }
  console.error('[Unhandled Server Error]:', err);
  return res.status(500).json({ success: false, error: 'Internal server error' });
});

module.exports = app;
