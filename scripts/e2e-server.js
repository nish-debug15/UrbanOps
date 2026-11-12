/**
 * API server for the browser end-to-end tests (frontend/e2e).
 *
 * Starts the real app against a throwaway database with known accounts, and with
 * the two outside dependencies replaced so the tests run offline and repeatably:
 *   - region lookup: every report is filed under Karnataka (no Nominatim calls)
 *   - email: captured in memory and readable at GET /__e2e/mails (never sent)
 *
 * It refuses to run against any database whose name doesn't end in "_e2e",
 * because it wipes that database on start.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PORT = process.env.PORT || '5055';
process.env.MONGO_URI = process.env.MONGO_E2E_URI || 'mongodb://127.0.0.1:27017/urbanops_e2e';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'e2e-only-secret-not-for-production';
process.env.CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3100';
process.env.AUTH_RATE_LIMIT = '10000';
process.env.REPORT_RATE_LIMIT = '10000';
process.env.BCRYPT_ROUNDS = '4';

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'urbanops-e2e-uploads-'));

const mongoose = require('mongoose');
const app = require('../app');
const { connectDB } = require('../config/db');
const { setResolver } = require('../services/regions');
const { setTransport } = require('../services/mailer');
const { hashPassword } = require('../services/auth');
const User = require('../models/User');
const { startServer } = require('../server');

const KARNATAKA = { key: 'india/karnataka', name: 'Karnataka, India' };

const ACCOUNTS = [
  { name: 'Platform Owner', email: 'superadmin@e2e.test', password: 'super12345', role: 'superadmin' },
  { name: 'Karnataka Admin', email: 'admin@e2e.test', password: 'admin12345', role: 'admin', region: KARNATAKA },
  { name: 'Dispatcher One', email: 'dispatcher@e2e.test', password: 'dispatch12345', role: 'dispatcher', region: KARNATAKA },
];

const main = async () => {
  const dbName = new URL(process.env.MONGO_URI).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_e2e')) {
    throw new Error(`Refusing to wipe database "${dbName}": the e2e database name must end in "_e2e"`);
  }

  setResolver(async () => KARNATAKA);
  const mails = [];
  setTransport({
    sendMail: async (mail) => {
      mails.push({ to: mail.to, subject: mail.subject, text: mail.text });
      return { messageId: `e2e-${mails.length}` };
    },
  });
  // Test-only inbox so the browser tests can read the emails the app "sent".
  const inbox = (req, res, next) => {
    if (req.method === 'GET' && req.url.startsWith('/__e2e/mails')) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      return res.end(JSON.stringify(mails));
    }
    return next();
  };
  app.use(inbox);
  // Move the inbox to the front so it runs before the JSON 404 handler.
  const stack = app._router ? app._router.stack : app.router.stack;
  stack.unshift(stack.pop());

  await connectDB();
  await mongoose.connection.dropDatabase();
  await connectDB(); // recreate collections + indexes after the wipe
  for (const a of ACCOUNTS) {
    // eslint-disable-next-line no-await-in-loop
    await User.create({
      name: a.name,
      email: a.email,
      passwordHash: await hashPassword(a.password),
      role: a.role,
      region: a.region?.key ?? null,
      regionName: a.region?.name ?? null,
    });
  }
  await mongoose.disconnect();

  await startServer();
};

main().catch((err) => {
  console.error('[e2e-server] failed to start:', err.message);
  process.exit(1);
});
