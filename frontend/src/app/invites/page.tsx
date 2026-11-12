"use client";

/**
 * Superadmin: states overview + admin invite codes.
 * An invite makes whoever registers with it the admin of that state. Codes are
 * single-use, expire, can be revoked, and are only ever shown once.
 */

import { FormEvent, useCallback, useEffect, useState } from "react";
import AppShell from "@/components/AppShell";
import { api, errorMessage } from "@/lib/api";
import { StateOptions, copyText } from "@/lib/regions";
import { timeAgo } from "@/lib/format";

type InviteStatus = "active" | "used" | "expired" | "revoked";
type Invite = {
  _id: string;
  codeHint: string;
  region: string;
  regionName: string;
  note?: string;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  usedAt?: string | null;
  usedBy?: { name: string; email: string } | null;
  createdBy?: { name: string } | null;
  sentTo?: string | null;
};
type RegionRow = { key: string; name: string; open: number; total: number; admins: number; dispatchers: number };
type Created = {
  code: string;
  regionName: string;
  expiresAt: string;
  emailedTo?: string | null;
  emailError?: string;
  previewUrl?: string;
};

export default function InvitesPage() {
  return (
    <AppShell title="States & invites" roles={["superadmin"]}>
      <Invites />
    </AppShell>
  );
}

