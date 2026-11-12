"use client";

/**
 * Dispatcher ops map.
 *  - Loads only issues inside the visible area (bbox), re-fetching after pan/zoom.
 *  - Live updates subscribe to the same visible area (geohash rooms).
 *  - Filters: status, category, minimum severity.
 *  - Click a marker → side panel with details and dispatch/assign/resolve actions.
 */

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "@/components/AppShell";
import AfterPhotos from "@/components/AfterPhotos";
import PhotoStrip from "@/components/PhotoStrip";
import ResolveDialog from "@/components/ResolveDialog";
import {
  ApiError,
  api,
  errorMessage,
  type Issue,
  type IssueCategory,
  type IssueStatus,
  type Paged,
  type StaffRef,
  type HistoryEntry,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIssueStream, type Bbox, type IssueEvent } from "@/lib/socket";
import { STATUS_LABEL, issuePlace, issueRef, issueTitle, priorityOf, timeAgo } from "@/lib/format";
import {
  ACTION_LABEL,
  CATEGORY_LABEL,
  allowedMoves,
  describeHistory,
  fetchIssue,
  moveBody,
  patchIssue,
  type IssuePatch,
} from "@/lib/issues";

const OpsMap = dynamic(() => import("./OpsMap"), {
  ssr: false,
  loading: () => (
    <div className="map-wrapper ops-map map-loading">
      <span className="mono">Loading map…</span>
    </div>
  ),
});

const PAGE_LIMIT = 500;
const STATUSES: IssueStatus[] = ["open", "dispatched", "resolved"];
const CATEGORIES: IssueCategory[] = ["hazard", "infra", "minor"];
const SEVERITY_OPTIONS = [
  { value: 0, label: "Any severity" },
  { value: 30, label: "30+ (medium & high)" },
  { value: 50, label: "50+ (high)" },
  { value: 70, label: "70+ (critical)" },
];

// Must match backend config/constants.js
const BASE_WEIGHT: Record<IssueCategory, number> = { hazard: 50, infra: 30, minor: 10 };
const DUP_MULTIPLIER = 5;

type Filters = { statuses: IssueStatus[]; categories: IssueCategory[]; minSeverity: number };

const matchesFilters = (issue: Issue, f: Filters) =>
  f.statuses.includes(issue.status) && f.categories.includes(issue.category) && issue.severityScore >= f.minSeverity;

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

export default function LiveMapPage() {
  return (
    <AppShell title="Live map" roles={["dispatcher", "admin", "superadmin"]}>
      <OpsMapScreen />
    </AppShell>
  );
}

