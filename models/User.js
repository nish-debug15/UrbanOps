/**
 * User Model (PRD §7)
 */

const mongoose = require('mongoose');
const { ROLES } = require('../config/constants');

const { Schema } = mongoose;

const UserSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: 100,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Email is invalid'],
    },
    // Never returned by default queries; opt in with .select('+passwordHash')
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: ROLES,
      default: 'citizen',
    },
    ward: {
      type: String,
      trim: true,
    },
    // Jurisdiction for dispatchers/admins, e.g. "india/karnataka". Unused for citizens/superadmin.
    region: { type: String, default: null },
    regionName: { type: String, default: null },
    // Set when an admin creates the account with a temporary password.
    mustChangePassword: { type: Boolean, default: false },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // Tokens issued before this moment are rejected (set on every password change).
    passwordChangedAt: { type: Date, default: null },
    // Self-service password reset: only the SHA-256 of the emailed token is stored.
    resetTokenHash: { type: String, default: null, select: false },
    resetTokenExpires: { type: Date, default: null, select: false },
  },
  { timestamps: true }
);

UserSchema.index({ region: 1, role: 1 });

// Strip secrets from any JSON response
UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.resetTokenHash;
    delete ret.resetTokenExpires;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
