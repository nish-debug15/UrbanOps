/**
 * In-process domain event bus. The issue service emits here; the Socket.io layer
 * (step 4) subscribes and fans events out to geohash rooms. Keeps HTTP/business
 * logic independent of the transport.
 *
 * Events:
 *   'issue:created'  (issue)
 *   'issue:updated'  (issue, { reason: 'duplicate' | 'status' | 'assignment' })
 */

const { EventEmitter } = require('events');

const issueEvents = new EventEmitter();
issueEvents.setMaxListeners(50);

module.exports = { issueEvents };
