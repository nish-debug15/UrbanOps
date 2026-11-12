"use client";

/**
 * "After" photos on a resolved issue: shows the ones already there and lets
 * staff add more as proof of the fix (the reporters see them).
 */

import { useId } from "react";
import type { Issue } from "@/lib/api";
import { MAX_PHOTOS_PER_UPLOAD, PHOTO_TYPES, checkPhotos } from "@/lib/issues";
import PhotoStrip from "./PhotoStrip";

// Must match the API (services/storage.js MAX_RESOLUTION_IMAGES).
const MAX_AFTER_PHOTOS = 6;

type Props = {
  issue: Issue;
  busy?: boolean;
  size?: "small" | "large";
  onAdd: (files: File[]) => void;
  onError: (message: string | null) => void;
};

export default function AfterPhotos({ issue, busy, size = "small", onAdd, onError }: Props) {
  const inputId = useId();
  const count = issue.resolutionImages?.length ?? 0;
  const room = Math.min(MAX_PHOTOS_PER_UPLOAD, MAX_AFTER_PHOTOS - count);

  return (
    <div className="after-photos">
      {count > 0 && <span className="after-label">After the fix</span>}
      <PhotoStrip images={issue.resolutionImages} size={size} max={MAX_AFTER_PHOTOS} />
      {room > 0 && (
        <label htmlFor={inputId} className={`btn-small secondary after-add ${busy ? "disabled" : ""}`}>
          <input
            id={inputId}
            type="file"
            accept={PHOTO_TYPES.join(",")}
            multiple
            disabled={busy}
            className="sr-only"
            onChange={(e) => {
              const { accepted, error } = checkPhotos(Array.from(e.target.files ?? []), room);
              e.target.value = "";
              onError(error);
              if (accepted.length) onAdd(accepted);
            }}
          />
          {busy ? "Uploading…" : count ? "+ Add another photo" : "+ Add photo of the fix"}
        </label>
      )}
    </div>
  );
}
