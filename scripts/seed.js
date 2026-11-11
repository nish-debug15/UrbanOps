/**
 * Create (or update) privileged accounts. Public signup only makes citizens,
 * so this is how the first admin/dispatcher gets created.
 *
 *   npm run seed                                   → uses SEED_* env vars / defaults below
 *   npm run seed -- --email a@city.gov --password 'S3cret!!' --role admin --name "Asha"
 *
 * Re-running with an existing email resets that account's password and role.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { hashPassword } = require('../services/auth');

const parseArgs = (argv) => {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      args[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
};

const upsertUser = async ({ name, email, password, role }) => {
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`);
  if (!password || password.length < 8) throw new Error(`password for ${email} must be at least 8 characters`);

  const user = await User.findOneAndUpdate(
    { email: email.toLowerCase() },
    { name, role, passwordHash: await hashPassword(password) },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );
  console.log(`  ✓ ${user.role.padEnd(10)} ${user.email}`);
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await connectDB();

  if (args.email) {
    await upsertUser({
      name: args.name || args.email.split('@')[0],
      email: args.email,
      password: args.password,
      role: args.role || 'dispatcher',
    });
  } else {
    if (process.env.NODE_ENV === 'production' && !process.env.SEED_ADMIN_PASSWORD) {
      throw new Error('Set SEED_ADMIN_PASSWORD / SEED_DISPATCHER_PASSWORD in production');
    }
    console.log('Seeding default accounts (development):');
    await upsertUser({
      name: 'City Admin',
      email: process.env.SEED_ADMIN_EMAIL || 'admin@urbanops.local',
      password: process.env.SEED_ADMIN_PASSWORD || 'admin12345',
      role: 'admin',
    });
    await upsertUser({
      name: 'Dispatcher 804',
      email: process.env.SEED_DISPATCHER_EMAIL || 'dispatcher@urbanops.local',
      password: process.env.SEED_DISPATCHER_PASSWORD || 'dispatch12345',
      role: 'dispatcher',
    });
  }
};

main()
  .catch((err) => {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
