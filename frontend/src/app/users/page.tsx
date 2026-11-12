"use client";

/**
 * Team management.
 *  - State admin: their state's dispatchers and admins. Add a dispatcher (gets a
 *    one-time temporary password), reset a dispatcher's password, revoke access.
 *  - Superadmin: everyone in every state. Set roles (with a state), add
 *    dispatchers to any state, reset passwords.
 */

import { FormEvent, useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage, type Paged, type Role, type User } from "@/lib/api";
import { MANAGER_ROLES, useAuth } from "@/lib/auth";
import { StateOptions, copyText } from "@/lib/regions";

type Row = User & { createdAt?: string };
type Credential = {
  name: string;
  email: string;
  password: string;
  reason: "created" | "reset";
  emailed?: boolean;
  emailError?: string;
  previewUrl?: string;
};
type CredentialResponse = { user: User; temporaryPassword: string; emailed?: boolean; emailError?: string; previewUrl?: string };

const PAGE_SIZE = 25;

export default function TeamPage() {
  return (
    <AppShell title="Team" roles={MANAGER_ROLES}>
      <Team />
    </AppShell>
  );
}

function Team() {
  const { user: me } = useAuth();
  const isSuper = me?.role === "superadmin";
  const roleChoices: Role[] = isSuper ? ["citizen", "dispatcher", "admin", "superadmin"] : ["dispatcher", "admin"];

  const [roleFilter, setRoleFilter] = useState<Role | "">("");
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(query.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE) });
    if (roleFilter) params.set("role", roleFilter);
    if (search) params.set("q", search);
    api<Paged<Row>>(`/users?${params}`, { signal: controller.signal })
      .then((res) => {
        setRows(res.data);
        setTotal(res.total);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [page, roleFilter, search, reloadKey]);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  const act = async (row: Row, fn: () => Promise<void>) => {
    setBusyId(row._id);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  };

  const resetPassword = (row: Row) =>
    act(row, async () => {
      if (!window.confirm(`Reset ${row.name}'s password? They'll need the new temporary password to sign in.`)) return;
      const res = await api<CredentialResponse>(`/users/${row._id}/reset-password`, { method: "POST" });
      setCredential({
        name: row.name,
        email: row.email,
        password: res.temporaryPassword,
        reason: "reset",
        emailed: res.emailed,
        emailError: res.emailError,
        previewUrl: res.previewUrl,
      });
      reload();
    });

  const revoke = (row: Row) =>
    act(row, async () => {
      if (!window.confirm(`Remove ${row.name}'s staff access? Their account becomes a regular citizen account.`)) return;
      await api(`/users/${row._id}/role`, { method: "PATCH", body: { role: "citizen" } });
      setNotice(`${row.name} no longer has staff access.`);
      reload();
    });

  const setRole = (row: Row, role: Role) =>
    act(row, async () => {
      if (role === row.role) return;
      const body: Record<string, string> = { role };
      if ((role === "dispatcher" || role === "admin") && !row.region) {
        const state = window.prompt(`Which state will ${row.name} work in? (e.g. Karnataka)`);
        if (!state) return;
        body.state = state.trim();
        body.country = window.prompt("Country?", "India")?.trim() || "India";
      }
      if (role === "admin" && !window.confirm(`Make ${row.name} an admin with full control of their state?`)) return;
      const res = await api<{ user: Row }>(`/users/${row._id}/role`, { method: "PATCH", body });
      setNotice(`${row.name} is now ${role}${res.user.regionName ? ` in ${res.user.regionName}` : ""}.`);
      reload();
    });

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <AddDispatcher
        isSuper={isSuper}
        onCreated={(c) => {
          setCredential(c);
          setNotice(null);
          reload();
        }}
      />

      {credential && <CredentialCard credential={credential} onDismiss={() => setCredential(null)} />}
      {error && <div className="alert error">{error}</div>}
      {notice && <div className="alert success">{notice}</div>}

      <div className="map-filters">
        <div className="filter-group" role="group" aria-label="Role">
          {(["", ...roleChoices] as const).map((r) => (
            <button
              key={r || "all"}
              type="button"
              className={`chip ${roleFilter === r ? "on" : ""}`}
              aria-pressed={roleFilter === r}
              onClick={() => {
                setRoleFilter(r);
                setPage(1);
              }}
            >
              {r ? r[0].toUpperCase() + r.slice(1) + "s" : isSuper ? "Everyone" : "All staff"}
            </button>
          ))}
        </div>
        <label className="filter-search">
          <span className="sr-only">Search</span>
          <input type="search" placeholder="Search name or email…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <span className="mono muted filter-status">
          {total} account{total === 1 ? "" : "s"}
        </span>
      </div>

      <div className="panel">
        <table className="users-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              {isSuper && <th>State</th>}
              <th>Role</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={isSuper ? 5 : 4} className="empty-state">
                  No accounts match.
                </td>
              </tr>
            )}
            {rows.map((row) => {
              const isMe = row._id === me?._id;
              const manageable = !isMe && row.role !== "superadmin" && (isSuper || row.role === "dispatcher");
              return (
                <tr key={row._id}>
                  <td>
                    {row.name}
                    {isMe && <span className="mono muted small"> (you)</span>}
                    {row.mustChangePassword && <span className="tag">awaiting first sign-in</span>}
                  </td>
                  <td className="mono small">{row.email}</td>
                  {isSuper && <td className="small">{row.regionName || "–"}</td>}
                  <td>
                    {isSuper && manageable ? (
                      <select
                        className={`role-select ${row.role}`}
                        value={row.role}
                        disabled={busyId === row._id}
                        onChange={(e) => setRole(row, e.target.value as Role)}
                        aria-label={`Role for ${row.name}`}
                      >
                        {(["citizen", "dispatcher", "admin"] as Role[]).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`role-pill ${row.role}`}>{row.role}</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {manageable && row.role !== "citizen" && (
                      <button type="button" className="btn-small secondary" disabled={busyId === row._id} onClick={() => resetPassword(row)}>
                        Reset password
                      </button>
                    )}
                    {manageable && row.role === "dispatcher" && (
                      <button type="button" className="btn-small danger" disabled={busyId === row._id} onClick={() => revoke(row)}>
                        Revoke access
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="pager">
          <button type="button" className="btn-small secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ← Previous
          </button>
          <span className="mono small">
            Page {page} of {pages}
          </span>
          <button type="button" className="btn-small secondary" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}
    </>
  );
}

function AddDispatcher({ isSuper, onCreated }: { isSuper: boolean; onCreated: (c: Credential) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setBusy(true);
    setError(null);
    try {
      const res = await api<CredentialResponse>("/users/staff", {
        method: "POST",
        body: {
          name: form.get("name"),
          email: form.get("email"),
          ...(isSuper && { state: form.get("state"), country: form.get("country") || "India" }),
        },
      });
      onCreated({
        name: res.user.name,
        email: res.user.email,
        password: res.temporaryPassword,
        reason: "created",
        emailed: res.emailed,
        emailError: res.emailError,
        previewUrl: res.previewUrl,
      });
      formEl.reset();
      setOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="report-button add-staff-button" onClick={() => setOpen(true)}>
        [+] Add dispatcher
      </button>
    );
  }

  return (
    <form className="panel inline-form" onSubmit={handleSubmit}>
      <header className="panel-header">
        <h2 className="panel-title">New dispatcher</h2>
        <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Cancel">
          ✕
        </button>
      </header>
      <div className="inline-form-body">
        {error && <div className="alert error">{error}</div>}
        <div className="inline-fields">
          <label className="form-group">
            <span>Full name</span>
            <input name="name" required maxLength={100} />
          </label>
          <label className="form-group">
            <span>Email</span>
            <input name="email" type="email" required />
          </label>
          {isSuper && (
            <>
              <label className="form-group">
                <span>State</span>
                <input name="state" list="team-states" required placeholder="Karnataka" />
                <StateOptions id="team-states" />
              </label>
              <label className="form-group">
                <span>Country</span>
                <input name="country" defaultValue="India" required />
              </label>
            </>
          )}
        </div>
        <button type="submit" className="btn-small" disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>
      </div>
    </form>
  );
}

function CredentialCard({ credential, onDismiss }: { credential: Credential; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = `UrbanOps sign-in\nEmail: ${credential.email}\nTemporary password: ${credential.password}\nYou'll be asked to choose your own password at first sign-in.`;
  return (
    <div className={`credential-card ${credential.emailError ? "warn" : ""}`} role="status">
      <div>
        <strong>
          {credential.reason === "created" ? `Account created for ${credential.name}.` : `Password reset for ${credential.name}.`}
        </strong>{" "}
        {credential.emailed
          ? `Sign-in details were emailed to ${credential.email}. They're also shown here in case you need to pass them on another way.`
          : credential.emailError
            ? `Could not email them (${credential.emailError}). Give them these details yourself.`
            : "Give them these details. The password is shown only now."}
      </div>
      {credential.previewUrl && (
        <div className="small">
          Development mode: the email wasn&apos;t delivered.{" "}
          <a href={credential.previewUrl} target="_blank" rel="noreferrer">
            Open the preview
          </a>
          .
        </div>
      )}
      <div className="credential-values mono">
        <span>Email: {credential.email}</span>
        <span>
          Temporary password: <b>{credential.password}</b>
        </span>
      </div>
      <div className="credential-actions">
        <button
          type="button"
          className="btn-small"
          onClick={async () => {
            setCopied(await copyText(text));
          }}
        >
          {copied ? "Copied ✓" : "Copy details"}
        </button>
        <button type="button" className="btn-small secondary" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}
