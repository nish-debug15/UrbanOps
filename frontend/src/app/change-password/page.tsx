"use client";

/**
 * Set a new password. Required at first sign-in for accounts an admin created
 * with a temporary password; available to everyone otherwise.
 */

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import AppShell from "@/components/AppShell";
import { errorMessage } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";

export default function ChangePasswordPage() {
  return (
    <AppShell title="Set your password">
      <ChangePasswordForm />
    </AppShell>
  );
}

function ChangePasswordForm() {
  const { user, changePassword } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = !!user?.mustChangePassword;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const current = String(form.get("current") || "");
    const next = String(form.get("next") || "");
    const confirm = String(form.get("confirm") || "");
    if (next !== confirm) {
      setError("The new passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await changePassword(current, next);
      router.replace(homeFor(updated.role));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="report-container narrow-form">
      {forced && (
        <div className="alert">
          Welcome{user ? `, ${user.name}` : ""}. Your account was created by your state admin with a temporary password.
          Choose your own password to continue.
        </div>
      )}
      <form className="report-form" onSubmit={handleSubmit}>
        {error && <div className="alert error">{error}</div>}
        <div className="form-group">
          <label htmlFor="current">{forced ? "Temporary password" : "Current password"}</label>
          <input id="current" name="current" type="password" autoComplete="current-password" required />
        </div>
        <div className="form-group">
          <label htmlFor="next">New password</label>
          <input id="next" name="next" type="password" autoComplete="new-password" minLength={8} maxLength={72} required />
        </div>
        <div className="form-group">
          <label htmlFor="confirm">Repeat new password</label>
          <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={72} required />
        </div>
        <button type="submit" className="submit-button" disabled={busy}>
          {busy ? "Saving…" : "Save password"}
        </button>
      </form>
    </div>
  );
}
