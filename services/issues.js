/**
 * Issue service: report intake with geospatial dedup (PRD §6.1), lifecycle
 * transitions (PRD §6.4), and severity decay refresh (PRD §6.2).
 */

const mongoose = require('mongoose');
const Issue = require('../models/Issue');
const User = require('../models/User');
const {
  CATEGORY_BASE_WEIGHTS,
  SUBCATEGORY_TO_CATEGORY,
  SEVERITY,
  DEDUP_RADIUS_METERS,
} = require('../config/constants');
const { computeSeverity, severityExpression } = require('./severity');
const { issueEvents } = require('./events');
const { withLock } = require('./keyedMutex');

class ServiceError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** Resolve the severity category from an explicit category or a subcategory label. */
const resolveCategory = ({ category, subcategory }) => {
  if (typeof category === 'string' && CATEGORY_BASE_WEIGHTS[category.toLowerCase()] !== undefined) {
    return category.toLowerCase();
  }
  if (typeof subcategory === 'string') {
    return SUBCATEGORY_TO_CATEGORY[subcategory.trim().toLowerCase()] || 'minor';
  }
  return null;
};

/**
 * Open (non-resolved) issue of the same category within the dedup radius.
 * Picks the OLDEST match rather than the nearest: the oldest issue is the stable
 * survivor that every concurrent reconcile agrees on, so merges never target a
 * document that is about to be folded away.
 */
