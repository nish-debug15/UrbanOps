/**
 * Shared test DB helpers. Uses a dedicated database that is dropped after each file,
 * so the dev `urbanops` database is never touched.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');

const TEST_URI = process.env.MONGO_TEST_URI || 'mongodb://127.0.0.1:27017/urbanops_test';

const connectTestDb = async () => {
  await connectDB(TEST_URI);
};

const clearTestDb = async () => {
  const { collections } = mongoose.connection;
  await Promise.all(Object.values(collections).map((c) => c.deleteMany({})));
};

const dropTestDb = async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
};

module.exports = { connectTestDb, clearTestDb, dropTestDb, TEST_URI };
