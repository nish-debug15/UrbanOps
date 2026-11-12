"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type Issue, type Paged, type Stats } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useIssueStream, type IssueEvent } from "@/lib/socket";
import { STATUS_LABEL, issuePlace, issueRef, issueTitle, priorityOf, timeAgo, upsertBySeverity } from "@/lib/format";

const LiveMap = dynamic(() => import("./LiveMap"), { ssr: false });

const QUEUE_SIZE = 8;

export default function Dashboard() {
  return (
    <AppShell
      title="Dashboard"
      roles={["dispatcher", "admin", "superadmin"]}
    >
      <DashboardBody />
    </AppShell>
  );
}

function DashboardBody() {
  const { token } = useAuth();
  const [issues, setIssues] = useState<Issue[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadStats = useCallback(async () => {
    try {
      const res = await api<{ data: Stats }>("/issues/stats");
      setStats(res.data);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const [list, s] = await Promise.all([
          api<Paged<Issue>>("/issues?limit=500", { signal: controller.signal }),
          api<{ data: Stats }>("/issues/stats", { signal: controller.signal }),
        ]);
        setIssues(list.data);
        setStats(s.data);
        setError(null);
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      }
    };
    load();
    return () => controller.abort();
  }, []);

  // Live: patch the list in place, briefly highlight the row, refresh stats (debounced).
  const handleEvent = useCallback(
    (event: IssueEvent) => {
      const { issue } = event;
      setIssues((list) =>
        issue.status === "resolved" ? list.filter((i) => i._id !== issue._id) : upsertBySeverity(list, issue)
      );
      setFlash((prev) => new Set(prev).add(issue._id));
      setTimeout(
        () =>
          setFlash((prev) => {
            const next = new Set(prev);
            next.delete(issue._id);
            return next;
          }),
        2500
      );
      if (statsTimer.current) clearTimeout(statsTimer.current);
      statsTimer.current = setTimeout(loadStats, 400);
    },
    [loadStats]
  );

  const { connected: live } = useIssueStream(token, handleEvent);

  const categories = stats ? Object.entries(stats.openByCategory) : [];

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <div className="stats">
        <StatBlock label="Active incidents" value={stats?.active} />
        <StatBlock label="High priority (hazards)" value={stats?.highPriority} color="var(--severity-high)" />
        <StatBlock label="Assigned staff" value={stats?.assignedStaff} />
        <StatBlock label="Resolved today" value={stats?.resolvedToday} />
      </div>

      <div className="main-grid">
        <section className="panel incidents-panel">
          <header className="panel-header">
            <h2 className="panel-title">Priority queue</h2>
            <Link href="/incidents" className="action-link">
              View full queue
            </Link>
          </header>

          <div className="queue-list">
            {issues.length === 0 && <div className="empty-state">No active incidents. New reports will appear here live.</div>}
            {issues.slice(0, QUEUE_SIZE).map((issue) => {
              const priority = priorityOf(issue.severityScore);
              return (
                <div className={`incident-row ${priority} ${flash.has(issue._id) ? "flash" : ""}`} key={issue._id}>
                  <div className="incident-details">
                    <div className="incident-title">
                      {priority === "high" && <span style={{ color: "var(--severity-high)", fontWeight: "bold" }}>[!]</span>}
                      {issueTitle(issue)}
                    </div>
                    <div className="incident-location">
                      {issueRef(issue)} | {issuePlace(issue)} | {issue.reportCount} report{issue.reportCount === 1 ? "" : "s"} |{" "}
                      {timeAgo(issue.lastReportedAt)}
                    </div>
                  </div>

                  <div className="incident-status-group">
                    <span className={`severity-text ${priority}`}>{issue.severityScore}</span>
                    <span className="status-text">
                      [{STATUS_LABEL[issue.status]}
                      {issue.assignedTo ? `: ${issue.assignedTo.name}` : ""}]
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel map-panel">
          <header className="panel-header">
            <h2 className="panel-title">Live map</h2>
            <span className={`live-badge ${live ? "on" : ""}`}>
              <span className="live-dot" /> {live ? "LIVE" : "OFFLINE"}
            </span>
          </header>
          <LiveMap issues={issues} centerOnUser />
        </section>
      </div>

      {stats && (
        <section className="panel analytics-panel">
          <header className="panel-header">
            <h2 className="panel-title">Open issues by category</h2>
            <span className="mono muted">
              {stats.duplicatesMerged} duplicate report{stats.duplicatesMerged === 1 ? "" : "s"} merged
              {stats.avgResolutionHours !== null && ` · avg resolution ${stats.avgResolutionHours}h`}
            </span>
          </header>
          <div className="category-grid">
            {categories.map(([category, { count, avgSeverity }]) => (
              <div key={category} className="category-cell">
                <span className="stat-label">{category === "infra" ? "Infrastructure" : category[0].toUpperCase() + category.slice(1)}</span>
                <span className="stat-value">{count}</span>
                <span className="mono muted">avg severity {avgSeverity}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

function StatBlock({ label, value, color }: { label: string; value?: number; color?: string }) {
  return (
    <div className="stat-block">
      <span className="stat-label">{label}</span>
      <span className="stat-value" style={color ? { color } : undefined}>
        {value ?? "–"}
      </span>
    </div>
  );
}
