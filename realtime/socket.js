/**
 * Live update service (PRD §6.3): Socket.io with geohash-prefix rooms.
 *
 * Connection:  io(url, { auth: { token: '<JWT>' } })   — rejected without a valid token.
 *
 * Staff (dispatcher/admin):
 *   emit('subscribe', { bbox: [minLng, minLat, maxLng, maxLat] }, ack)
 *     → server joins the socket to every geohash cell (precision 5, ~4.9km) covering
 *       the box, replacing any previous subscription. ack({ ok, rooms }).
 *   receives 'issue:created' (issue) and 'issue:updated' ({ issue, reason })
 *     only for issues inside their cells — never a global broadcast.
 *
 * Citizens:
 *   automatically joined to their personal room and receive 'issue:updated' for
 *   issues they reported (public view only).
 */

const { Server } = require('socket.io');
const ngeohash = require('ngeohash');
const mongoose = require('mongoose');

const User = require('../models/User');
const { verifyToken, issuedBeforePasswordChange } = require('../services/auth');
const { issueEvents } = require('../services/events');
const { withLiveSeverity } = require('../services/issues');
const { publicImages } = require('../services/masking');
const { corsOptions } = require('../config/cors');
const { GEOHASH_ROOM_PRECISION, STAFF_ROLES } = require('../config/constants');

const STAFF = STAFF_ROLES;
const SUPERADMIN_ROOM = 'superadmins';

/** Room a staff socket joins on connect: its state, or all states for superadmin. */
const staffDefaultRoom = (user) => {
  if (user.role === 'superadmin') return SUPERADMIN_ROOM;
  if (['dispatcher', 'admin'].includes(user.role) && user.region) return `region:${user.region}`;
  return null;
};

/** Geohash cell room, namespaced by state for scoped staff so areas never leak across states. */
const scopedCellRoom = (user, cellRoom) => (user.role === 'superadmin' ? cellRoom : `r:${user.region}|${cellRoom}`);
const MAX_ROOMS_PER_SOCKET = 400; // a whole city at precision 5 is ~60 cells

const geoRoom = (geohash) => `gh:${geohash.slice(0, GEOHASH_ROOM_PRECISION)}`;
const userRoom = (id) => `user:${id}`;

const publicView = (issue) => {
  const view = withLiveSeverity(issue);
  delete view.reporterIds;
  delete view.assignedTo;
  delete view.history;
  delete view.__v;
  view.images = publicImages(view.images);
  view.resolutionImages = publicImages(view.resolutionImages);
  return view;
};

const staffView = (issue) => {
  const view = withLiveSeverity(issue);
  delete view.__v;
  return view;
};

/** Validate a bbox and return the geohash rooms covering it. */
const roomsForBbox = (bbox) => {
  if (!Array.isArray(bbox) || bbox.length !== 4) return { error: 'bbox must be [minLng, minLat, maxLng, maxLat]' };
  const [minLng, minLat, maxLng, maxLat] = bbox.map(Number);
  if (
    [minLng, minLat, maxLng, maxLat].some((n) => !Number.isFinite(n)) ||
    minLng >= maxLng || minLat >= maxLat ||
    minLat < -90 || maxLat > 90 || minLng < -180 || maxLng > 180
  ) {
    return { error: 'bbox values are out of range' };
  }
  // Estimate the cell count arithmetically BEFORE enumerating: ngeohash.bboxes on a
  // huge box would build millions of strings (a whole-world box is ~33M cells).
  const bits = 5 * GEOHASH_ROOM_PRECISION;
  const cellWidth = 360 / 2 ** Math.ceil(bits / 2);
  const cellHeight = 180 / 2 ** Math.floor(bits / 2);
  const estimate = (Math.ceil((maxLng - minLng) / cellWidth) + 1) * (Math.ceil((maxLat - minLat) / cellHeight) + 1);
  if (estimate > MAX_ROOMS_PER_SOCKET) {
    return { error: `Area too large (~${estimate} cells, max ${MAX_ROOMS_PER_SOCKET}); zoom in` };
  }

  const cells = ngeohash.bboxes(minLat, minLng, maxLat, maxLng, GEOHASH_ROOM_PRECISION);
  return { rooms: cells.map((c) => `gh:${c}`) };
};

const attachRealtime = (httpServer) => {
  const io = new Server(httpServer, { cors: corsOptions });

  // ---- auth handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required'));
      const claims = verifyToken(token);
      if (!mongoose.isValidObjectId(claims.sub)) return next(new Error('Invalid token'));
      const user = await User.findById(claims.sub).select('name role region mustChangePassword passwordChangedAt').lean();
      if (!user) return next(new Error('Account no longer exists'));
      if (issuedBeforePasswordChange(claims, user)) return next(new Error('Password was changed; please sign in again'));
      socket.data.user = user;
      return next();
    } catch (err) {
      return next(new Error(err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { user } = socket.data;
    socket.join(userRoom(user._id));

    // Default ("whole jurisdiction") mode: staff hear every event in their scope.
    const defaultRoom = staffDefaultRoom(user);
    if (defaultRoom) socket.join(defaultRoom);

    // Area mode (live map): narrow to geohash cells of the visible bbox, still
    // within the user's state. Replaces the default room and any previous area.
    socket.on('subscribe', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!STAFF.includes(user.role)) return reply({ ok: false, error: 'Only staff can subscribe to areas' });
      if (!defaultRoom) return reply({ ok: false, error: 'Your account has no state assigned' });

      const { rooms, error } = roomsForBbox(payload?.bbox);
      if (error) return reply({ ok: false, error });

      for (const room of socket.rooms) {
        if (room !== socket.id && room !== userRoom(user._id)) socket.leave(room);
      }
      socket.join(rooms.map((cellRoom) => scopedCellRoom(user, cellRoom)));
      return reply({ ok: true, rooms: rooms.length });
    });
  });

  // ---- domain events → rooms
  const fanOut = (event, issue, reason) => {
    if (!issue?.geohash) return;
    const staffPayload = reason === undefined ? staffView(issue) : { issue: staffView(issue), reason };
    const cell = geoRoom(issue.geohash);
    const region = issue.region || 'unassigned';
    // Never a global broadcast: only this issue's state (+ superadmins), by jurisdiction or by map area.
    const staffRooms = [SUPERADMIN_ROOM, `region:${region}`, cell, `r:${region}|${cell}`];
    io.to(staffRooms).emit(event, staffPayload); // Socket.io de-duplicates sockets in several rooms

    // Reporters hear about changes to their own issues (status moves, merges).
    if (event === 'issue:updated' && issue.reporterIds?.length) {
      const rooms = issue.reporterIds.map((id) => userRoom(String(id._id || id)));
      io.to(rooms).except(staffRooms).emit(event, { issue: publicView(issue), reason });
    }
  };

  const onCreated = (issue) => fanOut('issue:created', issue);
  const onUpdated = (issue, meta = {}) => fanOut('issue:updated', issue, meta.reason || 'update');
  issueEvents.on('issue:created', onCreated);
  issueEvents.on('issue:updated', onUpdated);

  io.close = ((close) => (...args) => {
    issueEvents.off('issue:created', onCreated);
    issueEvents.off('issue:updated', onUpdated);
    return close(...args);
  })(io.close.bind(io));

  return io;
};

module.exports = { attachRealtime, roomsForBbox, geoRoom };
