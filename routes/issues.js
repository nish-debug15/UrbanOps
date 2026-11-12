/**
 * Issue routes
 *
 *   POST  /api/v1/issues            citizens: submit a report (dedup + severity).
 *                                   JSON, or multipart/form-data with up to 3 `photos`.
 *   GET   /api/v1/issues            staff: list/map of all issues (citizens: 403)
 *   GET   /api/v1/issues/mine       issues the caller reported
 *   GET   /api/v1/issues/nearby     any logged-in user: open issues around ?lat=&lng= (public view)
 *   GET   /api/v1/issues/stats      staff: dashboard totals
 *   GET   /api/v1/issues/analytics  admin/superadmin: trends over ?days= (default 30)
 *   GET   /api/v1/issues/:id        staff, or a citizen who reported it
 *   POST  /api/v1/issues/:id/confirm  citizens: "I see this too"
 *   PATCH /api/v1/issues/:id        staff: { status?, assignedTo?, note? }; allowed status moves
 *                                   depend on role (config/permissions.js). `note` only
 *                                   when resolving: what was done, shown to reporters.
 *                                   multipart/form-data with up to 3 `photos` adds "after"
 *                                   photos, when resolving or to an already resolved issue.
 *
 * Staff accounts cannot file or confirm reports: they act on issues, and a
 * dispatcher adding their own reports would inflate the severity they triage by.
 */

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const { rateLimit } = require('express-rate-limit');

const Issue = require('../models/Issue');
const { ISSUE_STATUSES, ISSUE_CATEGORIES, STAFF_ROLES } = require('../config/constants');
const { regionScope, inJurisdiction, JurisdictionError } = require('../config/permissions');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  ServiceError,
  resolveCategory,
  submitReport,
  confirmIssue,
  updateIssue,
  withLiveSeverity,
} = require('../services/issues');
const { saveImage, removeImage, MAX_IMAGE_BYTES, MAX_IMAGES_PER_REPORT } = require('../services/storage');
const { maskStored, publicImages } = require('../services/masking');

const router = express.Router();
router.use(requireAuth);

const STAFF = STAFF_ROLES;
const isStaff = (user) => STAFF.includes(user.role);

const PUBLIC_FIELDS =
  'category subcategory description address images location geohash status duplicateCount lastReportedAt severityScore createdAt updatedAt resolvedAt resolutionNote resolutionImages regionName';

/** Strip fields citizens shouldn't see (other reporters' ids, staff assignments, unmasked photos). */
const toView = (issue, user) => {
  const view = withLiveSeverity(issue);
  delete view.__v;
  if (!isStaff(user)) {
    const mine = (issue.reporterIds || []).some((id) => String(id) === String(user._id));
    delete view.reporterIds;
    delete view.assignedTo;
    delete view.history;
    view.images = publicImages(view.images);
    view.resolutionImages = publicImages(view.resolutionImages);
    if (mine) view.reportedByMe = true;
  }
  return view;
};

const sendError = (res, err, next) => {
  if (err instanceof ServiceError) {
    return res.status(err.status).json({ success: false, error: err.message, ...(err.details && { details: err.details }) });
  }
  if (err instanceof JurisdictionError) {
    return res.status(err.status).json({ success: false, error: err.message });
  }
  if (err.name === 'ValidationError' || err.name === 'CastError') {
    return res.status(400).json({ success: false, error: err.message });
  }
  return next(err);
};

const parsePaging = (query, maxLimit = 100) => ({
  page: Math.max(1, parseInt(query.page, 10) || 1),
  limit: Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || 20)),
});

const parseList = (value, allowed, name) => {
  if (value === undefined || value === '') return null;
  const items = String(value).split(',').map((s) => s.trim().toLowerCase());
  const bad = items.filter((s) => !allowed.includes(s));
  if (bad.length) throw new ServiceError(400, `Invalid ${name}: ${bad.join(', ')}`, { allowed });
  return items;
};

const toNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

// ---------------------------------------------------------------- POST /

// Per-user cap on report submissions (keyed by account, not IP).
const reportLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.REPORT_RATE_LIMIT) || 20,
  keyGenerator: (req) => String(req.user._id),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many reports, please wait a few minutes' },
});

// Photos are held in memory only until their bytes are checked and stored.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_REPORT, fields: 20, fieldSize: 16 * 1024 },
});

