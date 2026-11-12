/**
 * Make masked copies for photos that don't have one yet: photos uploaded before
 * masking was switched on, or while the masking service was down.
 *
 *   npm run mask:backfill
 *
 * Needs MASKING_URL (and the masking service running). Safe to run again: photos
 * that already have a masked copy are skipped, and failures are retried next time.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Issue = require('../models/Issue');
const { readImage, removeImage } = require('../services/storage');
const { maskingEnabled, maskStored } = require('../services/masking');

const FIELDS = ['images', 'resolutionImages'];

const run = async () => {
  if (!maskingEnabled()) {
    console.error('MASKING_URL is not set: nothing to do. Start the masking service and set MASKING_URL first.');
    process.exit(1);
  }
  await connectDB();

  const counts = { masked: 0, nothingToHide: 0, missingFile: 0, failed: 0 };
  const unmasked = { $elemMatch: { masked: null } }; // null also matches "no such field"
  const cursor = Issue.find({ $or: FIELDS.map((field) => ({ [field]: unmasked })) })
    .select(FIELDS.join(' '))
    .lean()
    .cursor();

  for await (const issue of cursor) {
    for (const field of FIELDS) {
      for (const img of issue[field] || []) {
        if (img.masked) continue;
        const buffer = await readImage(img.original);
        if (!buffer) {
          counts.missingFile += 1;
          continue;
        }
        const masked = await maskStored(buffer, img.original);
        if (!masked) {
          counts.failed += 1;
          continue;
        }
        const result = await Issue.updateOne(
          { _id: issue._id, [field]: { $elemMatch: { original: img.original, masked: null } } },
          { $set: { [`${field}.$.masked`]: masked } }
        );
        if (!result.modifiedCount) {
          // The photo was removed (or masked by someone else) meanwhile: drop our copy.
          if (masked !== img.original) await removeImage(masked);
          continue;
        }
        counts[masked === img.original ? 'nothingToHide' : 'masked'] += 1;
      }
    }
  }

  console.log(
    `Done. Blurred: ${counts.masked}. Nothing to hide: ${counts.nothingToHide}. ` +
      `Failed (will retry next run): ${counts.failed}. File no longer on disk: ${counts.missingFile}.`
  );
  await mongoose.disconnect();
  process.exit(counts.failed ? 1 : 0);
};

run().catch((err) => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
