/**
 * User management (admin only, PRD §5)
 *   GET   /api/v1/users            ?role=dispatcher&page=1&limit=20
 *   PATCH /api/v1/users/:id/role   { role }
 *
 * GET /api/v1/users/dispatchers is available to dispatchers too, so they can
 * pick an assignee on the Kanban board.
 */

const express = require('express');
const mongoose = require('mongoose');
const User = require('../models/User');
const { ROLES } = require('../config/constants');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/dispatchers', requireRole('dispatcher', 'admin'), async (req, res, next) => {
  try {
    const users = await User.find({ role: { $in: ['dispatcher', 'admin'] } })
      .select('name email role ward')
      .sort({ name: 1 })
      .lean();
    res.json({ success: true, data: users });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireRole('admin'), async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = {};
    if (req.query.role) {
      if (!ROLES.includes(req.query.role)) {
        return res.status(400).json({ success: false, error: `role must be one of ${ROLES.join(', ')}` });
      }
      filter.role = req.query.role;
    }

    const [data, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      User.countDocuments(filter),
    ]);
    data.forEach((u) => delete u.__v);
    return res.json({ success: true, data, page, limit, total });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id/role', requireRole('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { role } = req.body || {};
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: 'Invalid user id' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ success: false, error: `role must be one of ${ROLES.join(', ')}` });
    }
    // Prevent an admin from locking everyone out by demoting themselves.
    if (String(req.user._id) === id && role !== 'admin') {
      return res.status(400).json({ success: false, error: 'Admins cannot change their own role' });
    }

    const user = await User.findByIdAndUpdate(id, { role }, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json({ success: true, user });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
