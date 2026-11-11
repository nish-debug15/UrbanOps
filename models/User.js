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
  },
  { timestamps: true }
);

// Strip secrets from any JSON response
UserSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.models.User || mongoose.model('User', UserSchema);
