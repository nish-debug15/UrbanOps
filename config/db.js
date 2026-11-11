/**
 * MongoDB Connection Module
 *
 * Manages Mongoose connection lifecycle, environment resolution with local fallback,
 * event listeners for connection status, and graceful shutdown handling.
 */

const mongoose = require('mongoose');

const DEFAULT_FALLBACK_URI = 'mongodb://127.0.0.1:27017/urbanops';

// Fail queries immediately when disconnected instead of buffering them for 10s.
mongoose.set('bufferCommands', false);
mongoose.set('strictQuery', true);
// With buffering off, Mongoose's compile-time auto-init would run before a connection
// exists and cache the failure. We create collections + indexes explicitly in connectDB.
mongoose.set('autoCreate', false);
mongoose.set('autoIndex', false);

/** Create collections and indexes for every registered model (idempotent). */
const ensureIndexes = async () => {
  await Promise.all(
    Object.values(mongoose.models).map(async (model) => {
      await model.createCollection().catch((err) => {
        if (err.codeName !== 'NamespaceExists') throw err;
      });
      await model.createIndexes();
    })
  );
};

/**
 * Connect to MongoDB. Resolves URI from the argument, then MONGO_URI, then local fallback.
 *
 * @param {string} [uri]
 * @returns {Promise<typeof mongoose>}
 */
const connectDB = async (uri) => {
  const mongoURI = uri || process.env.MONGO_URI || DEFAULT_FALLBACK_URI;

  if (!uri && !process.env.MONGO_URI) {
    console.warn(`[Database] MONGO_URI not set. Falling back to ${DEFAULT_FALLBACK_URI}`);
  }

  const conn = await mongoose.connect(mongoURI, {
    serverSelectionTimeoutMS: 5000, // Fail quickly if host unreachable
  });

  // Indexes must exist before the first $geoNear query (requires 2dsphere),
  // and the unique email index must exist before the first signup.
  // Load every model first so none are skipped.
  require('../models');
  await ensureIndexes();

  console.log(`[Database] Connected: host=${conn.connection.host}, db=${conn.connection.name}`);
  return conn;
};

/** @returns {boolean} true when the connection can serve queries */
const isDbReady = () => mongoose.connection.readyState === 1;

/**
 * Lifecycle logging + graceful shutdown. Called by server.js only, so tests and
 * scripts that import this module don't install process signal handlers.
 */
const setupConnectionLifecycle = () => {
  const db = mongoose.connection;

  db.on('error', (err) => console.error('[Database] Connection error:', err.message));
  db.on('disconnected', () => console.warn('[Database] Disconnected from MongoDB.'));
  db.on('reconnected', () => console.log('[Database] Reconnected to MongoDB.'));

  const gracefulShutdown = async (signal) => {
    console.log(`\n[Database] Received ${signal}. Closing connection...`);
    try {
      await mongoose.connection.close(false);
      process.exit(0);
    } catch (err) {
      console.error('[Database] Error closing connection:', err.message);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
};

module.exports = {
  connectDB,
  isDbReady,
  setupConnectionLifecycle,
  mongoose,
  DEFAULT_FALLBACK_URI,
};
