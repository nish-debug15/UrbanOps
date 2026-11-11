/**
 * Issue routes
 *
 *   POST  /api/v1/issues            any logged-in user: submit a report (dedup + severity)
 *   GET   /api/v1/issues            any logged-in user: list/map. Staff see full records,
 *                                   citizens see a public view (no reporter/assignee data)
 *   GET   /api/v1/issues/mine       issues the caller reported
 *   GET   /api/v1/issues/stats      staff: dashboard analytics
 *   GET   /api/v1/issues/:id        staff, or a citizen who reported it
 *   PATCH /api/v1/issues/:id        staff: { status?, assignedTo? }
 */

const express = require('express');
const mongoose = require('mongoose');
const { rateLimit } = require('express-rate-limit');

const Issue = require('../models/Issue');
const { ISSUE_STATUSES, ISSUE_CATEGORIES } = require('../config/constants');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  ServiceError,
  resolveCategory,
  submitReport,
  updateIssue,
  withLiveSeverity,
} = require('../services/issues');

const router = express.Router();
router.use(requireAuth);

const STAFF = ['dispatcher', 'admin'];
const isStaff = (user) => STAFF.includes(user.role);

const PUBLIC_FIELDS =
  'category subcategory description address location geohash status duplicateCount lastReportedAt severityScore createdAt updatedAt resolvedAt';

/** Strip fields citizens shouldn't see (other reporters' ids, staff assignments). */
const toView = (issue, user) => {
  const view = withLiveSeverity(issue);
  delete view.__v;
  if (!isStaff(user)) {
    const mine = (issue.reporterIds || []).some((id) => String(id) === String(user._id));
    delete view.reporterIds;
    delete view.assignedTo;
    if (mine) view.reportedByMe = true;
  }
  return view;
};

const sendError = (res, err, next) => {
  if (err instanceof ServiceError) {
    return res.status(err.status).json({ success: false, error: err.message, ...(err.details && { details: err.details }) });
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

router.post('/', reportLimiter, async (req, res, next) => {
  try {
    const { category, subcategory, description, address, location } = req.body || {};
    const errors = [];

    const resolved = resolveCategory({ category, subcategory });
    if (!resolved) errors.push('category or subcategory is required');

    const lat = toNumber(location?.lat);
    const lng = toNumber(location?.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) errors.push('location.lat must be a number between -90 and 90');
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) errors.push('location.lng must be a number between -180 and 180');

    for (const [field, value, max] of [['description', description, 2000], ['address', address, 200], ['subcategory', subcategory, 60]]) {
      if (value !== undefined && (typeof value !== 'string' || value.length > max)) {
        errors.push(`${field} must be a string of at most ${max} characters`);
      }
    }
    if (errors.length) return res.status(400).json({ success: false, error: 'Validation failed', details: errors });

    const { issue, merged, alreadyReported } = await submitReport({
      category: resolved,
      subcategory: subcategory?.trim(),
      description: description?.trim(),
      address: address?.trim(),
      coordinates: [lng, lat],
      reporterId: req.user._id,
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
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- GET /

router.get('/', async (req, res, next) => {
  try {
    const { page, limit } = parsePaging(req.query, 500); // map views need more than one page of 20
    const filter = {};

    const statuses = parseList(req.query.status, ISSUE_STATUSES, 'status') || ['open', 'dispatched'];
    filter.status = { $in: statuses };

    const categories = parseList(req.query.category, ISSUE_CATEGORIES, 'category');
    if (categories) filter.category = { $in: categories };

    if (req.query.assignedTo === 'me') filter.assignedTo = req.user._id;

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
    query = staff ? query.populate('assignedTo', 'name email role') : query.select(`${PUBLIC_FIELDS} reporterIds`);

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

// ---------------------------------------------------------------- GET /stats

router.get('/stats', requireRole(...STAFF), async (req, res, next) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [facets] = await Issue.aggregate([
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
    if (!issue || (!staff && !isReporter)) throw new ServiceError(404, 'Issue not found');

    return res.json({ success: true, issue: toView(issue, req.user) });
  } catch (err) {
    return sendError(res, err, next);
  }
});

// ---------------------------------------------------------------- PATCH /:id

router.patch('/:id', requireRole(...STAFF), async (req, res, next) => {
  try {
    const { status, assignedTo } = req.body || {};
    if (status !== undefined && !ISSUE_STATUSES.includes(status)) {
      throw new ServiceError(400, `status must be one of ${ISSUE_STATUSES.join(', ')}`);
    }
    const issue = await updateIssue(req.params.id, { status, assignedTo });
    return res.json({ success: true, issue: toView(issue, req.user) });
  } catch (err) {
    return sendError(res, err, next);
  }
});

module.exports = router;
