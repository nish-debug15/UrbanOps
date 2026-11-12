"use client";

/**
 * Small dependency-free SVG charts for the analytics page.
 * Every value shown on hover is also in the table under the chart.
 */

import { useState } from "react";

// Validated pair (colour-blind safe on white); text never uses these, only marks.
export const SERIES = {
  opened: { label: "Issues opened", color: "#2A6FBB" },
  resolved: { label: "Issues resolved", color: "#8A5A00" },
} as const;

const W = 720;
const H = 260;
const PAD = { top: 16, right: 110, bottom: 30, left: 40 };

/** A round axis maximum and step for whole-number counts. */
const niceScale = (max: number) => {
  if (max <= 4) return { top: 4, step: 1 };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough) ?? 10 * pow;
  return { top: Math.ceil(max / step) * step, step };
};

export const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

type Day = { date: string; issues: number; resolved: number };

export function DailyLineChart({ days }: { days: Day[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const { top, step } = niceScale(Math.max(1, ...days.map((d) => Math.max(d.issues, d.resolved))));

  const x = (i: number) => PAD.left + (days.length === 1 ? innerW / 2 : (i / (days.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - (v / top) * innerH;
  const path = (key: "issues" | "resolved") => days.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");

  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  const labelEvery = Math.max(1, Math.ceil(days.length / 6));

  const last = days[days.length - 1];
  // Keep the two end labels from overlapping when the lines finish close together.
  let openedY = y(last.issues);
  let resolvedY = y(last.resolved);
  if (Math.abs(openedY - resolvedY) < 14) {
    const mid = (openedY + resolvedY) / 2;
    const openedOnTop = last.issues >= last.resolved;
    openedY = mid + (openedOnTop ? -7 : 7);
    resolvedY = mid + (openedOnTop ? 7 : -7);
  }

  const pick = (clientX: number, target: SVGRectElement) => {
    const box = target.getBoundingClientRect();
    const ratio = (clientX - box.left) / box.width;
    setHover(Math.min(days.length - 1, Math.max(0, Math.round(ratio * (days.length - 1)))));
  };

  const active = hover === null ? null : days[hover];

  return (
    <figure className="chart">
      <div className="chart-legend" aria-hidden="true">
        {Object.values(SERIES).map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} /> {s.label}
          </span>
        ))}
      </div>

      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Issues opened and resolved per day. The same numbers are in the table below.">
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className={v === 0 ? "chart-axis" : "chart-grid"} />
              <text x={PAD.left - 8} y={y(v) + 4} textAnchor="end" className="chart-tick">
                {v}
              </text>
            </g>
          ))}
          {days.map(
            (d, i) =>
              (i % labelEvery === 0 || i === days.length - 1) &&
              // Skip a regular label that would collide with the final one.
              (i === days.length - 1 || days.length - 1 - i >= labelEvery / 2) && (
                <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" className="chart-tick">
                  {shortDate(d.date)}
                </text>
              )
          )}

          <path d={path("issues")} fill="none" stroke={SERIES.opened.color} strokeWidth={2} strokeLinejoin="round" />
          <path d={path("resolved")} fill="none" stroke={SERIES.resolved.color} strokeWidth={2} strokeLinejoin="round" />

          {/* Direct labels at the line ends, in text ink beside a colour key. */}
          <g className="chart-end-label">
            <circle cx={x(days.length - 1)} cy={y(last.issues)} r={4} fill={SERIES.opened.color} stroke="#fff" strokeWidth={2} />
            <circle cx={x(days.length - 1)} cy={y(last.resolved)} r={4} fill={SERIES.resolved.color} stroke="#fff" strokeWidth={2} />
            <text x={x(days.length - 1) + 10} y={openedY + 4}>
              Opened {last.issues}
            </text>
            <text x={x(days.length - 1) + 10} y={resolvedY + 4}>
              Resolved {last.resolved}
            </text>
          </g>

          {active && hover !== null && (
            <g pointerEvents="none">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} className="chart-crosshair" />
              <circle cx={x(hover)} cy={y(active.issues)} r={5} fill={SERIES.opened.color} stroke="#fff" strokeWidth={2} />
              <circle cx={x(hover)} cy={y(active.resolved)} r={5} fill={SERIES.resolved.color} stroke="#fff" strokeWidth={2} />
            </g>
          )}

          <rect
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            fill="transparent"
            tabIndex={0}
            aria-label="Daily values. Use the left and right arrow keys to move between days."
            onPointerMove={(e) => pick(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            onFocus={() => setHover((h) => h ?? days.length - 1)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              setHover((h) => {
                const from = h ?? days.length - 1;
                return Math.min(days.length - 1, Math.max(0, from + (e.key === "ArrowRight" ? 1 : -1)));
              });
            }}
          />
        </svg>

        {active && hover !== null && (
          <div
            className={`chart-tooltip ${x(hover) > W * 0.6 ? "left" : ""}`}
            style={{ left: `${(x(hover) / W) * 100}%` }}
            role="status"
          >
            <div className="chart-tooltip-title">{shortDate(active.date)}</div>
            <div>
              <i style={{ background: SERIES.opened.color }} /> <strong>{active.issues}</strong> opened
            </div>
            <div>
              <i style={{ background: SERIES.resolved.color }} /> <strong>{active.resolved}</strong> resolved
            </div>
          </div>
        )}
      </div>
    </figure>
  );
}

/** Ranked horizontal bars: one measure, one colour, value written beside each bar. */
export function RankedBars({ rows, unit }: { rows: { name: string; count: number }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul className="ranked-bars">
      {rows.map((row) => (
        <li key={row.name} title={`${row.name}: ${row.count} ${unit}`}>
          <span className="ranked-name">{row.name}</span>
          <span className="ranked-track">
            <span className="ranked-fill" style={{ width: `${(row.count / max) * 100}%` }} />
          </span>
          <span className="ranked-value mono">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}
