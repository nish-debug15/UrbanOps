"use client";

/**
 * Kanban board (PRD §6.4): Open → Dispatched → Resolved.
 * Drag a card to another column or use its buttons. Changes made by other
 * dispatchers arrive live over the socket.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { ApiError, api, errorMessage, type Issue, type IssueStatus, type Paged, type StaffRef } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIssueStream, type IssueEvent } from "@/lib/socket";
import { STATUS_LABEL, issuePlace, issueRef, issueTitle, priorityOf, timeAgo } from "@/lib/format";
import { ACTION_LABEL, allowedMoves, moveBody, moveDenial, patchIssue, type IssuePatch } from "@/lib/issues";
import AfterPhotos from "@/components/AfterPhotos";
import PhotoStrip from "@/components/PhotoStrip";
import ResolveDialog from "@/components/ResolveDialog";

const COLUMNS: IssueStatus[] = ["open", "dispatched", "resolved"];

const RESOLVED_SHOWN = 30;

async function fetchBoard(signal?: AbortSignal) {
  const [active, resolved, people] = await Promise.all([
    api<Paged<Issue>>("/issues?status=open,dispatched&limit=500", { signal }),
    api<Paged<Issue>>(`/issues?status=resolved&sort=recent&limit=${RESOLVED_SHOWN}`, { signal }),
    api<{ data: StaffRef[] }>("/users/dispatchers", { signal }),
  ]);
  return { issues: [...active.data, ...resolved.data], staff: people.data };
}

export default function IncidentsPage() {
  return (
    <AppShell title="Incidents" roles={["dispatcher", "admin", "superadmin"]}>
      <Board />
    </AppShell>
  );
}

function Board() {
  const { token, user, permissions } = useAuth();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [staff, setStaff] = useState<StaffRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<IssueStatus | null>(null);
  const [resolving, setResolving] = useState<Issue | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    fetchBoard(signal)
      .then((board) => {
        setIssues(board.issues);
        setStaff(board.staff);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const handleEvent = useCallback((event: IssueEvent) => {
    setIssues((list) => [...list.filter((i) => i._id !== event.issue._id), event.issue]);
  }, []);
  const { connected: live } = useIssueStream(token, handleEvent);

  const columns = useMemo(() => {
    const byStatus: Record<IssueStatus, Issue[]> = { open: [], dispatched: [], resolved: [] };
    for (const issue of issues) byStatus[issue.status].push(issue);
    byStatus.open.sort((a, b) => b.severityScore - a.severityScore);
    byStatus.dispatched.sort((a, b) => b.severityScore - a.severityScore);
    byStatus.resolved.sort((a, b) => (b.resolvedAt || "").localeCompare(a.resolvedAt || ""));
    byStatus.resolved = byStatus.resolved.slice(0, RESOLVED_SHOWN);
    return byStatus;
  }, [issues]);

  const update = async (issue: Issue, body: IssuePatch, photos: File[] = []) => {
    setBusy(issue._id);
    setError(null);
    try {
      const updated = await patchIssue(issue._id, body, photos);
      setIssues((list) => list.map((i) => (i._id === issue._id ? updated : i)));
    } catch (err) {
      setError(errorMessage(err));
      // Someone else changed it first: pull the latest board.
      if (err instanceof ApiError && err.status === 409) load();
    } finally {
      setBusy(null);
      setResolving(null); // close the dialog either way, so an error is visible
    }
  };

  const move = (issue: Issue, status: IssueStatus) => {
    if (issue.status === status) return;
    const denial = moveDenial(permissions, issue.status, status);
    if (denial) {
      setError(denial);
      return;
    }
    // Resolving asks what was done first; the note goes to the reporters.
    if (status === "resolved") {
      setError(null);
      setResolving(issue);
      return;
    }
    update(issue, moveBody(issue, status, user?._id));
  };

  return (
    <>
      <div className="board-toolbar">
        <span />
        <span className={`live-badge ${live ? "on" : ""}`}>
          <span className="live-dot" /> {live ? "LIVE" : "OFFLINE"}
        </span>
      </div>
      {error && <div className="alert error">{error}</div>}
      {resolving && (
        <ResolveDialog
          issue={resolving}
          busy={busy === resolving._id}
          onCancel={() => setResolving(null)}
          onConfirm={(note, photos) => update(resolving, moveBody(resolving, "resolved", user?._id, note), photos)}
        />
      )}

      <div className="kanban">
        {COLUMNS.map((status) => (
          <section
            key={status}
            className={`kanban-col panel ${dragOver === status ? "drag-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(status);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(null);
              const issue = issues.find((i) => i._id === e.dataTransfer.getData("text/plain"));
              if (issue) move(issue, status);
            }}
          >
            <header className="panel-header">
              <h2 className="panel-title">{STATUS_LABEL[status]}</h2>
              <span className="mono muted">
                {columns[status].length}
                {status === "resolved" ? " recent" : ""}
              </span>
            </header>

            <div className="kanban-cards">
              {columns[status].length === 0 && <div className="empty-state">Nothing here</div>}
              {columns[status].map((issue) => {
                const priority = priorityOf(issue.severityScore);
                return (
                  <article
                    key={issue._id}
                    className={`kanban-card ${priority} ${busy === issue._id ? "busy" : ""}`}
                    draggable={busy !== issue._id}
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", issue._id)}
                  >
                    <div className="kanban-card-top">
                      <strong>{issueTitle(issue)}</strong>
                      <span className={`severity-text ${priority} mono`}>{issue.severityScore}</span>
                    </div>
                    <div className="incident-location">
                      {issueRef(issue)} · {issue.reportCount} report{issue.reportCount === 1 ? "" : "s"} ·{" "}
                      {timeAgo(status === "resolved" && issue.resolvedAt ? issue.resolvedAt : issue.lastReportedAt)}
                    </div>
                    <div className="kanban-place">{issuePlace(issue)}</div>
                    {issue.description && <p className="kanban-desc">{issue.description}</p>}
                    <PhotoStrip images={issue.images} max={3} />
                    {status === "resolved" && issue.resolutionNote && (
                      <p className="resolution-note">
                        <strong>Done:</strong> {issue.resolutionNote}
                      </p>
                    )}
                    {status === "resolved" && (
                      <AfterPhotos issue={issue} busy={busy === issue._id} onAdd={(files) => update(issue, {}, files)} onError={setError} />
                    )}

                    {status !== "resolved" && (
                      <label className="assign-row">
                        <span>Assigned</span>
                        <select
                          value={issue.assignedTo?._id || ""}
                          disabled={busy === issue._id}
                          onChange={(e) => update(issue, { assignedTo: e.target.value || null })}
                        >
                          <option value="">— unassigned —</option>
                          {staff.map((s) => (
                            <option key={s._id} value={s._id}>
                              {s.name} ({s.role})
                            </option>
                          ))}
                        </select>
                      </label>
                    )}

                    <div className="card-actions">
                      {allowedMoves(permissions, status).map((to) => (
                        <button
                          key={to}
                          type="button"
                          className={`btn-small ${to === "open" ? "secondary" : ""}`}
                          disabled={busy === issue._id}
                          onClick={() => move(issue, to)}
                        >
                          {ACTION_LABEL[`${status}>${to}`]}
                        </button>
                      ))}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