function Invites() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [regions, setRegions] = useState<RegionRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      api<{ data: Invite[] }>("/invites", { signal: controller.signal }),
      api<{ data: RegionRow[] }>("/invites/regions", { signal: controller.signal }),
    ])
      .then(([inv, reg]) => {
        setInvites(inv.data);
        setRegions(reg.data);
        setError(null);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") setError(errorMessage(err));
      });
    return () => controller.abort();
  }, [reloadKey]);

  const revoke = async (invite: Invite) => {
    if (!window.confirm(`Revoke the ${invite.regionName} invite ${invite.codeHint}…? It will stop working immediately.`)) return;
    try {
      await api(`/invites/${invite._id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      {error && <div className="alert error">{error}</div>}

      <CreateInvite
        onCreated={(c) => {
          setCreated(c);
          reload();
        }}
      />
      {created && <CodeCard created={created} onDismiss={() => setCreated(null)} />}

      <section className="panel table-panel">
        <header className="panel-header">
          <h2 className="panel-title">States</h2>
        </header>
        <table className="users-table">
          <thead>
            <tr>
              <th>State</th>
              <th>Open issues</th>
              <th>Total</th>
              <th>Admins</th>
              <th>Dispatchers</th>
            </tr>
          </thead>
          <tbody>
            {regions.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-state">
                  No states yet.
                </td>
              </tr>
            )}
            {regions.map((r) => (
              <tr key={r.key} className={r.key === "unassigned" ? "row-warn" : r.admins === 0 && r.open > 0 ? "row-attention" : ""}>
                <td>
                  {r.name}
                  {r.key === "unassigned" && <span className="tag">location lookup failed: handle these yourself</span>}
                  {r.key !== "unassigned" && r.admins === 0 && <span className="tag">no admin yet</span>}
                </td>
                <td className="mono">{r.open}</td>
                <td className="mono">{r.total}</td>
                <td className="mono">{r.admins}</td>
                <td className="mono">{r.dispatchers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel table-panel">
        <header className="panel-header">
          <h2 className="panel-title">Admin invites</h2>
        </header>
        <table className="users-table">
          <thead>
            <tr>
              <th>Code</th>
              <th>State</th>
              <th>Status</th>
              <th>Sent to</th>
              <th>Note</th>
              <th>Created</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {invites.length === 0 && (
              <tr>
                <td colSpan={7} className="empty-state">
                  No invites yet.
                </td>
              </tr>
            )}
            {invites.map((inv) => (
              <tr key={inv._id}>
                <td className="mono small">{inv.codeHint}…</td>
                <td>{inv.regionName}</td>
                <td>
                  <span className={`status-pill ${inv.status}`}>{inv.status}</span>
                  <div className="mono muted small">
                    {inv.status === "used" && inv.usedBy
                      ? `by ${inv.usedBy.name} (${inv.usedBy.email})`
                      : inv.status === "active"
                        ? `expires ${new Date(inv.expiresAt).toLocaleDateString()}`
                        : ""}
                  </div>
                </td>
                <td className="mono small">{inv.sentTo || <span className="muted">by hand</span>}</td>
                <td className="small">{inv.note || "–"}</td>
                <td className="mono small">{timeAgo(inv.createdAt)}</td>
                <td className="row-actions">
                  {inv.status === "active" && (
                    <button type="button" className="btn-small danger" onClick={() => revoke(inv)}>
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function CreateInvite({ onCreated }: { onCreated: (c: Created) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    const email = String(form.get("email") || "").trim();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ code: string; invite: Invite; emailed: boolean; emailError?: string; previewUrl?: string }>(
        "/invites",
        {
          method: "POST",
          body: {
            state: form.get("state"),
            country: form.get("country") || "India",
            note: String(form.get("note") || "").trim() || undefined,
            expiresInDays: Number(form.get("days")) || 7,
            email: email || undefined,
          },
        }
      );
      onCreated({
        code: res.code,
        regionName: res.invite.regionName,
        expiresAt: res.invite.expiresAt,
        emailedTo: res.emailed ? email : null,
        emailError: email && !res.emailed ? res.emailError || "Email could not be sent" : undefined,
        previewUrl: res.previewUrl,
      });
      formEl.reset();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel inline-form" onSubmit={handleSubmit}>
      <header className="panel-header">
        <h2 className="panel-title">Create a state admin invite</h2>
      </header>
      <div className="inline-form-body">
        {error && <div className="alert error">{error}</div>}
        <div className="inline-fields">
          <label className="form-group">
            <span>State</span>
            <input name="state" list="invite-states" required placeholder="Tamil Nadu" />
            <StateOptions id="invite-states" />
          </label>
          <label className="form-group">
            <span>Country</span>
            <input name="country" defaultValue="India" required />
          </label>
          <label className="form-group">
            <span>Valid for</span>
            <select name="days" defaultValue="7">
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">7 days</option>
              <option value="14">14 days</option>
              <option value="30">30 days</option>
            </select>
          </label>
          <label className="form-group wide">
            <span>Email the code to (optional)</span>
            <input name="email" type="email" placeholder="official@tn.gov.in — leave empty to pass the code on yourself" />
          </label>
          <label className="form-group wide">
            <span>Note (who it&apos;s for)</span>
            <input name="note" maxLength={200} placeholder="e.g. TN Municipal Administration, Mr. Kumar" />
          </label>
        </div>
        <button type="submit" className="btn-small" disabled={busy}>
          {busy ? "Creating…" : "Create invite"}
        </button>
      </div>
    </form>
  );
}

function CodeCard({ created, onDismiss }: { created: Created; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const message =
    `You've been invited to be the UrbanOps admin for ${created.regionName}.\n` +
    `1. Open the UrbanOps sign-in page and choose "State admin invite".\n` +
    `2. Enter this code: ${created.code}\n` +
    `The code works once and expires on ${new Date(created.expiresAt).toLocaleDateString()}.`;
  return (
    <div className={`credential-card ${created.emailError ? "warn" : ""}`} role="status">
      <div>
        <strong>Invite created for {created.regionName}.</strong>{" "}
        {created.emailedTo
          ? `Emailed to ${created.emailedTo}. The code is also shown here in case you need to pass it on another way.`
          : created.emailError
            ? `Could not email it (${created.emailError}). Copy the code and send it yourself.`
            : "Copy it now: it will not be shown again."}
      </div>
      {created.previewUrl && (
        <div className="small">
          Development mode: the email wasn&apos;t delivered.{" "}
          <a href={created.previewUrl} target="_blank" rel="noreferrer">
            Open the preview
          </a>{" "}
          to see what the official would receive.
        </div>
      )}
      <div className="invite-code mono">{created.code}</div>
      <div className="credential-actions">
        <button type="button" className="btn-small" onClick={async () => setCopied(await copyText(message))}>
          {copied ? "Copied ✓" : "Copy invite message"}
        </button>
        <button type="button" className="btn-small secondary" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}
