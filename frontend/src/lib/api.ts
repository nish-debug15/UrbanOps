/**
 * Typed client for the UrbanOps Express API.
 * The base URL comes from NEXT_PUBLIC_API_URL (see frontend/.env.example).
 */

export const API_URL = (process.env.NEXT_PUBLIC_API_URL || "http://localhost:5000").replace(/\/$/, "");

export type Role = "citizen" | "dispatcher" | "admin" | "superadmin";
export type IssueStatus = "open" | "dispatched" | "resolved";
export type IssueCategory = "hazard" | "infra" | "minor";

export type User = {
  _id: string;
  name: string;
  email: string;
  role: Role;
  ward?: string;
  /** State this staff member works in, e.g. "india/karnataka" (null for citizens/superadmin). */
  region?: string | null;
  regionName?: string | null;
  mustChangePassword?: boolean;
};

export type StaffRef = { _id: string; name: string; email: string; role: Role };

/** Sent by the API at login and /auth/me. The API enforces the same rules. */
export type Permissions = {
  transitions: Partial<Record<IssueStatus, IssueStatus[]>>;
  canViewAllIssues: boolean;
  /** Only citizens file reports; staff act on them. */
  canReport: boolean;
  /** admin (own state) and superadmin */
  canManageStaff: boolean;
  /** superadmin only */
  canInviteAdmins: boolean;
  /** superadmin sees every state */
  allRegions: boolean;
};

export type HistoryEntry = {
  action: "status" | "assignment" | "photos";
  from: string | null;
  to: string | null;
  toName?: string | null;
  /** Resolution note, on the entry that resolved the issue. */
  note?: string;
  by: string;
  byName?: string;
  byRole?: Role;
  at: string;
};

/**
 * A report photo. `masked` has faces and number plates blurred (it equals `original`
 * when there was nothing to blur). Staff get both; citizens get `masked` only, or
 * `original` only when the server runs without photo masking.
 */
export type IssuePhoto = { original?: string; masked?: string };

export type Issue = {
  _id: string;
  category: IssueCategory;
  subcategory?: string;
  description?: string;
  address?: string;
  location: { type: "Point"; coordinates: [number, number] }; // [lng, lat]
  geohash: string;
  status: IssueStatus;
  duplicateCount: number;
  reportCount: number;
  severityScore: number;
  lastReportedAt: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string | null;
  /** What staff did to fix it (shown to reporters). */
  resolutionNote?: string | null;
  /** Report photos: paths on the API server, see assetUrl(). */
  images?: IssuePhoto[];
  /** "After" photos added by staff as proof of the fix. */
  resolutionImages?: IssuePhoto[];
  assignedTo?: StaffRef | null;
  reporterIds?: unknown[];
  reportedByMe?: boolean;
  history?: HistoryEntry[];
  region?: string;
  regionName?: string;
};

export type Paged<T> = { success: true; data: T[]; page: number; limit: number; total: number };

export type Stats = {
  active: number;
  byStatus: Record<IssueStatus, number>;
  openByCategory: Record<IssueCategory, { count: number; avgSeverity: number }>;
  highPriority: number;
  assignedStaff: number;
  resolvedToday: number;
  avgResolutionHours: number | null;
  duplicatesMerged: number;
};

/** An open issue close to a point (GET /issues/nearby), with its distance in meters. */
export type NearbyIssue = Issue & { distance: number };

export type AnalyticsDay = {
  date: string; // YYYY-MM-DD
  issues: number;
  reports: number;
  resolved: number;
  avgResolutionHours: number | null;
};

export type Analytics = {
  days: number;
  timezone: string;
  from: string;
  to: string;
  totals: { issues: number; reports: number; resolved: number; avgResolutionHours: number | null };
  daily: AnalyticsDay[];
  byCategory: Record<IssueCategory, number>;
  resolutionByCategory: Record<IssueCategory, { resolved: number; avgHours: number | null }>;
  topTypes: { name: string; count: number }[];
  /** Only when a superadmin looks at all states. */
  byRegion: { region: string; regionName: string; active: number; created: number; resolved: number }[] | null;
};

/** Absolute URL of a file served by the API (report photos are stored as "/uploads/…"). */
export const assetUrl = (path: string) => (/^https?:\/\//.test(path) ? path : `${API_URL}${path}`);

export type ReportResult = {
  success: true;
  merged: boolean;
  alreadyReported: boolean;
  message: string;
  issue: Issue;
};

export class ApiError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

let authToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

export const setApiToken = (token: string | null) => {
  authToken = token;
};

/** Called when an authenticated request comes back 401 (expired/invalid token). */
export const onUnauthorized = (handler: (() => void) | null) => {
  unauthorizedHandler = handler;
};

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

export async function api<T>(path: string, { method = "GET", body, signal }: Options = {}): Promise<T> {
  let res: Response;
  // FormData (file uploads) is sent as-is: the browser sets the multipart boundary.
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  try {
    res = await fetch(`${API_URL}/api/v1${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined && !isForm && { "Content-Type": "application/json" }),
        ...(authToken && { Authorization: `Bearer ${authToken}` }),
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, `Cannot reach the UrbanOps server at ${API_URL}. Is the backend running?`);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && authToken && unauthorizedHandler) unauthorizedHandler();
    const message =
      (Array.isArray(data.details) && data.details.every((d: unknown) => typeof d === "string")
        ? data.details.join("; ")
        : data.error) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message, data.details);
  }
  return data as T;
}

export const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : "Something went wrong";
