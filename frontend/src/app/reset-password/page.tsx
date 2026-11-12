"use client";

/** Landing page for the emailed reset link (/reset-password?token=…): choose a new password. */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { errorMessage } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";

export default function ResetPasswordPage() {
  const { resetPassword } = useAuth();
  const router = useRouter();
  // undefined until read on the client, so server and first client render match.
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("token");
    const timer = setTimeout(() => setToken(value), 0);
    return () => clearTimeout(timer);
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const next = String(form.get("next") || "");
    if (next !== String(form.get("confirm") || "")) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await resetPassword(token || "", next);
      router.replace(homeFor(user.role, user.mustChangePassword));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="report-page">
      <div className="report-container auth-container">
        <div className="report-header">
          <p className="eyebrow">URBANOPS COMMAND CENTER</p>
          <h1>Choose a new password</h1>
        </div>

        {token === null ? (
          <div className="report-form">
            <div className="alert error">This page needs the link from your reset email. Open that link again, or request a new one.</div>
            <Link href="/forgot-password" className="action-link">
              Request a new link
            </Link>
          </div>
        ) : (
          <form className="report-form" onSubmit={handleSubmit}>
            {error && (
              <div className="alert error">
                {error}{" "}
                <Link href="/forgot-password" className="action-link">
                  Request a new link
                </Link>
              </div>
            )}
            <div className="form-group">
              <label htmlFor="next">New password</label>
              <input id="next" name="next" type="password" autoComplete="new-password" minLength={8} maxLength={72} required />
            </div>
            <div className="form-group">
              <label htmlFor="confirm">Repeat new password</label>
              <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={8} maxLength={72} required />
            </div>
            <button type="submit" className="submit-button" disabled={busy || token === undefined}>
              {busy ? "Please wait…" : "Set password and sign in"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
