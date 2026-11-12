"use client";

/** Ask for a password reset link. The answer is the same whether or not the email has an account. */

import Link from "next/link";
import { FormEvent, useState } from "react";
import { api, errorMessage } from "@/lib/api";

export default function ForgotPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") || "").trim();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/forgot-password", { method: "POST", body: { email } });
      setSentTo(email);
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
          <h1>Reset your password</h1>
        </div>

        {sentTo ? (
          <div className="report-form">
            <div className="alert success">
              If an account exists for <strong>{sentTo}</strong>, a reset link is on its way. It works once and expires in 30
              minutes.
            </div>
            <Link href="/login" className="action-link">
              ← Back to sign in
            </Link>
          </div>
        ) : (
          <form className="report-form" onSubmit={handleSubmit}>
            {error && <div className="alert error">{error}</div>}
            <div className="form-group">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <button type="submit" className="submit-button" disabled={busy}>
              {busy ? "Please wait…" : "Send reset link"}
            </button>
            <p className="auth-forgot">
              <Link href="/login" className="action-link">
                ← Back to sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
