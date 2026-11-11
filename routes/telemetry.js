/**
 * Telemetry Ingestion Routes
 * 
 * Express router handling client and operational telemetry ingestion at:
 * POST /api/v1/telemetry/ingest
 */

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const RawData = require('../models/RawData');

const router = express.Router();

// Public endpoint: cap per-IP write volume so it can't be used to flood the DB.
const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.TELEMETRY_RATE_LIMIT) || 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { success: false, error: 'Too many telemetry events, slow down' },
});

/**
 * Client IP. req.ip honours X-Forwarded-For only when the app's `trust proxy`
 * setting allows it (TRUST_PROXY env), so clients can't spoof their address.
 *
 * @param {express.Request} req
 * @returns {string}
 */
const extractClientIp = (req) => req.ip || req.socket?.remoteAddress || 'unknown';

/**
 * @route   POST /api/v1/telemetry/ingest
 * @desc    Ingest un-sanitized raw telemetry and operational event logs
 * @access  Public / Client Internal
 */
router.post('/ingest', ingestLimiter, async (req, res) => {
  try {
    const { source, eventType, payload } = req.body;

    // Validate required fields
    const missingFields = [];
    if (!source || typeof source !== 'string' || source.trim() === '') {
      missingFields.push('source (non-empty string)');
    }
    if (!eventType || typeof eventType !== 'string' || eventType.trim() === '') {
      missingFields.push('eventType (non-empty string)');
    }
    if (payload === undefined || payload === null) {
      missingFields.push('payload (valid JSON object or value)');
    }

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed: Missing or invalid required fields',
        missing: missingFields,
      });
    }

    // Extract connection metadata
    const ipAddress = extractClientIp(req);
    const userAgent = req.headers['user-agent'] || 'unknown';
    const timestamp = new Date();

    // Persist raw telemetry document in MongoDB
    const telemetryDoc = await RawData.create({
      source: source.trim(),
      eventType: eventType.trim(),
      payload,
      metadata: {
        ipAddress,
        userAgent,
        timestamp,
      },
    });

    return res.status(201).json({
      success: true,
      message: 'Telemetry event ingested successfully',
      data: {
        id: telemetryDoc._id,
        source: telemetryDoc.source,
        eventType: telemetryDoc.eventType,
        createdAt: telemetryDoc.createdAt,
      },
    });
  } catch (error) {
    console.error('[Telemetry Ingestion Error]:', error);

    // Differentiate Mongoose validation errors if any arise
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: 'Internal server error while processing telemetry payload',
    });
  }
});

module.exports = router;
