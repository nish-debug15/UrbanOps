/**
 * UrbanOps Backend entry point: connect to MongoDB, then bind the HTTP server.
 */

require('dotenv').config();

const http = require('http');
const app = require('./app');
const { connectDB, setupConnectionLifecycle } = require('./config/db');

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === 'production';

const { getJwtSecret } = require('./services/auth');
const { startDecayTicker } = require('./services/decay');
const { attachRealtime } = require('./realtime/socket');
const { maskingEnabled } = require('./services/masking');

const startServer = async () => {
  // Fail at boot (not on first login) if JWT_SECRET is missing in production.
  getJwtSecret();
  setupConnectionLifecycle();

  try {
    await connectDB();
  } catch (error) {
    console.error('[UrbanOps Server] MongoDB connection failed:', error.message);
    if (isProduction) {
      // In production, let the process manager restart us rather than serve 503s forever.
      process.exit(1);
    }
    console.warn('[UrbanOps Server] Dev mode: starting anyway. /api/v1 routes will return 503 until the DB is reachable.');
  }

  startDecayTicker();
  console.log(
    maskingEnabled()
      ? `[UrbanOps Server] Photo masking on (${process.env.MASKING_URL})`
      : '[UrbanOps Server] Photo masking off: set MASKING_URL to blur faces and number plates in report photos.'
  );

  const server = http.createServer(app);
  attachRealtime(server);
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `[UrbanOps Server] Port ${PORT} is already in use by another program.\n` +
          `  Fix: set a different PORT in .env (e.g. PORT=5001), or stop the program using port ${PORT}.`
      );
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, () => {
    console.log(`[UrbanOps Server] Listening on http://localhost:${PORT} (${process.env.NODE_ENV || 'development'}), live updates via Socket.io`);
  });
  return server;
};

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
