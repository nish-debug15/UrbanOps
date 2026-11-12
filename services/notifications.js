/**
 * Citizen notifications: email the people who reported an issue when it is
 * dispatched or resolved.
 *
 * Listens on the in-process issue event bus, so the HTTP request that changed the
 * status never waits for (or fails because of) email. Staff who happened to report
 * the issue are notified like anyone else; the person who made the change is not.
 */

const User = require('../models/User');
const { issueEvents } = require('./events');
const { sendMail, issueStatusEmail } = require('./mailer');
const { isDbReady } = require('../config/db');

const NOTIFY_STATUSES = ['dispatched', 'resolved'];
// A viral issue can have thousands of reporters: cap one change's fan-out.
const MAX_RECIPIENTS = Number(process.env.NOTIFY_MAX_RECIPIENTS) || 200;

const enabled = () => process.env.NOTIFY_REPORTERS !== 'off';

const titleOf = (issue) => issue.subcategory || `${issue.category.charAt(0).toUpperCase()}${issue.category.slice(1)}`;
const refOf = (issue) => `INC-${String(issue._id).slice(-5).toUpperCase()}`;
const placeOf = (issue) => {
  if (issue.address) return issue.address;
  const [lng, lat] = issue.location?.coordinates || [];
  return Number.isFinite(lat) && Number.isFinite(lng) ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : '';
};

/**
 * Send the emails for one status change. Resolves with the number of emails accepted
 * by the mail transport. Never throws.
 *
 * @param {object} issue        the updated issue (lean)
 * @param {{ from: string, to: string }} change
 */
const notifyStatusChange = async (issue, change) => {
  try {
    if (!enabled() || !change || !NOTIFY_STATUSES.includes(change.to) || !isDbReady()) return 0;

    const actorId = issue.history?.length ? String(issue.history[issue.history.length - 1].by) : null;
    const ids = (issue.reporterIds || [])
      .map((id) => String(id._id || id))
      .filter((id) => id !== actorId)
      .slice(0, MAX_RECIPIENTS);
    if (!ids.length) return 0;

    const reporters = await User.find({ _id: { $in: ids } }).select('name email').lean();
    const common = {
      title: titleOf(issue),
      ref: refOf(issue),
      place: placeOf(issue),
      status: change.to,
      note: issue.resolutionNote || undefined,
    };
    const results = await Promise.all(
      reporters.map((r) => sendMail({ to: r.email, ...issueStatusEmail({ name: r.name, ...common }) }))
    );
    return results.filter((r) => r.sent).length;
  } catch (err) {
    console.error('[Notify] Could not notify reporters:', err.message);
    return 0;
  }
};

let listening = false;

/** Subscribe to issue events (idempotent). */
const startNotifications = () => {
  if (listening) return;
  listening = true;
  issueEvents.on('issue:updated', (issue, meta = {}) => {
    if (meta.change) notifyStatusChange(issue, meta.change);
  });
};

module.exports = { startNotifications, notifyStatusChange };
