/**
 * Photo storage for issue reports.
 *
 * Files are written to UPLOAD_DIR (default ./uploads) under a random name and
 * served read-only at /uploads/<name>. The rest of the app only sees save() and
 * remove(), so swapping this for S3 (PRD architecture) means replacing this one
 * file: return the bucket URL from save() instead of a local path.
 *
 * The file type is decided from the bytes themselves (magic numbers), never from
 * the client-supplied name or Content-Type.
 */

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const PUBLIC_PREFIX = '/uploads';

const MAX_IMAGE_BYTES = (Number(process.env.MAX_IMAGE_MB) || 5) * 1024 * 1024;
const MAX_IMAGES_PER_REPORT = 3;
const MAX_IMAGES_PER_ISSUE = 12;
const MAX_RESOLUTION_IMAGES = 6;

/** @returns {'jpg'|'png'|'webp'|null} */
const sniffImageType = (buf) => {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
};

/**
 * Store one image. Returns its public path ("/uploads/ab12….jpg").
 * Throws an Error with `.status = 400` if the bytes are not a JPEG, PNG or WebP.
 */
const saveImage = async (buffer) => {
  const ext = sniffImageType(buffer);
  if (!ext) {
    const err = new Error('Photos must be JPEG, PNG or WebP images');
    err.status = 400;
    throw err;
  }
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(UPLOAD_DIR, name), buffer, { flag: 'wx' });
  return `${PUBLIC_PREFIX}/${name}`;
};

/** Read a stored image back by its public path. Returns null if it is not there. */
const readImage = async (publicPath) => {
  if (typeof publicPath !== 'string' || !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) return null;
  return fs.readFile(path.join(UPLOAD_DIR, path.basename(publicPath))).catch(() => null);
};

/** Best-effort delete of a stored image by its public path. Never throws. */
const removeImage = async (publicPath) => {
  if (typeof publicPath !== 'string' || !publicPath.startsWith(`${PUBLIC_PREFIX}/`)) return;
  const name = path.basename(publicPath);
  await fs.unlink(path.join(UPLOAD_DIR, name)).catch(() => undefined);
};

module.exports = {
  UPLOAD_DIR,
  PUBLIC_PREFIX,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_REPORT,
  MAX_IMAGES_PER_ISSUE,
  MAX_RESOLUTION_IMAGES,
  sniffImageType,
  saveImage,
  readImage,
  removeImage,
};
