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

  const server = http.createServer(app);
  server.listen(PORT, () => {
    console.log(`[UrbanOps Server] Listening on http://localhost:${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
  return server;
};

if (require.main === module) {
  startServer();
}

module.exports = { startServer };
