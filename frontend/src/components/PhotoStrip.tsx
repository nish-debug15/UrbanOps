/* Report photos are served by the API from user uploads of arbitrary size, so a
   plain <img> is used rather than next/image (no remote loader to configure). */
/* eslint-disable @next/next/no-img-element */

import { assetUrl, type Issue } from "@/lib/api";

type Props = { images?: Issue["images"]; size?: "small" | "large"; max?: number };

/**
 * Thumbnails of an issue's photos; each opens the full image in a new tab.
 * Thumbnails use the masked copy (faces and number plates blurred) when there is
 * one. Staff also receive the original, which is what the link opens for them.
 */
export default function PhotoStrip({ images, size = "small", max = 4 }: Props) {
  const photos = (images ?? []).flatMap((img) => {
    const preview = img.masked || img.original;
    const full = img.original || img.masked;
    return preview && full ? [{ preview, full, blurred: !!img.masked && !!img.original && img.masked !== img.original }] : [];
  });
  if (!photos.length) return null;
  const shown = photos.slice(0, max);
  const extra = photos.length - shown.length;
  return (
    <div className={`photo-strip ${size}`}>
      {shown.map((photo, i) => (
        <a
          key={photo.preview}
          href={assetUrl(photo.full)}
          target="_blank"
          rel="noopener noreferrer"
          title={photo.blurred ? "Faces and number plates are blurred in this preview. Opens the original." : undefined}
        >
          <img src={assetUrl(photo.preview)} alt={`Report photo ${i + 1} of ${photos.length}`} loading="lazy" />
        </a>
      ))}
      {extra > 0 && <span className="photo-more mono">+{extra}</span>}
    </div>
  );
}
