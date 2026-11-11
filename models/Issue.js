/**
 * Issue Model (PRD §7)
 *
 * location is a GeoJSON Point: coordinates are [longitude, latitude].
 */

const mongoose = require('mongoose');
const ngeohash = require('ngeohash');
const { ISSUE_CATEGORIES, ISSUE_STATUSES, GEOHASH_PRECISION } = require('../config/constants');
const { computeSeverity } = require('../services/severity');

const { Schema } = mongoose;

const PointSchema = new Schema(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (c) =>
          Array.isArray(c) &&
          c.length === 2 &&
          c[0] >= -180 && c[0] <= 180 &&
          c[1] >= -90 && c[1] <= 90,
        message: 'coordinates must be [longitude, latitude] within valid ranges',
      },
    },
  },
  { _id: false }
);

const ImageSchema = new Schema(
  {
    original: { type: String, required: true },
    masked: { type: String },
  },
  { _id: false }
);

const IssueSchema = new Schema(
  {
    category: { type: String, enum: ISSUE_CATEGORIES, required: true },
    subcategory: { type: String, trim: true, maxlength: 60 },
    description: { type: String, trim: true, maxlength: 2000 },
    address: { type: String, trim: true, maxlength: 200 },
    images: { type: [ImageSchema], default: [] },
    location: { type: PointSchema, required: true },
    geohash: { type: String, index: true },
    status: { type: String, enum: ISSUE_STATUSES, default: 'open' },
    duplicateCount: { type: Number, default: 0, min: 0 },
    reporterIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    lastReportedAt: { type: Date, default: Date.now },
    severityScore: { type: Number, default: 0 },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

IssueSchema.index({ location: '2dsphere' });
IssueSchema.index({ status: 1, severityScore: -1 });
IssueSchema.index({ status: 1, createdAt: -1 }); // ?sort=recent
IssueSchema.index({ reporterIds: 1, updatedAt: -1 }); // GET /issues/mine

IssueSchema.methods.recomputeSeverity = function recomputeSeverity(now = new Date()) {
  this.severityScore = computeSeverity(
    {
      category: this.category,
      duplicateCount: this.duplicateCount,
      lastReportedAt: this.lastReportedAt,
    },
    now
  );
  return this.severityScore;
};

// Keep derived fields (geohash, severity) consistent on every save.
IssueSchema.pre('validate', function deriveFields(next) {
  if (this.location?.coordinates?.length === 2 && (this.isNew || this.isModified('location'))) {
    const [lng, lat] = this.location.coordinates;
    this.geohash = ngeohash.encode(lat, lng, GEOHASH_PRECISION);
  }
  if (this.category) {
    this.recomputeSeverity();
  }
  next();
});

IssueSchema.set('toJSON', {
  transform: (_doc, ret) => {
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.models.Issue || mongoose.model('Issue', IssueSchema);
