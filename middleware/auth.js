/**
 * Authentication / authorization middleware.
 *
 * requireAuth   → verifies the Bearer JWT and loads the user (so role changes and
 *                 deleted accounts take effect immediately, not when the token expires).
 * optionalAuth  → same, but anonymous requests pass through with req.user = null.
 * requireRole   → 403 unless req.user.role is one of the allowed roles.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const { verifyToken, issuedBeforePasswordChange } = require('../services/auth');

const unauthorized = (res, error = 'Authentication required') =>
  res.status(401).json({ success: false, error });

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  return scheme === 'Bearer' && token ? token : null;
};

const authenticate = async (req) => {
  const token = extractToken(req);
  if (!token) return { user: null, error: null };

  let claims;
  try {
    claims = verifyToken(token);
  } catch (err) {
    return { user: null, error: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' };
  }

  if (!mongoose.isValidObjectId(claims.sub)) return { user: null, error: 'Invalid token' };

  const user = await User.findById(claims.sub).lean();
  if (!user) return { user: null, error: 'Account no longer exists' };
  if (issuedBeforePasswordChange(claims, user)) {
    return { user: null, error: 'Password was changed; please sign in again' };
  }
  return { user, error: null };
};

// Accounts created with a temporary password may only do this until they change it.
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['/api/v1/auth/me', '/api/v1/auth/change-password'];

const requireAuth = async (req, res, next) => {
  try {
    const { user, error } = await authenticate(req);
    if (!user) return unauthorized(res, error || undefined);
    if (user.mustChangePassword && !ALLOWED_BEFORE_PASSWORD_CHANGE.includes(req.originalUrl.split('?')[0])) {
      return res.status(403).json({
        success: false,
        code: 'PASSWORD_CHANGE_REQUIRED',
        error: 'Please set a new password before continuing',
      });
    }
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
};

const optionalAuth = async (req, res, next) => {
  try {
    const { user, error } = await authenticate(req);
    // A bad token is still an error: don't silently treat it as anonymous.
    if (error) return unauthorized(res, error);
    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return unauthorized(res);
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, error: 'Insufficient permissions' });
  }
  return next();
};

module.exports = { requireAuth, optionalAuth, requireRole };
