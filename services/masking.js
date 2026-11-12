/**
 * Photo masking (PRD: AI-based photo masking).
 *
 * When MASKING_URL points at the Python service in ./masking, every uploaded photo
 * is sent there and a copy with faces and number plates blurred is stored next to
 * the original:  { original: '/uploads/a.jpg', masked: '/uploads/b.jpg' }.
 * If the service finds nothing to hide, `masked` is the original's own path.
 *
 * Who sees what:
 *   staff     both paths (thumbnails use the masked copy).
 *   citizens  only `masked`. While masking is switched on, a photo that has no
 *             masked copy yet (the service was down) is withheld from them rather
 *             than shown unblurred; `npm run mask:backfill` fills those in.
 *
 * Without MASKING_URL nothing changes: photos are stored and shown as uploaded.
 * A masking failure never rejects a report.
 */

const { saveImage } = require('./storage');

const maskingUrl = () => (process.env.MASKING_URL || '').trim().replace(/\/+$/, '');
const maskingEnabled = () => Boolean(maskingUrl());

/**
 * Ask the masking service to blur one image.
 * @returns {Promise<Buffer|null>} the masked image, or null when there was nothing to hide.
 * Throws if the service is unreachable, slow, or answers with an error.
 */
const requestMask = async (buffer) => {
  const token = process.env.MASKING_TOKEN;
  const res = await fetch(`${maskingUrl()}/mask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(token && { Authorization: `Bearer ${token}` }) },
    body: buffer,
    signal: AbortSignal.timeout(Number(process.env.MASKING_TIMEOUT_MS) || 15000),
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`masking service answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
};

/**
 * Make the masked copy of a photo that was just stored at `originalPath`.
 * @returns {Promise<string|undefined>} public path of the version that is safe to
 *   show (the original's own path if nothing needed hiding), or undefined when
 *   masking is off or failed. Never throws.
 */
const maskStored = async (buffer, originalPath) => {
  if (!maskingEnabled()) return undefined;
  try {
    const masked = await requestMask(buffer);
    return masked ? await saveImage(masked) : originalPath;
  } catch (err) {
    console.warn(`[UrbanOps Masking] ${originalPath} was stored without a masked copy: ${err.message}`);
    return undefined;
  }
};

/** The part of a photo list that people other than staff may see. */
const publicImages = (images = []) =>
  images.flatMap((img) => {
    if (img.masked) return [{ masked: img.masked }];
    return maskingEnabled() ? [] : [{ original: img.original }];
  });

module.exports = { maskingEnabled, requestMask, maskStored, publicImages };
