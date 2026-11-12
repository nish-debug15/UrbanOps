/**
 * Auth routes
 *   POST /api/v1/auth/register          → citizen account (always citizen)
 *   POST /api/v1/auth/register-admin    → state admin account, requires an invite code
 *   POST /api/v1/auth/login             → { token, user, permissions }
 *   GET  /api/v1/auth/me                → current user + permissions
 *   POST /api/v1/auth/change-password   → { currentPassword, newPassword }
 *   POST /api/v1/auth/forgot-password   → { email }: emails a one-time reset link
 *   POST /api/v1/auth/reset-password    → { token, newPassword }: signs the user in
 *
 * Changing or resetting a password invalidates every token issued before it.
 *
 * How each role is created:
 *   citizen     self-registration
 *   admin       registers with an invite code issued by the superadmin (one state)
 *   dispatcher  created by their state's admin (temporary password, changed at first login)
 *   superadmin  only from the server: `npm run seed`
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const User = require('../models/User');
const {
  hashPassword,
  verifyPassword,
  signToken,
  createResetToken,
  hashResetToken,
  DUMMY_HASH,
} = require('../services/auth');
const { sendMail, passwordResetEmail } = require('../services/mailer');
const { claimInvite, releaseInvite } = require('../services/invites');
const { requireAuth } = require('../middleware/auth');
const { TRANSITIONS_BY_ROLE, atLeast } = require('../config/permissions');

const router = express.Router();

// Brute-force protection on credential endpoints (also covers invite-code guessing).
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
const validPassword = (p) => typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX;

/** What the UI may offer this user. The API enforces the same rules. */
const permissionsFor = (user) => ({
  transitions: TRANSITIONS_BY_ROLE[user.role] || {},
  canViewAllIssues: atLeast(user.role, 'dispatcher'),
  // Only citizens file reports; staff act on them.
  canReport: user.role === 'citizen',
  canManageStaff: user.role === 'admin' || user.role === 'superadmin',
  canInviteAdmins: user.role === 'superadmin',
  allRegions: user.role === 'superadmin',
});

const publicUser = (user) => ({
  _id: user._id,
  name: user.name,
  email: user.email,
  role: user.role,
  ward: user.ward,
  region: user.region || null,
  regionName: user.regionName || null,
  mustChangePassword: !!user.mustChangePassword,
});

const authResponse = (user) => ({
  success: true,
  token: signToken(user),
  user: publicUser(user),
  permissions: permissionsFor(user),
});

const validateAccountFields = ({ name, email, password }) => {
  const errors = [];
  if (!isNonEmptyString(name)) errors.push('name is required');
  if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) errors.push('a valid email is required');
  if (!validPassword(password)) errors.push(`password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  return errors;
};

const duplicateEmail = (res) =>
  res.status(409).json({ success: false, error: 'An account with this email already exists' });

router.post('/register', credentialLimiter, async (req, res, next) => {
  try {
    const { name, email, password, ward } = req.body || {};
    const errors = validateAccountFields({ name, email, password });
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
    if (err.code === 11000) return duplicateEmail(res);
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
    return next(err);
  }
});

router.post('/register-admin', credentialLimiter, async (req, res, next) => {
  let invite = null;
  try {
    const { code, name, email, password } = req.body || {};
    const errors = validateAccountFields({ name, email, password });
    if (!isNonEmptyString(code)) errors.push('invite code is required');
    if (errors.length) return res.status(400).json({ success: false, error: 'Validation failed', details: errors });

    const normalizedEmail = email.trim().toLowerCase();
    // Check the email first so a typo'd email doesn't burn the invite.
    if (await User.exists({ email: normalizedEmail })) return duplicateEmail(res);

    invite = await claimInvite(code);
    if (!invite) {
      // One message for unknown/used/expired/revoked: don't help anyone probe codes.
      return res.status(400).json({ success: false, error: 'This invite code is invalid, expired, or already used' });
    }

    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: await hashPassword(password),
      role: invite.role,
      region: invite.region,
      regionName: invite.regionName,
      createdBy: invite.createdBy,
    });
    invite.usedBy = user._id;
    await invite.save();

    return res.status(201).json(authResponse(user));
  } catch (err) {
    if (invite) await releaseInvite(invite._id).catch(() => undefined);
    if (err.code === 11000) return duplicateEmail(res);
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
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
  res.json({ success: true, user: publicUser(req.user), permissions: permissionsFor(req.user) });
});

router.post('/change-password', credentialLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !validPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: `currentPassword is required and newPassword must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
      });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ success: false, error: 'New password must be different from the current one' });
    }

    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return res.status(401).json({ success: false, error: 'Current password is incorrect' });
    }

    user.passwordHash = await hashPassword(newPassword);
    user.mustChangePassword = false;
    user.passwordChangedAt = new Date(); // older tokens stop working
    await user.save();
    return res.json(authResponse(user));
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- forgot / reset password

const FORGOT_RESPONSE = {
  success: true,
  message: 'If an account exists for that email, a reset link has been sent. It expires in 30 minutes.',
};

// Same answer whether or not the email exists, so this can't be used to find accounts.
router.post('/forgot-password', credentialLimiter, async (req, res, next) => {
  try {
    const { email } = req.body || {};
    if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'a valid email is required' });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (user) {
      const { token, hash, expires } = createResetToken();
      await User.updateOne({ _id: user._id }, { $set: { resetTokenHash: hash, resetTokenExpires: expires } });
      // Not awaited: the response time must not depend on whether the account exists.
      sendMail({ to: user.email, ...passwordResetEmail({ name: user.name, token, expiresAt: expires }) }).catch(() => undefined);
    }
    return res.json(FORGOT_RESPONSE);
  } catch (err) {
    return next(err);
  }
});

router.post('/reset-password', credentialLimiter, async (req, res, next) => {
  try {
    const { token, newPassword } = req.body || {};
    if (!isNonEmptyString(token) || !validPassword(newPassword)) {
      return res.status(400).json({
        success: false,
        error: `token is required and newPassword must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`,
      });
    }

    // Claim the token atomically: it works once, even if submitted twice at the same time.
    const user = await User.findOneAndUpdate(
      { resetTokenHash: hashResetToken(token.trim()), resetTokenExpires: { $gt: new Date() } },
      {
        $set: {
          passwordHash: await hashPassword(newPassword),
          mustChangePassword: false,
          passwordChangedAt: new Date(),
          resetTokenHash: null,
          resetTokenExpires: null,
        },
      },
      { new: true }
    );
    if (!user) {
      return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired. Request a new one.' });
    }
    return res.json(authResponse(user));
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
