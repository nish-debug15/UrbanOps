# UrbanOps — Product Requirements Document

**Team:** Nishit Patel (1RUA24SCS0068), Pragun Lal Shrestha (1RUA24SCS0072), Pranav Adhikari (1RUA24SCS0077), Unique Bhakta Shrestha (1RUA24SCS0118), Sameera Simha (1RUA24SCS0099)  
**Course:** 5th Semester Full-Stack Development, Team Project  
**Stack:** MERN (MongoDB, Express, React/Next.js, Node.js) + React Native + Socket.io  

## 1. Overview
UrbanOps is a web-based command center that lets city officials manage citizen-reported infrastructure issues in real time. It is the second phase of a two-semester project: last semester's **UrbanLens** was a mobile app that let citizens photograph and geo-tag problems (potholes, water leaks, broken infrastructure). UrbanLens solved reporting; it did nothing about triage. When fifty citizens report the same pothole, UrbanLens produces fifty identical tickets in the database with no way to tell they're the same issue.

UrbanOps closes that gap. It sits between citizen reports and city dispatchers, automatically deduplicating overlapping reports, scoring them by severity, and pushing live updates to a dispatcher dashboard the moment something changes.

## 2. Problem Statement
Raw citizen-reported data is noisy and unprioritized:
* **Duplication:** the same physical issue gets reported independently by many citizens, since there's no shared context between reporters.
* **No prioritization:** a minor overflowing bin and a collapsed water main both look identical in a flat list — nothing signals which one is more urgent.
* **No real-time visibility:** without live updates, dispatchers must manually refresh or poll to catch new issues, delaying response.

## 3. Goals

| # | Goal |
|---|---|
| 1 | Automatically deduplicate incoming reports using location + category, so the same physical issue never creates multiple tickets |
| 2 | Compute an explainable, formula-based severity score that accounts for report volume and recency |
| 3 | Push new/updated issues to dispatchers in real time, without polling |
| 4 | Provide a simple Kanban workflow (Open → Dispatched → Resolved) for issue lifecycle tracking |
| 5 | Serve three role-gated clients (citizen mobile app, citizen web portal, admin/dispatcher dashboard) from a single unified API |

## 4. Non-Goals (Explicit Scope Cuts)
Cutting scope deliberately, and documenting why, is part of the deliverable — not a gap:
* **Multi-stop route optimization for repair crews.** This is a Vehicle Routing Problem (VRP), which is NP-hard — not solvable from scratch as a side feature in a 12–15 week semester project. Production version would integrate an existing routing API (OSRM or Google Directions) rather than a custom solver. v1 uses a Kanban board instead of auto-routing.
* **Ward-boundary-based WebSocket rooms.** Segmenting live updates by named municipal ward requires GeoJSON polygon boundary data as a hard external dependency, plus reverse-geocoding on every report. Geohash-prefix rooms achieve the same spatial segmentation (dispatchers only get updates near them) without that dependency.
* **AI-based photo masking** (face/license plate blurring via YOLO). Marked as stretch scope only. It runs as a separate Python microservice, decoupled from the core Express API, and is explicitly the first thing cut if the team falls behind schedule in weeks 9–10.

## 5. User Roles & Permissions

| Role | Client(s) | Permissions |
|---|---|---|
| **Citizen** | Mobile app, Web portal | Submit reports with photo + GPS; view status of their own submitted reports |
| **Dispatcher** | Admin dashboard | View live map/heatmap of open issues; move issues through Kanban states; assign issues to crews |
| **Admin** | Admin dashboard | All dispatcher permissions + user management + analytics access |

> Role is stored on the `users` collection and enforced via JWT claims checked at the API layer — clients never enforce authorization themselves.

## 6. Core Functional Requirements

