/**
 * Staff management, scoped by state.
 *
 *   GET   /api/v1/users/dispatchers         staff: who can be assigned (same state)
 *   GET   /api/v1/users                     admin: own state's staff · superadmin: everyone
 *   POST  /api/v1/users/staff               admin/superadmin: create a dispatcher
 *                                           → returns a temporary password ONCE
 *   POST  /api/v1/users/:id/reset-password  admin (own-state dispatcher) / superadmin
 *   PATCH /api/v1/users/:id/role            admin: revoke own-state dispatcher (→ citizen)
 *                                           superadmin: set role (+ state) of anyone but self
 *
 * Superadmin accounts are never created or granted through the API (only `npm run seed`).
 */

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { requireAuth, requireRole } = require('../middleware/auth');
const { isScopedRole } = require('../config/permissions');
const { hashPassword } = require('../services/auth');
const { makeRegion, isValidRegionKey } = require('../services/regions');
const { sendMail, staffEmail } = require('../services/mailer');

const router = express.Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const bad = (res, error, status = 400) => res.status(status).json({ success: false, error });

/** Readable temporary password, e.g. "kq7m-x2fd-p9tn" (~60 bits). */
const temporaryPassword = () => {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const chars = Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Region from a body: superadmin passes { state, country } or { region, regionName }. */
const regionFromBody = (body) => {
  if (isNonEmptyString(body.state)) {
    const r = makeRegion(body.state, body.country || 'India');
    return r.key === 'unassigned' ? null : r;
  }
  if (isValidRegionKey(body.region) && isNonEmptyString(body.regionName)) {
    return { key: body.region, name: body.regionName.trim() };
  }
  return null;
};

// ---------------------------------------------------------------- assignable staff

router.get('/dispatchers', requireRole('dispatcher', 'admin', 'superadmin'), async (req, res, next) => {
  try {
    const region = req.user.role === 'superadmin' ? req.query.region : req.user.region;
    if (isScopedRole(req.user.role) && !region) return bad(res, 'Your account has no state assigned', 403);

    const filter = { role: { $in: ['dispatcher', 'admin'] } };
    if (region) filter.region = region;
    const users = await User.find(filter).select('name email role region regionName').sort({ name: 1 }).lean();
    return res.json({ success: true, data: users });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- list

router.get('/', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};

    if (req.user.role === 'admin') {
      // A state admin sees their own state's staff only (not citizens, not other states).
      if (!req.user.region) return bad(res, 'Your account has no state assigned', 403);
      filter.region = req.user.region;
      filter.role = { $in: ['dispatcher', 'admin'] };
    }

    if (req.query.role) {
      if (!ROLES.includes(req.query.role)) return bad(res, `role must be one of ${ROLES.join(', ')}`);
      if (req.user.role === 'admin' && !['dispatcher', 'admin'].includes(req.query.role)) {
        return bad(res, 'State admins can only list their staff', 403);
      }
      filter.role = req.query.role;
    }
    if (req.user.role === 'superadmin' && isNonEmptyString(req.query.region)) filter.region = req.query.region;

    // ?q= searches name or email (case-insensitive). Escaped: user text is never a regex.
    if (isNonEmptyString(req.query.q)) {
      const re = new RegExp(escapeRegex(req.query.q.trim().slice(0, 100)), 'i');
      filter.$or = [{ name: re }, { email: re }];
    }

    const [data, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    data.forEach((u) => delete u.__v);
    return res.json({ success: true, data, page, limit, total });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- create dispatcher

router.post('/staff', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const { name, email } = req.body || {};
    if (!isNonEmptyString(name)) return bad(res, 'name is required');
    if (!isNonEmptyString(email) || !EMAIL_RE.test(email.trim())) return bad(res, 'a valid email is required');

    let region;
    if (req.user.role === 'admin') {
      if (!req.user.region) return bad(res, 'Your account has no state assigned', 403);
      region = { key: req.user.region, name: req.user.regionName }; // admins can only staff their own state
    } else {
      region = regionFromBody(req.body || {});
      if (!region) return bad(res, 'state (and country) is required to create a dispatcher');
    }

    const password = temporaryPassword();
    const user = await User.create({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      role: 'dispatcher',
      region: region.key,
      regionName: region.name,
      mustChangePassword: true,
      createdBy: req.user._id,
    });

    const delivery = await sendMail({
      to: user.email,
      ...staffEmail({ name: user.name, temporaryPassword: password, regionName: region.name, createdBy: req.user.name }),
    });

    return res.status(201).json({
      success: true,
      user,
      temporaryPassword: password, // shown once; only the hash is stored
      emailed: delivery.sent,
      ...(delivery.error && { emailError: delivery.error }),
      ...(delivery.previewUrl && { previewUrl: delivery.previewUrl }),
      message: delivery.sent
        ? `Sign-in details emailed to ${user.email}. They must set a new password at first sign-in.`
        : 'Give these details to the dispatcher. They must set a new password at first sign-in.',
    });
  } catch (err) {
    if (err.code === 11000) return bad(res, 'An account with this email already exists', 409);
    if (err.name === 'ValidationError') return bad(res, err.message);
    return next(err);
  }
});

// ---------------------------------------------------------------- helpers for acting on one user

/** Load the target and check the actor may manage them. Returns [user] or sends an error. */
const loadManageable = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) return [null, bad(res, 'Invalid user id')];
  if (String(req.user._id) === id) return [null, bad(res, 'You cannot change your own account here')];

  const target = await User.findById(id);
  // Outside your remit looks the same as not existing.
  const notFound = () => [null, bad(res, 'User not found', 404)];
  if (!target) return notFound();
  if (target.role === 'superadmin') return notFound();
  if (req.user.role === 'admin' && !(target.role === 'dispatcher' && target.region === req.user.region)) {
    return notFound();
  }
  return [target, null];
};

// ---------------------------------------------------------------- reset password

router.post('/:id/reset-password', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const [target, sent] = await loadManageable(req, res);
    if (!target) return sent;
    if (target.role === 'citizen') return bad(res, 'Citizens reset their own password', 400);

    const password = temporaryPassword();
    target.passwordHash = await hashPassword(password);
    target.mustChangePassword = true;
    target.passwordChangedAt = new Date(); // signs the account out everywhere
    await target.save();

    const delivery = await sendMail({
      to: target.email,
      ...staffEmail({ name: target.name, temporaryPassword: password, regionName: target.regionName, createdBy: req.user.name, reason: 'reset' }),
    });
    return res.json({
      success: true,
      user: target,
      temporaryPassword: password,
      emailed: delivery.sent,
      ...(delivery.error && { emailError: delivery.error }),
      ...(delivery.previewUrl && { previewUrl: delivery.previewUrl }),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------------------------------------------------------------- change role

router.patch('/:id/role', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    const { role } = req.body || {};
    if (role === 'superadmin') return bad(res, 'Superadmins can only be created on the server', 403);
    if (!ROLES.includes(role)) return bad(res, `role must be one of ${ROLES.join(', ')}`);

    const [target, sent] = await loadManageable(req, res);
    if (!target) return sent;

    if (req.user.role === 'admin') {
      // State admins can only revoke their dispatchers' access.
      if (role !== 'citizen') return bad(res, 'State admins can only revoke dispatcher access (set to citizen)', 403);
    }

    if (role === 'citizen') {
      target.role = 'citizen';
      target.region = null;
      target.regionName = null;
    } else {
      // dispatcher/admin need a state: from the body, or keep the one they have.
      const region = regionFromBody(req.body || {}) || (target.region ? { key: target.region, name: target.regionName } : null);
      if (!region) return bad(res, `A ${role} must belong to a state: send state and country`);
      target.role = role;
      target.region = region.key;
      target.regionName = region.name;
    }
    await target.save();
    return res.json({ success: true, user: target });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