function OpsMapScreen() {
  const { token, user, permissions } = useAuth();
  const [filters, setFilters] = useState<Filters>({
    statuses: ["open", "dispatched"],
    categories: [...CATEGORIES],
    minSeverity: 0,
  });
  const [view, setView] = useState<{ bbox: Bbox; zoom: number } | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<Issue | null>(null); // keeps the panel open if a change hides the issue
  const [staff, setStaff] = useState<StaffRef[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [resolving, setResolving] = useState(false);
  const [heat, setHeat] = useState(false);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtersKey = `${filters.statuses.join(",")}|${filters.categories.join(",")}|${filters.minSeverity}`;
  const bboxKey = view ? view.bbox.map((n) => n.toFixed(4)).join(",") : "";

  // Debounce viewport changes so a drag doesn't fire a request per frame.
  const handleViewChange = useCallback((bbox: Bbox, zoom: number) => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
    viewTimer.current = setTimeout(() => setView({ bbox, zoom }), 250);
  }, []);

  useEffect(() => () => {
    if (viewTimer.current) clearTimeout(viewTimer.current);
  }, []);

  // Staff list for the assignee picker (once).
  useEffect(() => {
    const controller = new AbortController();
    api<{ data: StaffRef[] }>("/users/dispatchers", { signal: controller.signal })
      .then((res) => setStaff(res.data))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  // Fetch issues for the visible area + filters.
  useEffect(() => {
    if (!bboxKey) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({ bbox: bboxKey, limit: String(PAGE_LIMIT) });
    const [statuses, categories, minSeverity] = filtersKey.split("|");
    if (!statuses || !categories) {
      // Nothing selected in a filter group → nothing can match; skip the request.
      Promise.resolve().then(() => {
        setIssues([]);
        setTotal(0);
      });
      return () => controller.abort();
    }
    params.set("status", statuses);
    params.set("category", categories);
    if (Number(minSeverity) > 0) params.set("minSeverity", minSeverity);

    Promise.resolve().then(() => setLoading(true));
    api<Paged<Issue>>(`/issues?${params}`, { signal: controller.signal })
      .then((res) => {
        setIssues(res.data);
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [bboxKey, filtersKey]);

  // Live updates for the visible area.
  const handleEvent = useCallback(
    (event: IssueEvent) => {
      const { issue } = event;
      setIssues((list) => {
        const rest = list.filter((i) => i._id !== issue._id);
        return matchesFilters(issue, filters) ? [...rest, issue] : rest;
      });
      setPinned((p) => (p && p._id === issue._id ? issue : p));
      if (issue._id === selectedIdRef.current && issue.history) setHistory(issue.history);
    },
    [filters]
  );
  const { connected, subscription } = useIssueStream(token, handleEvent, view?.bbox);

  const selected = useMemo(
    () => issues.find((i) => i._id === selectedId) ?? (pinned && pinned._id === selectedId ? pinned : null),
    [issues, selectedId, pinned]
  );

  // The list omits history (keeps map payloads small): load it when an issue is opened.
  const historyAbort = useRef<AbortController | null>(null);
  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      setPinned(id ? issues.find((i) => i._id === id) ?? null : null);
      setNotice(null);
      setHistory(null);
      historyAbort.current?.abort();
      if (!id) return;
      const controller = new AbortController();
      historyAbort.current = controller;
      fetchIssue(id, controller.signal)
        .then((full) => setHistory(full.history ?? []))
        .catch(() => undefined);
    },
    [issues]
  );

  const applyPatch = async (issue: Issue, body: IssuePatch, photos: File[] = []) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await patchIssue(issue._id, body, photos);
      setPinned(updated);
      if (updated.history) setHistory(updated.history);
      setIssues((list) => {
        const rest = list.filter((i) => i._id !== updated._id);
        return matchesFilters(updated, filters) ? [...rest, updated] : rest;
      });
      if (!matchesFilters(updated, filters)) {
        setNotice(`Now ${STATUS_LABEL[updated.status].toLowerCase()} — hidden from the map by your filters.`);
      }
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof ApiError && err.status === 409) {
        // Someone else moved it: reload this issue.
        api<{ issue: Issue }>(`/issues/${issue._id}`)
          .then((r) => setPinned(r.issue))
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
      setResolving(false); // close the dialog either way, so an error is visible
    }
  };

  const counts = useMemo(() => {
    const byStatus: Record<IssueStatus, number> = { open: 0, dispatched: 0, resolved: 0 };
    for (const i of issues) byStatus[i.status] += 1;
    return byStatus;
  }, [issues]);

  const liveLabel = !connected
    ? "OFFLINE"
    : subscription && !subscription.ok
      ? "ZOOM IN FOR LIVE"
      : "LIVE";

  return (
    <>
      <div className="map-filters">
        <div className="filter-group" role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`chip ${filters.statuses.includes(s) ? "on" : ""}`}
              aria-pressed={filters.statuses.includes(s)}
              onClick={() => setFilters((f) => ({ ...f, statuses: toggle(f.statuses, s) }))}
            >
              {STATUS_LABEL[s]}
              {filters.statuses.includes(s) && <span className="chip-count">{counts[s]}</span>}
            </button>
          ))}
        </div>

        <div className="filter-group" role="group" aria-label="Category">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip ${filters.categories.includes(c) ? "on" : ""}`}
              aria-pressed={filters.categories.includes(c)}
              onClick={() => setFilters((f) => ({ ...f, categories: toggle(f.categories, c) }))}
            >
              {CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <label className="filter-select">
          <span className="sr-only">Minimum severity</span>
          <select
            value={filters.minSeverity}
            onChange={(e) => setFilters((f) => ({ ...f, minSeverity: Number(e.target.value) }))}
          >
            {SEVERITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        <div className="filter-group" role="group" aria-label="Map layer">
          <button type="button" className={`chip ${heat ? "" : "on"}`} aria-pressed={!heat} onClick={() => setHeat(false)}>
            Markers
          </button>
          <button type="button" className={`chip ${heat ? "on" : ""}`} aria-pressed={heat} onClick={() => setHeat(true)}>
            Heatmap
          </button>
        </div>

        <div className="filter-status">
          <span className="mono muted">
            {loading ? "Loading…" : `${issues.length}${total > issues.length ? ` of ${total}` : ""} in view`}
          </span>
          <span
            className={`live-badge ${connected && subscription?.ok !== false ? "on" : ""}`}
            title={subscription && !subscription.ok ? subscription.error : undefined}
          >
            <span className="live-dot" /> {liveLabel}
          </span>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}
      {total > issues.length && (
        <div className="alert">
          Showing the {issues.length} most severe of {total} issues in this area. Zoom in or tighten filters to see the
          rest.
        </div>
      )}

      <div className={`ops-layout ${selected ? "with-panel" : ""}`}>
        <div className="panel ops-map-panel">
          <OpsMap issues={issues} selected={selected} onSelect={select} onViewChange={handleViewChange} heat={heat} />
        </div>

        {selected && (
          <IssuePanel
            issue={selected}
            staff={staff}
            busy={busy}
            notice={notice}
            moves={allowedMoves(permissions, selected.status)}
            history={history}
            onClose={() => select(null)}
            onMove={(status) =>
              status === "resolved" ? setResolving(true) : applyPatch(selected, moveBody(selected, status, user?._id))
            }
            onAssign={(assignedTo) => applyPatch(selected, { assignedTo })}
            onAddPhotos={(files) => applyPatch(selected, {}, files)}
            onError={setError}
          />
        )}
      </div>

      {resolving && selected && (
        <ResolveDialog
          issue={selected}
          busy={busy}
          onCancel={() => setResolving(false)}
          onConfirm={(note, photos) => applyPatch(selected, moveBody(selected, "resolved", user?._id, note), photos)}
        />
      )}
    </>
  );
}

function IssuePanel({
  issue,
  staff,
  busy,
  notice,
  moves,
  history,
  onClose,
  onMove,
  onAssign,
  onAddPhotos,
  onError,
}: {
  issue: Issue;
  staff: StaffRef[];
  busy: boolean;
  notice: string | null;
  moves: IssueStatus[];
  history: HistoryEntry[] | null;
  onClose: () => void;
  onMove: (status: IssueStatus) => void;
  onAssign: (id: string | null) => void;
  onAddPhotos: (files: File[]) => void;
  onError: (message: string | null) => void;
}) {
  const priority = priorityOf(issue.severityScore);
  const base = BASE_WEIGHT[issue.category];
  const dupBoost = issue.duplicateCount * DUP_MULTIPLIER;
  const decay = Math.max(0, Math.round((base + dupBoost - issue.severityScore) * 10) / 10);
  const [lng, lat] = issue.location.coordinates;
  const stepIndex = STATUSES.indexOf(issue.status);

  return (
    <aside className="panel issue-panel" aria-label="Issue details">
      <header className="panel-header">
        <h2 className="panel-title">
          {issueRef(issue)} · {issueTitle(issue)}
        </h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </header>

      <div className="issue-panel-body">
        {notice && <div className="alert success">{notice}</div>}

        <div className={`severity-banner ${priority}`}>
          <span className="severity-big mono">{issue.severityScore}</span>
          <div>
            <div className="severity-level">{priority.toUpperCase()} PRIORITY</div>
            <div className="mono small">
              {base} base ({CATEGORY_LABEL[issue.category].toLowerCase()}) + {dupBoost} ({issue.duplicateCount} duplicate
              {issue.duplicateCount === 1 ? "" : "s"}) − {decay} decay
            </div>
          </div>
        </div>

        <ol className="progress">
          {STATUSES.map((s, i) => (
            <li key={s} className={i <= stepIndex ? "done" : ""}>
              {STATUS_LABEL[s]}
            </li>
          ))}
        </ol>

        <dl className="issue-facts">
          <dt>Location</dt>
          <dd>
            {issuePlace(issue)}
            <br />
            <span className="mono muted small">
              {lat.toFixed(5)}, {lng.toFixed(5)}
            </span>
          </dd>
          <dt>Reports</dt>
          <dd>
            {issue.reportCount} · last {timeAgo(issue.lastReportedAt)}
          </dd>
          <dt>Opened</dt>
          <dd>{new Date(issue.createdAt).toLocaleString()}</dd>
          {issue.resolvedAt && (
            <>
              <dt>Resolved</dt>
              <dd>{new Date(issue.resolvedAt).toLocaleString()}</dd>
            </>
          )}
          {issue.description && (
            <>
              <dt>Details</dt>
              <dd>{issue.description}</dd>
            </>
          )}
          {issue.resolutionNote && (
            <>
              <dt>What was done</dt>
              <dd>{issue.resolutionNote}</dd>
            </>
          )}
        </dl>

        <PhotoStrip images={issue.images} size="large" max={6} />
        {issue.status === "resolved" && <AfterPhotos issue={issue} busy={busy} onAdd={onAddPhotos} onError={onError} size="large" />}

        {issue.status !== "resolved" && (
          <label className="form-group panel-field">
            <span>Assigned to</span>
            <select value={issue.assignedTo?._id || ""} disabled={busy} onChange={(e) => onAssign(e.target.value || null)}>
              <option value="">— unassigned —</option>
              {staff.map((s) => (
                <option key={s._id} value={s._id}>
                  {s.name} ({s.role})
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="panel-actions">
          {moves.length === 0 && (
            <span className="mono muted small">
              {issue.status === "resolved" ? "Resolved. Only an admin can reopen it." : "No actions available for your role."}
            </span>
          )}
          {moves.map((to) => (
            <button
              key={to}
              type="button"
              className={`btn-small ${to === "open" ? "secondary" : ""}`}
              disabled={busy}
              onClick={() => onMove(to)}
            >
              {ACTION_LABEL[`${issue.status}>${to}`]}
            </button>
          ))}
        </div>

        <section className="history">
          <h3 className="history-title">Activity</h3>
          {history === null && <span className="mono muted small">Loading…</span>}
          {history && history.length === 0 && <span className="mono muted small">No staff actions yet.</span>}
          {history && history.length > 0 && (
            <ol className="history-list">
              {[...history].reverse().map((e, i) => (
                <li key={`${e.at}-${i}`}>
                  <span>{describeHistory(e)}</span>
                  <span className="mono muted small">{timeAgo(e.at)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <Link href="/incidents" className="action-link small-link">
          Open the Kanban board →
        </Link>
      </div>
    </aside>
  );
}