const findNearbyOpen = async ({ category, coordinates, extraQuery = {} }) => {
  const [match] = await Issue.aggregate([
    {
      $geoNear: {
        near: { type: 'Point', coordinates },
        distanceField: 'distance',
        maxDistance: DEDUP_RADIUS_METERS,
        spherical: true,
        // Filter inside $geoNear so only candidate issues are returned.
        query: { category, status: { $ne: 'resolved' }, ...extraQuery },
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 1 },
    { $project: { _id: 1, distance: 1 } },
  ]);
  return match || null;
};

/**
 * Atomically fold one report into an existing issue. A single pipeline update
 * increments the count, adds the reporter, resets lastReportedAt and recomputes
 * severity — no read-modify-write race between concurrent reports.
 *
 * A reporter who already reported this issue doesn't inflate its severity.
 * Returns null if the issue was resolved/removed in the meantime.
 */
const mergeReportInto = async (issueId, { reporterId, category, images = [], now }) => {
  const reporter = new mongoose.Types.ObjectId(String(reporterId));
  const isNewReporter = { $not: [{ $in: [reporter, '$reporterIds'] }] };
  const base = CATEGORY_BASE_WEIGHTS[category];

  return Issue.findOneAndUpdate(
    { _id: issueId, status: { $ne: 'resolved' } },
    [
      {
        $set: {
          duplicateCount: { $cond: [isNewReporter, { $add: ['$duplicateCount', 1] }, '$duplicateCount'] },
          lastReportedAt: { $cond: [isNewReporter, now, '$lastReportedAt'] },
          reporterIds: { $setUnion: ['$reporterIds', [reporter]] },
          images: { $concatArrays: ['$images', images] },
          updatedAt: now,
        },
      },
      // lastReportedAt may be unchanged for a repeat reporter, so use the full formula.
      { $set: { severityScore: severityExpression(now) } },
    ],
    { new: true }
  ).lean();
};

/**
 * Submit a citizen report. Either merges into an existing nearby open issue of the
 * same category, or creates a new one.
 *
 * Concurrency:
 *  - Within one server process, "look for a duplicate, then insert" runs under a
 *    per-category lock, so simultaneous reports of the same pothole can't both miss
 *    and both insert. Each critical section is ~2 indexed queries.
 *  - Across multiple server instances (no shared lock), a post-insert reconcile
 *    folds a newer duplicate into the oldest matching issue. This is best-effort:
 *    a perfectly simultaneous cross-instance race can still leave two tickets.
 *
 * @returns {Promise<{ issue: object, merged: boolean, alreadyReported: boolean }>}
 */
const submitReport = (input) => withLock(`report:${input.category}`, () => submitReportUnlocked(input));

const submitReportUnlocked = async ({ category, subcategory, description, address, coordinates, reporterId, images = [] }) => {
  const now = new Date();

  // 1. Fast path: merge into an existing issue.
  const existing = await findNearbyOpen({ category, coordinates });
  if (existing) {
    const before = await Issue.findById(existing._id).select('reporterIds').lean();
    const merged = await mergeReportInto(existing._id, { reporterId, category, images, now });
    if (merged) {
      const alreadyReported = before?.reporterIds?.some((id) => String(id) === String(reporterId)) || false;
      if (!alreadyReported) issueEvents.emit('issue:updated', merged, { reason: 'duplicate' });
      return { issue: merged, merged: true, alreadyReported };
    }
    // Resolved between the lookup and the update: fall through and open a new issue.
  }

  // 2. No match: create.
  const created = await Issue.create({
    category,
    subcategory,
    description,
    address,
    images,
    location: { type: 'Point', coordinates },
    reporterIds: [reporterId],
    lastReportedAt: now,
  });

  // 3. Reconcile with any concurrent insert: oldest issue wins.
  const older = await findNearbyOpen({ category, coordinates, extraQuery: { _id: { $lt: created._id } } });
  if (older) {
    const merged = await mergeReportInto(older._id, { reporterId, category, images, now });
    if (merged) {
      await Issue.deleteOne({ _id: created._id });
      issueEvents.emit('issue:updated', merged, { reason: 'duplicate' });
      return { issue: merged, merged: true, alreadyReported: false };
    }
  }

  const issue = created.toObject();
  issueEvents.emit('issue:created', issue);
  return { issue, merged: false, alreadyReported: false };
};

// Kanban transitions (PRD §6.4). Forward moves plus one-step undo / reopen.
const ALLOWED_TRANSITIONS = Object.freeze({
  open: ['dispatched', 'resolved'],
  dispatched: ['resolved', 'open'],
  resolved: ['open'],
});

/**
 * Change status and/or assignee. Uses a conditional update on the status we
 * validated against, so two dispatchers moving the same card can't both win.
 */
const updateIssue = async (issueId, { status, assignedTo }) => {
  if (!mongoose.isValidObjectId(issueId)) throw new ServiceError(400, 'Invalid issue id');
  if (status === undefined && assignedTo === undefined) {
    throw new ServiceError(400, 'Provide status and/or assignedTo');
  }

  const current = await Issue.findById(issueId).select('status').lean();
  if (!current) throw new ServiceError(404, 'Issue not found');

  const set = { updatedAt: new Date() };
  const reasons = [];

  if (status !== undefined && status !== current.status) {
    const allowed = ALLOWED_TRANSITIONS[current.status] || [];
    if (!allowed.includes(status)) {
      throw new ServiceError(400, `Cannot move issue from ${current.status} to ${status}`, { allowed });
    }
    set.status = status;
    set.resolvedAt = status === 'resolved' ? new Date() : null;
    reasons.push('status');
  }

  if (assignedTo !== undefined) {
    if (assignedTo === null || assignedTo === '') {
      set.assignedTo = null;
    } else {
      if (!mongoose.isValidObjectId(assignedTo)) throw new ServiceError(400, 'Invalid assignedTo id');
      const assignee = await User.exists({ _id: assignedTo, role: { $in: ['dispatcher', 'admin'] } });
      if (!assignee) throw new ServiceError(400, 'assignedTo must be a dispatcher or admin');
      set.assignedTo = assignedTo;
    }
    reasons.push('assignment');
  }

  const updated = await Issue.findOneAndUpdate(
    { _id: issueId, status: current.status },
    { $set: set },
    { new: true, runValidators: true }
  )
    .populate('assignedTo', 'name email role')
    .lean();

  if (!updated) throw new ServiceError(409, 'Issue was changed by someone else; refresh and retry');

  issueEvents.emit('issue:updated', updated, { reason: reasons.join(',') });
  return updated;
};

/**
 * Refresh stored severity for all unresolved issues in one server-side update, so
 * the {status, severityScore} index keeps sorting correctly as scores decay.
 */
const refreshSeverityScores = async () => {
  const result = await Issue.updateMany({ status: { $ne: 'resolved' } }, [
    { $set: { severityScore: severityExpression('$$NOW') } },
  ]);
  return result.modifiedCount;
};

/** Live severity for display (stored value may be up to one decay tick old). */
const withLiveSeverity = (issue, now = new Date()) => ({
  ...issue,
  severityScore:
    issue.status === 'resolved'
      ? issue.severityScore
      : computeSeverity(
          { category: issue.category, duplicateCount: issue.duplicateCount, lastReportedAt: issue.lastReportedAt },
          now
        ),
  reportCount: (issue.duplicateCount || 0) + 1,
});

module.exports = {
  ServiceError,
  ALLOWED_TRANSITIONS,
  resolveCategory,
  findNearbyOpen,
  submitReport,
  updateIssue,
  refreshSeverityScores,
  withLiveSeverity,
  SEVERITY,
};
