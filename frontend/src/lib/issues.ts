/**
 * Issue workflow helpers shared by the Kanban board and the ops map.
 * Which moves a user may make comes from the server (`permissions.transitions`).
 */

import { api, type HistoryEntry, type Issue, type IssueCategory, type IssueStatus, type Permissions } from "./api";
import { STATUS_LABEL } from "./format";

/** Every transition that exists for anyone (admin's set). Used to explain denials. */
const ALL_TRANSITIONS: Record<IssueStatus, IssueStatus[]> = {
  open: ["dispatched", "resolved"],
  dispatched: ["resolved", "open"],
  resolved: ["open"],
};

export const allowedMoves = (permissions: Permissions, from: IssueStatus): IssueStatus[] =>
  permissions.transitions[from] ?? [];

/** Why a move isn't possible for this user, or null if it is. */
export const moveDenial = (permissions: Permissions, from: IssueStatus, to: IssueStatus): string | null => {
  if (from === to) return null;
  if (allowedMoves(permissions, from).includes(to)) return null;
  if (ALL_TRANSITIONS[from].includes(to)) {
    return from === "resolved"
      ? "Only an admin can reopen a resolved issue."
      : "Only an admin can close an issue without dispatching it first.";
  }
  return `An issue can't move from ${STATUS_LABEL[from]} to ${STATUS_LABEL[to]}.`;
};

export const ACTION_LABEL: Record<string, string> = {
  "open>dispatched": "Dispatch →",
  "open>resolved": "Close",
  "dispatched>resolved": "Resolve ✓",
  "dispatched>open": "← Undo dispatch",
  "resolved>open": "Reopen",
};

export const CATEGORY_LABEL: Record<IssueCategory, string> = {
  hazard: "Hazard",
  infra: "Infrastructure",
  minor: "Minor",
};

export type IssuePatch = { status?: IssueStatus; assignedTo?: string | null; note?: string };

// Must match the API (services/storage.js).
export const MAX_PHOTOS_PER_UPLOAD = 3;
export const MAX_PHOTO_MB = 5;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** Keep the files the API will accept; describe the ones it won't. */
export const checkPhotos = (files: File[], room: number) => {
  const problems: string[] = [];
  const accepted: File[] = [];
  for (const file of files) {
    if (!PHOTO_TYPES.includes(file.type)) problems.push(`${file.name} is not a JPEG, PNG or WebP image`);
    else if (file.size > MAX_PHOTO_MB * 1024 * 1024) problems.push(`${file.name} is larger than ${MAX_PHOTO_MB} MB`);
    else accepted.push(file);
  }
  if (accepted.length > room) problems.push(`You can attach up to ${MAX_PHOTOS_PER_UPLOAD} photos at a time`);
  return { accepted: accepted.slice(0, Math.max(0, room)), error: problems.length ? `${problems.join(". ")}.` : null };
};

/**
 * Update an issue. `photos` are "after" pictures of the fix: allowed when resolving,
 * or on an issue that is already resolved. With photos the request is multipart.
 */
export const patchIssue = (id: string, body: IssuePatch, photos: File[] = []) => {
  if (!photos.length) return api<{ issue: Issue }>(`/issues/${id}`, { method: "PATCH", body }).then((r) => r.issue);
  const form = new FormData();
  if (body.status) form.set("status", body.status);
  if (body.note) form.set("note", body.note);
  if (typeof body.assignedTo === "string") form.set("assignedTo", body.assignedTo);
  photos.forEach((file) => form.append("photos", file));
  return api<{ issue: Issue }>(`/issues/${id}`, { method: "PATCH", body: form }).then((r) => r.issue);
};

export const fetchIssue = (id: string, signal?: AbortSignal) =>
  api<{ issue: Issue }>(`/issues/${id}`, { signal }).then((r) => r.issue);

/** Body for a status move. Dispatching an unassigned issue assigns it to the actor. */
export const moveBody = (issue: Issue, status: IssueStatus, actorId?: string, note?: string): IssuePatch => {
  const body: IssuePatch = { status };
  if (status === "resolved" && note?.trim()) body.note = note.trim();
  if (status === "dispatched" && !issue.assignedTo && actorId) body.assignedTo = actorId;
  return body;
};

/** One line per history entry, e.g. "Asha (dispatcher) dispatched it". */
export const describeHistory = (e: HistoryEntry) => {
  const who = `${e.byName || "Someone"}${e.byRole ? ` (${e.byRole})` : ""}`;
  if (e.action === "photos") return `${who} added ${e.to === "1" ? "a photo" : `${e.to} photos`} of the fix`;
  if (e.action === "assignment") return e.to ? `${who} assigned it to ${e.toName || "a staff member"}` : `${who} unassigned it`;
  const verb: Record<string, string> = {
    "open>dispatched": "dispatched it",
    "dispatched>resolved": "resolved it",
    "open>resolved": "closed it without dispatch",
    "dispatched>open": "undid the dispatch",
    "resolved>open": "reopened it",
  };
  const what = `${who} ${verb[`${e.from}>${e.to}`] || `moved it to ${e.to}`}`;
  return e.note ? `${what}: “${e.note}”` : what;
};