/** Parse multipart bodies (JSON bodies pass straight through) and turn upload errors into 4xx. */
const acceptPhotos = (req, res, next) =>
  upload.array('photos', MAX_IMAGES_PER_REPORT)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      const message = tooBig
        ? `Each photo must be at most ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
        : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
          ? `Attach at most ${MAX_IMAGES_PER_REPORT} photos, in the "photos" field`
          : 'Invalid upload';
      return res.status(tooBig ? 413 : 400).json({ success: false, error: message });
    }
    return next(err);
  });

/**
 * Store uploaded photos, each with its masked copy when masking is on
 * (services/masking.js). Every file written is added to `written`, so the caller
 * can delete them all if the request fails afterwards.
 * @returns {Promise<{ original: string, masked?: string }[]>}
 */
const storePhotos = async (files = [], written = []) => {
  const images = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop
    const original = await saveImage(file.buffer);
    written.push(original);
    // eslint-disable-next-line no-await-in-loop
    const masked = await maskStored(file.buffer, original);
    if (masked && masked !== original) written.push(masked);
    images.push({ original, ...(masked && { masked }) });
  }
  return images;
};

/** Multipart forms send flat strings: accept `lat`/`lng` fields or a JSON `location`. */
const readLocation = (body) => {
  let { location } = body;
  if (typeof location === 'string') {
    try {
      location = JSON.parse(location);
    } catch {
      location = undefined;
    }
  }
  return { lat: toNumber(location?.lat ?? body.lat), lng: toNumber(location?.lng ?? body.lng) };
};

const citizensOnly = (req, res, next) =>
  isStaff(req.user)
    ? res.status(403).json({ success: false, error: 'Staff accounts manage issues and cannot report them. Use a citizen account to report.' })
    : next();

router.post('/', citizensOnly, reportLimiter, acceptPhotos, async (req, res, next) => {
  const stored = [];
  try {
    const { category, subcategory, description, address } = req.body || {};
    const location = readLocation(req.body || {});
    const errors = [];

    const resolved = resolveCategory({ category, subcategory });
    if (!resolved) errors.push('category or subcategory is required');

    const { lat, lng } = location;
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('location.lat must be a number between -90 and 90');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('location.lng must be a number between -180 and 180');

    for (const [field, value, max] of [['description', description, 2000], ['address', address, 200], ['subcategory', subcategory, 60]]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
        errors.push(`${field} must be a string of at most ${max} characters`);
      }
    }
    if (errors.length) return res.status(400).json({ success: false, error: 'Validation failed', details: errors });

    // Store photos only once the rest of the report is known to be valid.
    const images = await storePhotos(req.files, stored);

    const { issue, merged, alreadyReported } = await submitReport({
      category: resolved,
      subcategory: subcategory?.trim(),
      description: description?.trim(),
      address: address?.trim(),
      coordinates: [lng, lat],
      reporterId: req.user._id,
      images,
    });

    return res.status(merged ? 200 : 201).json({
      success: true,
      merged,
      alreadyReported,
      message: merged
        ? alreadyReported
          ? 'You already reported this issue; it is being tracked.'
          : 'This issue was already reported nearby; your report was added to it.'
        : 'New issue created.',
      issue: toView(issue, req.user),
    });
  } catch (err) {
    // The report wasn't saved: don't leave its photos behind.
    await Promise.all(stored.map(removeImage));
    if (err.status === 400 && !(err instanceof ServiceError)) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /

// Citizens only see their own reports (/mine, /:id); the full list is for staff.
router.get('/', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { page, limit } = parsePaging(req.query, 500); // map views need more than one page of 20
    // Dispatchers/admins: own state only. Superadmin: all, optionally ?region=.
    const filter = { ...regionScope(req.user) };
    if (req.user.role === 'superadmin' && typeof req.query.region === 'string' && req.query.region) {
      filter.region = req.query.region;
    }

    const statuses = parseList(req.query.status, ISSUE_STATUSES, 'status') || ['open', 'dispatched'];
    filter.status = { $in: statuses };

    const categories = parseList(req.query.category, ISSUE_CATEGORIES, 'category');
    if (categories) filter.category = { $in: categories };

    if (req.query.assignedTo === 'me') filter.assignedTo = req.user._id;

    if (req.query.minSeverity !== undefined && req.query.minSeverity !== '') {
      const min = Number(req.query.minSeverity);
      if (!Number.isFinite(min) || min < 0) throw new ServiceError(400, 'minSeverity must be a non-negative number');
      filter.severityScore = { $gte: min };
    }

    // bbox=minLng,minLat,maxLng,maxLat → only issues inside the visible map area.
    if (req.query.bbox) {
      const parts = String(req.query.bbox).split(',').map(Number);
      const [minLng, minLat, maxLng, maxLat] = parts;
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n)) || minLng >= maxLng || minLat >= maxLat) {
        throw new ServiceError(400, 'bbox must be minLng,minLat,maxLng,maxLat');
      }
      filter.location = {
        $geoWithin: {
          $geometry: {
            type: 'Polygon',
            coordinates: [[[minLng, minLat], [maxLng, minLat], [maxLng, maxLat], [minLng, maxLat], [minLng, minLat]]],
          },
        },
      };
    }

    const sort = req.query.sort === 'recent' ? { createdAt: -1 } : { severityScore: -1, lastReportedAt: -1 };
    const staff = isStaff(req.user);

    let query = Issue.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);
    query = staff ? query.select('-history').populate('assignedTo', 'name email role') : query.select(`${PUBLIC_FIELDS} reporterIds`);

    const [docs, total] = await Promise.all([query.lean(), Issue.countDocuments(filter)]);
    const data = docs.map((d) => toView(d, req.user));

    return res.json({ success: true, data, page, limit, total });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /mine

router.get('/mine', async (req, res, next) => {
  try {
    const { page, limit } = parsePaging(req.query);
    const filter = { reporterIds: req.user._id };
    const [docs, total] = await Promise.all([
      Issue.find(filter).select(`${PUBLIC_FIELDS} reporterIds`).sort({ updatedAt: -1 })
        .skip((page - 1) * limit).limit(limit).lean(),
      Issue.countDocuments(filter),
    ]);
    // Even staff get the citizen view here: it's "my reports".
    const data = docs.map((d) => toView(d, { ...req.user, role: 'citizen' }));
    return res.json({ success: true, data, page, limit, total });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /nearby

const NEARBY_DEFAULT_METERS = 300;
const NEARBY_MAX_METERS = 1000;

// Shown on the report form so people can add themselves to an existing issue
// instead of describing it again. Everyone gets the public view, staff included.
router.get('/nearby', async (req, res, next) => {
  try {
    const lat = toNumber(req.query.lat);
    const lng = toNumber(req.query.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      throw new ServiceError(400, 'lat and lng are required numbers');
    }
    let radius = NEARBY_DEFAULT_METERS;
    if (req.query.radius !== undefined && req.query.radius !== '') {
      radius = Number(req.query.radius);
      if (!Number.isFinite(radius) || radius <= 0) throw new ServiceError(400, 'radius must be a positive number of meters');
      radius = Math.min(radius, NEARBY_MAX_METERS);
    }

    const docs = await Issue.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [lng, lat] },
          distanceField: 'distance',
          maxDistance: radius,
          spherical: true,
          query: { status: { $ne: 'resolved' } },
        },
      },
      { $limit: 10 },
      { $project: { history: 0, assignedTo: 0, region: 0, __v: 0 } },
    ]);

    const data = docs.map((d) => ({
      ...toView(d, { ...req.user, role: 'citizen' }),
      distance: Math.round(d.distance),
    }));
    return res.json({ success: true, data, radius });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /analytics

const ANALYTICS_DEFAULT_DAYS = 30;
const ANALYTICS_MAX_DAYS = 365;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const validTimeZone = (tz) => {
  if (typeof tz !== 'string' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** YYYY-MM-DD for a moment, in a time zone (matches $dateToString '%Y-%m-%d'). */
const dayKey = (date, timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

router.get('/analytics', requireRole('admin', 'superadmin'), async (req, res, next) => {
  try {
    let days = ANALYTICS_DEFAULT_DAYS;
    if (req.query.days !== undefined && req.query.days !== '') {
      days = Number(req.query.days);
      if (!Number.isInteger(days) || days < 1 || days > ANALYTICS_MAX_DAYS) {
        throw new ServiceError(400, `days must be a whole number from 1 to ${ANALYTICS_MAX_DAYS}`);
      }
    }
    const timezone = req.query.tz === undefined || req.query.tz === '' ? 'UTC' : req.query.tz;
    if (!validTimeZone(timezone)) throw new ServiceError(400, 'tz must be an IANA time zone, e.g. Asia/Kolkata');

    const scope = { ...regionScope(req.user) };
    const allRegions = req.user.role === 'superadmin' && !(typeof req.query.region === 'string' && req.query.region);
    if (req.user.role === 'superadmin' && !allRegions) scope.region = req.query.region;

    const now = new Date();
    const from = new Date(now.getTime() - (days - 1) * MS_PER_DAY);
    const dayOf = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone } });

    const [facets] = await Issue.aggregate([
      { $match: scope },
      {
        $facet: {
          created: [
            { $match: { createdAt: { $gte: from } } },
            // One issue can stand for many citizen reports: count both.
            { $group: { _id: dayOf('$createdAt'), issues: { $sum: 1 }, reports: { $sum: { $add: ['$duplicateCount', 1] } } } },
          ],
          resolved: [
            { $match: { status: 'resolved', resolvedAt: { $gte: from } } },
            {
              $group: {
                _id: dayOf('$resolvedAt'),
                count: { $sum: 1 },
                avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
              },
            },
          ],
          byCategory: [
            { $match: { createdAt: { $gte: from } } },
            { $group: { _id: '$category', count: { $sum: 1 } } },
          ],
          bySubcategory: [
            { $match: { createdAt: { $gte: from } } },
            { $group: { _id: { $ifNull: ['$subcategory', '$category'] }, count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 10 },
          ],
          resolution: [
            { $match: { status: 'resolved', resolvedAt: { $gte: from } } },
            {
              $group: {
                _id: '$category',
                count: { $sum: 1 },
                avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } },
              },
            },
          ],
          byRegion: [
            {
              $group: {
                _id: '$region',
                regionName: { $first: '$regionName' },
                active: { $sum: { $cond: [{ $ne: ['$status', 'resolved'] }, 1, 0] } },
                created: { $sum: { $cond: [{ $gte: ['$createdAt', from] }, 1, 0] } },
                resolved: {
                  $sum: { $cond: [{ $and: [{ $eq: ['$status', 'resolved'] }, { $gte: ['$resolvedAt', from] }] }, 1, 0] },
                },
              },
            },
            { $sort: { active: -1, _id: 1 } },
            { $limit: 50 },
          ],
        },
      },
    ]);

    const hours = (ms) => (ms === null || ms === undefined ? null : Math.round((ms / 3600000) * 10) / 10);
    const createdByDay = new Map(facets.created.map((d) => [d._id, d]));
    const resolvedByDay = new Map(facets.resolved.map((d) => [d._id, d]));

    // Every day in the window, including the ones where nothing happened.
    const daily = [];
    const seen = new Set();
    for (let i = 0; i < days; i += 1) {
      const date = dayKey(new Date(from.getTime() + i * MS_PER_DAY), timezone);
      if (seen.has(date)) continue; // a DST shift can map two steps to one calendar day
      seen.add(date);
      const c = createdByDay.get(date);
      const r = resolvedByDay.get(date);
      daily.push({
        date,
        issues: c?.issues || 0,
        reports: c?.reports || 0,
        resolved: r?.count || 0,
        avgResolutionHours: r ? hours(r.avgMs) : null,
      });
    }

    const byCategory = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, 0]));
    facets.byCategory.forEach((c) => { byCategory[c._id] = c.count; });

    const resolutionByCategory = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, { resolved: 0, avgHours: null }]));
    let resolvedTotal = 0;
    let resolvedMs = 0;
    facets.resolution.forEach((r) => {
      resolutionByCategory[r._id] = { resolved: r.count, avgHours: hours(r.avgMs) };
      resolvedTotal += r.count;
      resolvedMs += r.avgMs * r.count;
    });

    return res.json({
      success: true,
      data: {
        days,
        timezone,
        from: from.toISOString(),
        to: now.toISOString(),
        totals: {
          issues: daily.reduce((n, d) => n + d.issues, 0),
          reports: daily.reduce((n, d) => n + d.reports, 0),
          resolved: resolvedTotal,
          avgResolutionHours: resolvedTotal ? hours(resolvedMs / resolvedTotal) : null,
        },
        daily,
        byCategory,
        resolutionByCategory,
        topTypes: facets.bySubcategory.map((s) => ({ name: s._id, count: s.count })),
        // Per-state comparison: only meaningful when looking at more than one state.
        byRegion: allRegions
          ? facets.byRegion.map((r) => ({
              region: r._id,
              regionName: r.regionName || r._id,
              active: r.active,
              created: r.created,
              resolved: r.resolved,
            }))
          : null,
      },
    });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /stats

router.get('/stats', requireRole(...STAFF), async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const scope = { ...regionScope(req.user) };
    if (req.user.role === 'superadmin' && typeof req.query.region === 'string' && req.query.region) {
      scope.region = req.query.region;
    }
    const [facets] = await Issue.aggregate([
      { $match: scope },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          openByCategory: [
            { $match: { status: { $ne: 'resolved' } } },
            { $group: { _id: '$category', count: { $sum: 1 }, avgSeverity: { $avg: '$severityScore' } } },
          ],
          highPriority: [
            { $match: { status: { $ne: 'resolved' }, category: 'hazard' } },
            { $count: 'count' },
          ],
          assignedStaff: [
            { $match: { status: 'dispatched', assignedTo: { $ne: null } } },
            { $group: { _id: '$assignedTo' } },
            { $count: 'count' },
          ],
          resolvedToday: [{ $match: { status: 'resolved', resolvedAt: { $gte: startOfDay } } }, { $count: 'count' }],
          resolution: [
            { $match: { status: 'resolved', resolvedAt: { $ne: null } } },
            { $group: { _id: null, avgMs: { $avg: { $subtract: ['$resolvedAt', '$createdAt'] } } } },
          ],
          duplicatesMerged: [{ $group: { _id: null, total: { $sum: '$duplicateCount' } } }],
        },
      },
    ]);

    const byStatus = Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0]));
    facets.byStatus.forEach((s) => { byStatus[s._id] = s.count; });

    const openByCategory = Object.fromEntries(ISSUE_CATEGORIES.map((c) => [c, { count: 0, avgSeverity: 0 }]));
    facets.openByCategory.forEach((c) => {
      openByCategory[c._id] = { count: c.count, avgSeverity: Math.round(c.avgSeverity * 10) / 10 };
    });

    const avgMs = facets.resolution[0]?.avgMs;
    return res.json({
      success: true,
      data: {
        active: byStatus.open + byStatus.dispatched,
        byStatus,
        openByCategory,
        highPriority: facets.highPriority[0]?.count || 0,
        assignedStaff: facets.assignedStaff[0]?.count || 0,
        resolvedToday: facets.resolvedToday[0]?.count || 0,
        avgResolutionHours: avgMs ? Math.round((avgMs / 3600000) * 10) / 10 : null,
        duplicatesMerged: facets.duplicatesMerged[0]?.total || 0,
      },
    });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /:id

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) throw new ServiceError(400, 'Invalid issue id');
    const staff = isStaff(req.user);

    let query = Issue.findById(req.params.id);
    if (staff) query = query.populate('assignedTo', 'name email role').populate('reporterIds', 'name email');
    const issue = await query.lean();

    // 404 (not 403) for citizens asking about others' issues: don't confirm existence.
    const isReporter = issue?.reporterIds?.some((r) => String(r._id || r) === String(req.user._id));
    // Staff outside their state, or citizens asking about others' issues: 404, don't confirm existence.
    const canSee = issue && (staff ? inJurisdiction(req.user, issue.region) : isReporter);
    if (!canSee) throw new ServiceError(404, 'Issue not found');

    return res.json({ success: true, issue: toView(issue, req.user) });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- POST /:id/confirm

router.post('/:id/confirm', citizensOnly, reportLimiter, async (req, res, next) => {
  try {
    const { issue, alreadyReported } = await confirmIssue(req.params.id, req.user._id);
    return res.json({
      success: true,
      alreadyReported,
      message: alreadyReported
        ? 'You already reported this issue; it is being tracked.'
        : 'Thanks: you were added to this issue, which raises its priority.',
      issue: toView(issue, { ...req.user, role: 'citizen' }),
    });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- PATCH /:id

const NOTE_MAX = 1000;

router.patch('/:id', requireRole(...STAFF), acceptPhotos, async (req, res, next) => {
  const stored = [];
  try {
    const { status, assignedTo } = req.body || {};
    let { note } = req.body || {};
    if (status !== undefined && !ISSUE_STATUSES.includes(status)) {
      throw new ServiceError(400, `status must be one of ${ISSUE_STATUSES.join(', ')}`);
    }
    if (note !== undefined && note !== null) {
      if (typeof note !== 'string' || note.length > NOTE_MAX) {
        throw new ServiceError(400, `note must be a string of at most ${NOTE_MAX} characters`);
      }
      note = note.trim() || undefined;
    } else {
      note = undefined;
    }
    const resolutionImages = await storePhotos(req.files, stored);
    const issue = await updateIssue(
      req.params.id,
      { status, assignedTo, note, resolutionImages },
      req.user
    );
    return res.json({ success: true, issue: toView(issue, req.user) });
  } catch (err) {
    // Nothing was saved on the issue: don't leave the photos behind.
    await Promise.all(stored.map(removeImage));
    if (err.status === 400 && !(err instanceof ServiceError)) {
      return res.status(400).json({ success: false, error: err.message });
    }
    return sendError(res, err, next);
  }
});

module.exports = router;
