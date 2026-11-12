"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { UserPosition } from "@/components/map/UserLocation";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type NearbyIssue, type ReportResult } from "@/lib/api";
import { REPORT_TYPES, issueRef, issueTitle, timeAgo } from "@/lib/format";

const LiveMap = dynamic(() => import("../LiveMap"), { ssr: false });

type Point = { lat: number; lng: number; source: "gps" | "map"; accuracy?: number };

// Must match the API (services/storage.js).
const MAX_PHOTOS = 3;
const MAX_PHOTO_MB = 5;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Open issues around the pin, so people can join one instead of describing it again. */
function useNearby(point: Point | null) {
  const [nearby, setNearby] = useState<NearbyIssue[]>([]);
  // ~11 m steps: GPS jitter doesn't refetch.
  const key = point ? `${point.lat.toFixed(4)},${point.lng.toFixed(4)}` : "";

  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    const [lat, lng] = key.split(",");
    const timer = setTimeout(() => {
      api<{ data: NearbyIssue[] }>(`/issues/nearby?lat=${lat}&lng=${lng}`, { signal: controller.signal })
        .then((res) => setNearby(res.data))
        .catch(() => undefined); // a hint only: the form works without it
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);

  return key ? nearby : [];
}

export default function ReportPage() {
  return (
    <AppShell title="Report an issue" roles={["citizen"]}>
      <ReportForm />
    </AppShell>
  );
}

function ReportForm() {
  const [point, setPoint] = useState<Point | null>(null);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const nearby = useNearby(point);

  const previews = useMemo(() => photos.map((file) => ({ file, url: URL.createObjectURL(file) })), [photos]);
  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  function addPhotos(files: FileList | null) {
    if (!files) return;
    const problems: string[] = [];
    const accepted: File[] = [];
    for (const file of Array.from(files)) {
      if (!PHOTO_TYPES.includes(file.type)) problems.push(`${file.name} is not a JPEG, PNG or WebP image`);
      else if (file.size > MAX_PHOTO_MB * 1024 * 1024) problems.push(`${file.name} is larger than ${MAX_PHOTO_MB} MB`);
      else accepted.push(file);
    }
    const room = MAX_PHOTOS - photos.length;
    if (accepted.length > room) problems.push(`You can attach up to ${MAX_PHOTOS} photos`);
    setPhotos((list) => [...list, ...accepted.slice(0, Math.max(0, room))]);
    setError(problems.length ? problems.join(". ") + "." : null);
  }

  async function confirmNearby(issue: NearbyIssue) {
    setConfirming(issue._id);
    setError(null);
    try {
      const res = await api<Omit<ReportResult, "merged">>(`/issues/${issue._id}/confirm`, { method: "POST" });
      setResult({ ...res, merged: true });
      setPhotos([]);
      setPoint(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setConfirming(null);
    }
  }

  // GPS fixes from the map fill the pin automatically, until the user clicks the
  // map themselves (a manual pin is never overwritten).
  const handleLocate = useCallback((pos: UserPosition) => {
    setPoint((p) => (p && p.source === "map" ? p : { lat: pos.lat, lng: pos.lng, source: "gps", accuracy: pos.accuracy }));
  }, []);

  function locateMe() {
    if (!("geolocation" in navigator)) {
      setError("Your browser can't share its location. Click the map instead.");
      return;
    }
    setLocating(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude, source: "gps", accuracy: pos.coords.accuracy });
        setLocating(false);
      },
      (err) => {
        setLocating(false);
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Location permission was denied. Click the map to place the pin instead."
            : "Couldn't get your location. Click the map to place the pin instead."
        );
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!point) {
      setError("Pick the location: use your current location or click on the map.");
      return;
    }
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError(null);
    try {
      // Multipart, so photos travel with the report in one request.
      const body = new FormData();
      body.set("subcategory", String(form.get("category") || ""));
      const address = String(form.get("address") || "").trim();
      const description = String(form.get("description") || "").trim();
      if (address) body.set("address", address);
      if (description) body.set("description", description);
      body.set("lat", String(point.lat));
      body.set("lng", String(point.lng));
      photos.forEach((file) => body.append("photos", file));

      const res = await api<ReportResult>("/issues", { method: "POST", body });
      setResult(res);
      formEl.reset();
      setPhotos([]);
      setPoint(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="success-message">
        <div className="success-icon">✓</div>
        <p className="eyebrow">{result.merged ? "ADDED TO AN EXISTING ISSUE" : "NEW ISSUE CREATED"}</p>
        <h1>Thanks — your report was received.</h1>
        <p>{result.message}</p>
        <p className="mono">
          {issueRef(result.issue)} · {result.issue.reportCount} report{result.issue.reportCount === 1 ? "" : "s"} · severity{" "}
          {result.issue.severityScore}
        </p>
        <div className="success-actions">
          <Link href="/my-reports" className="submit-button">
            Track my reports
          </Link>
          <button className="location-button" onClick={() => setResult(null)}>
            Submit another report
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="report-layout">
      <form className="report-form" onSubmit={handleSubmit}>
        {error && <div className="alert error">{error}</div>}

        <div className="form-group">
          <label htmlFor="category">What is the issue?</label>
          <select id="category" name="category" required defaultValue="">
            <option value="" disabled>
              Select an issue
            </option>
            {REPORT_TYPES.map((t) => (
              <option key={t.label} value={t.label}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Location</label>
          <div className={`location-readout mono ${point ? "set" : ""}`}>
            {point
              ? `📍 ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)} · ${point.source === "gps" ? `from your GPS (±${Math.round(point.accuracy ?? 0)} m)` : "pinned on the map"}`
              : "Finding your location… or click the map to place the pin."}
          </div>
          <button type="button" className="location-button" onClick={locateMe} disabled={locating}>
            {locating ? "Locating…" : "Use my current location"}
          </button>
        </div>

        {nearby.length > 0 && (
          <section className="nearby" aria-label="Issues already reported near this location">
            <h2 className="nearby-title">Already reported near here</h2>
            <ul className="nearby-list">
              {nearby.slice(0, 4).map((issue) => (
                <li key={issue._id}>
                  <div>
                    <strong>{issueTitle(issue)}</strong>
                    <span className="mono muted small">
                      {issue.distance} m away · {issue.reportCount} report{issue.reportCount === 1 ? "" : "s"} ·{" "}
                      {timeAgo(issue.lastReportedAt)}
                    </span>
                    {issue.description && <span className="nearby-desc">{issue.description}</span>}
                  </div>
                  {issue.reportedByMe ? (
                    <span className="mono muted small">You reported this</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-small"
                      disabled={confirming !== null || busy}
                      onClick={() => confirmNearby(issue)}
                    >
                      {confirming === issue._id ? "Adding…" : "I see this too"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="form-group">
          <label htmlFor="address">Street / landmark (optional)</label>
          <input id="address" name="address" type="text" maxLength={200} placeholder="e.g. MG Road, near metro pillar 42" />
        </div>

        <div className="form-group">
          <label htmlFor="description">What did you notice?</label>
          <textarea id="description" name="description" rows={4} maxLength={2000} placeholder="Briefly describe the problem…" />
        </div>

        <div className="form-group">
          <label htmlFor="photos">Photos (optional, up to {MAX_PHOTOS})</label>
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
          {photos.length < MAX_PHOTOS && (
            <label className="upload-box" htmlFor="photos">
              <input
                id="photos"
                type="file"
                accept={PHOTO_TYPES.join(",")}
                multiple
                className="sr-only"
                onChange={(e) => {
                  addPhotos(e.target.files);
                  e.target.value = ""; // allow picking the same file again after removing it
                }}
              />
              <strong>Add a photo</strong>
              <span>JPEG, PNG or WebP, up to {MAX_PHOTO_MB} MB each</span>
            </label>
          )}
        </div>

        <button type="submit" className="submit-button" disabled={busy}>
          {busy ? "Submitting…" : "Submit report"}
        </button>
      </form>

      <section className="panel pick-map">
        <header className="panel-header">
          <h2 className="panel-title">Click the map to place the pin</h2>
        </header>
        <LiveMap
          issues={[]}
          onPick={(lat, lng) => setPoint({ lat, lng, source: "map" })}
          picked={point}
          showLegend={false}
          centerOnUser
          onLocate={handleLocate}
        />
      </section>
    </div>
  );
}
