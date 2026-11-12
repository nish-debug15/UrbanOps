"use client";

/**
 * Analytics (PRD §5: admin access). Trends over a chosen period for the admin's
 * state; a superadmin sees all states and can narrow to one.
 */

import { useEffect, useMemo, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type Analytics, type IssueCategory } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CATEGORY_LABEL } from "@/lib/issues";
import { DailyLineChart, RankedBars, shortDate } from "./charts";

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
];
const CATEGORIES: IssueCategory[] = ["hazard", "infra", "minor"];

/** "3.5 h" under two days, otherwise "4.2 days". */
const duration = (hours: number | null) =>
  hours === null ? "—" : hours < 48 ? `${hours} h` : `${Math.round((hours / 24) * 10) / 10} days`;

export default function AnalyticsPage() {
  return (
    <AppShell title="Analytics" roles={["admin", "superadmin"]}>
      <AnalyticsBody />
    </AppShell>
  );
}

function AnalyticsBody() {
  const { user, permissions } = useAuth();
  const [days, setDays] = useState(30);
  const [region, setRegion] = useState("");
  const [data, setData] = useState<Analytics | null>(null);
  const [regions, setRegions] = useState<{ region: string; regionName: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ days: String(days) });
    try {
      params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
      /* server falls back to UTC */
    }
    if (region) params.set("region", region);

    Promise.resolve().then(() => setLoading(true));
    api<{ data: Analytics }>(`/issues/analytics?${params}`, { signal: controller.signal })
      .then((res) => {
        setData(res.data);
        // The all-states answer lists every state: remember it for the picker.
        const byRegion = res.data.byRegion;
        if (byRegion) setRegions(byRegion.map(({ region: key, regionName }) => ({ region: key, regionName })));
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [days, region]);

  const scopeLabel = permissions.allRegions
    ? region
      ? regions.find((r) => r.region === region)?.regionName || region
      : "All states"
    : user?.regionName || "Your state";

  const hasActivity = useMemo(() => !!data && data.daily.some((d) => d.issues > 0 || d.resolved > 0), [data]);

  return (
    <>
      <div className="map-filters">
        <div className="filter-group" role="group" aria-label="Period">
          {RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className={`chip ${days === r.days ? "on" : ""}`}
              aria-pressed={days === r.days}
              onClick={() => setDays(r.days)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {permissions.allRegions && (
          <label className="filter-select">
            <span className="sr-only">State</span>
            <select value={region} onChange={(e) => setRegion(e.target.value)}>
              <option value="">All states</option>
              {regions.map((r) => (
                <option key={r.region} value={r.region}>
                  {r.regionName}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="filter-status">
          <span className="mono muted">{loading ? "Loading…" : scopeLabel}</span>
        </div>
      </div>

      {error && <div className="alert error">{error}</div>}

      {data && (
        <div className={loading ? "analytics is-loading" : "analytics"}>
          <div className="stats">
            <Stat label="Issues opened" value={data.totals.issues} />
            <Stat
              label="Citizen reports"
              value={data.totals.reports}
              note={
                data.totals.reports > data.totals.issues
                  ? `${data.totals.reports - data.totals.issues} merged as duplicates`
                  : "no duplicates merged"
              }
            />
            <Stat label="Issues resolved" value={data.totals.resolved} />
            <Stat label="Average time to resolve" value={duration(data.totals.avgResolutionHours)} />
          </div>

          <section className="panel">
            <header className="panel-header">
              <h2 className="panel-title">Opened and resolved per day</h2>
            </header>
            <div className="panel-body">
              {hasActivity ? (
                <DailyLineChart days={data.daily} />
              ) : (
                <div className="empty-state">No issues were opened or resolved in this period.</div>
              )}
              <details className="chart-table">
                <summary>Show the daily numbers as a table</summary>
                <table className="users-table data-table">
                  <thead>
                    <tr>
                      <th>Day</th>
                      <th>Issues opened</th>
                      <th>Citizen reports</th>
                      <th>Resolved</th>
                      <th>Avg time to resolve</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.daily].reverse().map((d) => (
                      <tr key={d.date}>
                        <td>{shortDate(d.date)}</td>
                        <td className="mono">{d.issues}</td>
                        <td className="mono">{d.reports}</td>
                        <td className="mono">{d.resolved}</td>
                        <td className="mono">{duration(d.avgResolutionHours)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            </div>
          </section>

          <div className="analytics-grid">
            <section className="panel">
              <header className="panel-header">
                <h2 className="panel-title">Most reported issue types</h2>
              </header>
              <div className="panel-body">
                {data.topTypes.length ? (
                  <RankedBars rows={data.topTypes} unit="issues" />
                ) : (
                  <div className="empty-state">Nothing reported in this period.</div>
                )}
              </div>
            </section>

            <section className="panel table-panel">
              <header className="panel-header">
                <h2 className="panel-title">By category</h2>
              </header>
              <table className="users-table data-table">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Opened</th>
                    <th>Resolved</th>
                    <th>Avg time to resolve</th>
                  </tr>
                </thead>
                <tbody>
                  {CATEGORIES.map((c) => (
                    <tr key={c}>
                      <td>{CATEGORY_LABEL[c]}</td>
                      <td className="mono">{data.byCategory[c]}</td>
                      <td className="mono">{data.resolutionByCategory[c].resolved}</td>
                      <td className="mono">{duration(data.resolutionByCategory[c].avgHours)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {data.byRegion && data.byRegion.length > 0 && (
            <section className="panel table-panel">
              <header className="panel-header">
                <h2 className="panel-title">By state</h2>
              </header>
              <table className="users-table data-table">
                <thead>
                  <tr>
                    <th>State</th>
                    <th>Active now</th>
                    <th>Opened in period</th>
                    <th>Resolved in period</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byRegion.map((r) => (
                    <tr key={r.region}>
                      <td>{r.regionName}</td>
                      <td className="mono">{r.active}</td>
                      <td className="mono">{r.created}</td>
                      <td className="mono">{r.resolved}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: number | string; note?: string }) {
  return (
    <div className="stat-block">
      <span className="stat-label">{label}</span>
      <span className="stat-value mono">{value}</span>
      {note && <span className="mono muted small">{note}</span>}
    </div>
  );
}
