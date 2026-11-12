"use client";

/**
 * Asked whenever staff resolve or close an issue: what was done, and optionally
 * photos of the fix. Both are shown to the citizens who reported it.
 */

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type { Issue } from "@/lib/api";
import { issueRef, issueTitle } from "@/lib/format";
import { MAX_PHOTOS_PER_UPLOAD, MAX_PHOTO_MB, PHOTO_TYPES, checkPhotos } from "@/lib/issues";

const NOTE_MAX = 1000;

type Props = {
  issue: Issue;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (note: string, photos: File[]) => void;
};

export default function ResolveDialog({ issue, busy, onCancel, onConfirm }: Props) {
  const [note, setNote] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const closing = issue.status === "open"; // closed without ever being dispatched

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const previews = useMemo(() => photos.map((file) => ({ file, url: URL.createObjectURL(file) })), [photos]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (note.trim()) onConfirm(note.trim(), photos);
  }

  return (
    <dialog
      ref={ref}
      className="resolve-dialog"
      aria-labelledby="resolve-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <form onSubmit={handleSubmit}>
        <p className="eyebrow">{issueRef(issue)}</p>
        <h2 id="resolve-title">
          {closing ? "Close" : "Resolve"}: {issueTitle(issue)}
        </h2>
        <div className="form-group">
          <label htmlFor="resolve-note">{closing ? "Why is it being closed?" : "What was done?"}</label>
          <textarea
            id="resolve-note"
            rows={4}
            maxLength={NOTE_MAX}
            required
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={closing ? "e.g. Duplicate of INC-4F2A1, already fixed." : "e.g. Pothole filled and road surface levelled."}
          />
        </div>

        <div className="form-group">
          <span id="resolve-photos-label">Photos of the fix (optional, up to {MAX_PHOTOS_PER_UPLOAD})</span>
          {previews.length > 0 && (
            <ul className="photo-previews">
              {previews.map(({ file, url }, i) => (
                <li key={url}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                  <img src={url} alt={`Selected photo ${i + 1}: ${file.name}`} />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setPhotos((list) => list.filter((f) => f !== file))}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          {photos.length < MAX_PHOTOS_PER_UPLOAD && (
            <label className="upload-box" htmlFor="resolve-photos">
              <input
                id="resolve-photos"
                type="file"
                accept={PHOTO_TYPES.join(",")}
                multiple
                className="sr-only"
                aria-labelledby="resolve-photos-label"
                onChange={(e) => {
                  const { accepted, error } = checkPhotos(Array.from(e.target.files ?? []), MAX_PHOTOS_PER_UPLOAD - photos.length);
                  e.target.value = "";
                  setPhotos((list) => [...list, ...accepted]);
                  setPhotoError(error);
                }}
              />
              <strong>Add a photo</strong>
              <span>JPEG, PNG or WebP, up to {MAX_PHOTO_MB} MB each</span>
            </label>
          )}
          {photoError && <span className="field-hint photo-error">{photoError}</span>}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn-small secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-small" disabled={busy || !note.trim()}>
            {busy ? "Saving…" : closing ? "Close issue" : "Mark resolved ✓"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
