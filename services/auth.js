/**
 * Auth primitives: password hashing (bcrypt) and JWT signing/verification.
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const JWT_ISSUER = 'urbanops-api';

let devSecret;

/**
 * JWT secret. Required in production; in development a random per-process secret
 * is generated (tokens are invalidated on restart) so nothing insecure is hardcoded.
 */
const getJwtSecret = () => {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET must be set in production');
  }
  if (!devSecret) {
    devSecret = crypto.randomBytes(32).toString('hex');
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[Auth] JWT_SECRET not set. Using a random dev secret; tokens reset on restart.');
    }
  }
  return devSecret;
};

const hashPassword = (password) => bcrypt.hash(password, BCRYPT_ROUNDS);

const verifyPassword = (password, hash) => bcrypt.compare(password, hash);

// Compared against when the email doesn't exist, so a login for an unknown user
// takes as long as one for a real user (prevents account enumeration by timing).
const DUMMY_HASH = bcrypt.hashSync('urbanops-dummy-password', BCRYPT_ROUNDS);

/** @param {{ _id: any, role: string }} user */
const signToken = (user) =>
  jwt.sign({ role: user.role }, getJwtSecret(), {
    subject: String(user._id),
    expiresIn: JWT_EXPIRES_IN,
    issuer: JWT_ISSUER,
  });

/** @returns {{ sub: string, role: string }} throws on invalid/expired token */
const verifyToken = (token) =>
  jwt.verify(token, getJwtSecret(), { issuer: JWT_ISSUER, algorithms: ['HS256'] });

/**
 * True if the token was issued before the account's last password change, so a
 * stolen or forgotten session stops working as soon as the password is changed.
 * JWT `iat` is in whole seconds, so compare at that resolution: a token signed in
 * the same second as the change (the one handed back by change-password) stays valid.
 */
const issuedBeforePasswordChange = (claims, user) => {
  if (!user?.passwordChangedAt || typeof claims?.iat !== 'number') return false;
  return claims.iat < Math.floor(new Date(user.passwordChangedAt).getTime() / 1000);
};

// ---- self-service password reset tokens

const RESET_TOKEN_TTL_MS = (Number(process.env.RESET_TOKEN_MINUTES) || 30) * 60 * 1000;

const hashResetToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** @returns {{ token: string, hash: string, expires: Date }} token goes in the email, hash in the DB */
const createResetToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashResetToken(token), expires: new Date(Date.now() + RESET_TOKEN_TTL_MS) };
};

module.exports = {
  issuedBeforePasswordChange,
  createResetToken,
  hashResetToken,
  RESET_TOKEN_TTL_MS,
  getJwtSecret,
  hashPassword,
  verifyPassword,
  signToken,
  verifyToken,
  DUMMY_HASH,
};
