/**
 * Auth routes
 *   POST /api/v1/auth/register  → create a citizen account, returns { token, user }
 *   POST /api/v1/auth/login     → returns { token, user }
 *   GET  /api/v1/auth/me        → current user
 *
 * Public registration always creates a citizen. Dispatchers/admins are created by
 * an admin (PATCH /api/v1/users/:id/role) or by `npm run seed`.
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const User = require('../models/User');
const { hashPassword, verifyPassword, signToken, DUMMY_HASH } = require('../services/auth');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Brute-force protection on credential endpoints.
const credentialLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT) || 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, try again later' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 72; // bcrypt ignores bytes beyond 72

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const authResponse = (user) => ({
  success: true,
  token: signToken(user),
  user: { _id: user._id, name: user.name, email: user.email, role: user.role, ward: user.ward },
});

router.post('/register', credentialLimiter, async (req, res, next) => {
  try {
    const { name, email, password, ward } = req.body || {};
    const errors = [];
    if (!isNonEmptyString(name)) errors.push('name is required');
    if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) errors.push('a valid email is required');
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      errors.push(`password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
    }
    if (errors.length) return res.status(400).json({ success: false, error: 'Validation failed', details: errors });

    const user = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      role: 'citizen', // never trust a client-supplied role
      ward: isNonEmptyString(ward) ? ward.trim() : undefined,
    });

    return res.status(201).json(authResponse(user));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: 'An account with this email already exists' });
    }
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, error: err.message });
    }
    return next(err);
  }
});

router.post('/login', credentialLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!isNonEmptyString(email) || typeof password !== 'string' || password === '') {
      return res.status(400).json({ success: false, error: 'email and password are required' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() }).select('+passwordHash');
    // Always run bcrypt so response time doesn't reveal whether the email exists.
    const valid = await verifyPassword(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !valid) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    return res.json(authResponse(user));
  } catch (err) {
    return next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  const { passwordHash, __v, ...user } = req.user;
  res.json({ success: true, user });
});

module.exports = router;