### 6.1 Geospatial Deduplication
On every new report submission:
1. Run a MongoDB `$geoNear` aggregation centered on the report's coordinates, `maxDistance: 100 meters`.
2. Pipe results through a `$match` stage filtering on identical category (a pothole cannot merge with a water leak just because they're nearby).
3. Also filter `status != resolved` — a resolved issue shouldn't silently absorb a new report of a recurring problem.
4. **Match found:** increment `duplicateCount`, push the new reporter's ID to `reporterIds`, update `lastReportedAt`, recompute `severityScore`. No new document created.
5. **No match:** insert a new `issues` document, compute and store its `geohash`, emit a `new_issue` WebSocket event.

*Known limitation (documented, not blocking):* pure radius-based matching can still false-positive across physical barriers (e.g., two reports 90m apart but on opposite sides of a highway). Acceptable for v1; road-segment-aware matching is a future improvement.

### 6.2 Severity Scoring
`severity = baseWeight + (duplicateCount × multiplier) − (hoursSinceLastReport × decayRate)`

* Floored at `baseWeight` — severity never drops below the category's base regardless of decay.
* **Base weights:** hazard = 50, infra = 30, minor = 10.
* **Multiplier:** 5 (tunable).
* **Decay rate:** 0.5/hour (tunable) — stale, un-reoccurring issues naturally rank lower over time without being deleted.
* Score is recalculated on every duplicate hit and on a periodic decay tick (e.g., cron job or on-read recompute).

### 6.3 Live Dashboard Updates
* Socket.io server running alongside Express.
* On dashboard login, dispatcher's client computes relevant geohash prefix(es) for their coverage area and joins that room (`socket.join(geohash)`).
* On new issue creation or duplicate-triggered severity change, backend emits the event only to the matching geohash room(s) — never a global broadcast.
* This avoids both the GeoJSON-boundary dependency of ward-based rooms and the server load of naive broadcast-to-all.

### 6.4 Kanban Workflow
* Three states: **Open → Dispatched → Resolved**.
* State transitions are dispatcher/admin-only, performed via drag-and-drop or button action on the dashboard.
* No automatic state transitions — a human always moves an issue forward.

### 6.5 Three-Client Architecture
* **Mobile app (React Native):** citizen report submission + status tracking. Carried over/refactored from UrbanLens, now talks to the new Express API instead of any prior backend (e.g., Firebase).
* **Web portal (Next.js):** citizen-facing alternative to the mobile app — report form, map view, personal dashboard.
* **Admin dashboard (Next.js, role-gated):** dispatcher/admin only — live map, heatmap, Kanban board, analytics.
* **Hard rule:** all three clients talk only to the Express API. None of them ever directly touch MongoDB, S3, or the Python AI service.

> Each module inside the Express server is a folder of routes + controllers — not a separate microservice. Only the Python AI component (stretch) is a genuinely separate service, deliberately isolated so it can be dropped without touching the core API.

## 7. Data Model (Summary)
* **users** — `_id`, `name`, `email` (unique), `passwordHash`, `role` (citizen/dispatcher/admin), `ward` (optional), `createdAt`
* **issues** — `_id`, `category` (hazard/infra/minor), `subcategory`, `description`, `images` (original + masked S3 URLs), `location` (GeoJSON Point, 2dsphere indexed), `geohash` (indexed), `status` (open/dispatched/resolved), `duplicateCount`, `reporterIds` (FK array → users), `lastReportedAt`, `severityScore`, `assignedTo` (FK → users, nullable), `createdAt`, `updatedAt`

**Indexes:** `location` (2dsphere), `geohash`, compound `status` + `severityScore` (for sorted dispatcher queries), `email` (unique)

## 8. Success Metrics
* Deduplication correctly merges same-category reports within 100m, and does not merge different-category reports at the same location.
* Dashboard reflects new or updated issues without a manual refresh, within the dispatcher's geohash room.
* Severity score for any given issue is reproducible by hand from the stored formula inputs — no hidden heuristics.
* Kanban state changes persist and are reflected across all connected dispatcher sessions.

## 9. Timeline (12–15 weeks)

| Weeks | Milestone |
|---|---|
| 1–2 | Backend foundation — Express API, MongoDB, JWT auth, geospatial index |
| 3–4 | Dedup + severity engine — `$geoNear` pipeline, scoring formula |
| 5–6 | Live dashboard — React map, Socket.io, geohash rooms |
| 7–8 | Citizen web portal — report form, Kanban board, heatmap |
| 9–10 | AI photo masking (stretch — cut first if behind) |
| 11–15 | Testing, deployment, documentation, presentation prep |

## 10. Risks

| Risk | Mitigation |
|---|---|
| Radius-only dedup false-merges unrelated issues | Category compound filter added; road-segment awareness noted as future work |
| VRP routing looks like a "nice to have" scope creep | Explicitly cut in v1; documented as production integration point (OSRM/Google Directions) |
| Python AI service adds a second language/deploy surface | Isolated as stretch, decoupled from core API — droppable without refactor |
| WebSocket broadcast overload at scale | Geohash-room segmentation limits event fan-out |
