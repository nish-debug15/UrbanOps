"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { errorMessage } from "@/lib/api";
import { homeFor, useAuth } from "@/lib/auth";

type Mode = "login" | "register" | "invite";

const COPY: Record<Mode, { title: string; submit: string }> = {
  login: {
    title: "Sign in",
    submit: "Sign in",
  },
  register: {
    title: "Create a citizen account",
    submit: "Create account",
  },
  invite: {
    title: "Register as a state admin",
    submit: "Create admin account",
  },
};

export default function LoginPage() {
  const { status, user, login, register, registerAdmin } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefillCode, setPrefillCode] = useState("");

  // Invite emails link here as /login?invite=ADM-...: open the invite tab with the code filled in.
  // Deferred a tick so hydration first renders the same "Sign in" tab the server did.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite");
    if (!code) return undefined;
    const timer = setTimeout(() => {
      setPrefillCode(code.trim().toUpperCase());
      setMode("invite");
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Already signed in → go to the right home page.
  useEffect(() => {
    if (status === "authenticated" && user) router.replace(homeFor(user.role, user.mustChangePassword));
  }, [status, user, router]);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") || "");
    const password = String(form.get("password") || "");
    const name = String(form.get("name") || "");
    setBusy(true);
    setError(null);
    try {
      const signedIn =
        mode === "login"
          ? await login(email, password)
          : mode === "register"
            ? await register(name, email, password)
            : await registerAdmin(String(form.get("code") || ""), name, email, password);
      router.replace(homeFor(signedIn.role, signedIn.mustChangePassword));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const copy = COPY[mode];

  return (
    <main className="report-page">
      <div className="report-container auth-container">
        <div className="report-header">
          <p className="eyebrow">URBANOPS COMMAND CENTER</p>
          <h1>{copy.title}</h1>
        </div>

        <div className="tabs" role="tablist">
          {(
            [
              ["login", "Sign in"],
              ["register", "Citizen sign-up"],
              ["invite", "State admin invite"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? "tab active" : "tab"}
              onClick={() => switchMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        <form className="report-form" onSubmit={handleSubmit} key={mode}>
          {error && <div className="alert error">{error}</div>}

          {mode === "invite" && (
            <div className="form-group">
              <label htmlFor="code">Invite code</label>
              <input
                id="code"
                name="code"
                type="text"
                required
                autoComplete="off"
                spellCheck={false}
                placeholder="ADM-XXXX-XXXX-XXXX"
                className="code-input"
                defaultValue={prefillCode}
              />
            </div>
          )}

          {mode !== "login" && (
            <div className="form-group">
              <label htmlFor="name">Full name</label>
              <input id="name" name="name" type="text" autoComplete="name" required maxLength={100} />
            </div>
          )}

          <div className="form-group">
            <label htmlFor="email">{mode === "invite" ? "Official email" : "Email"}</label>
            <input id="email" name="email" type="email" autoComplete="email" required />
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={mode === "login" ? undefined : 8}
              maxLength={72}
              required
            />
          </div>

          <button type="submit" className="submit-button" disabled={busy}>
            {busy ? "Please wait…" : copy.submit}
          </button>

          {mode === "login" && (
            <p className="auth-forgot">
              <Link href="/forgot-password" className="action-link">
                Forgot your password?
              </Link>
            </p>
          )}
        </form>

      </div>
    </main>
  );
}
