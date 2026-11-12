"use client";

/**
 * Auth state for the whole app. The JWT lives in localStorage; on load it is
 * validated against GET /auth/me, which also returns what this role may do.
 * Any 401 from the API logs the user out.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, onUnauthorized, setApiToken, type Permissions, type Role, type User } from "./api";

const STORAGE_KEY = "urbanops-token";

type Status = "loading" | "authenticated" | "anonymous";

const NO_PERMISSIONS: Permissions = {
  transitions: {},
  canViewAllIssues: false,
  canReport: false,
  canManageStaff: false,
  canInviteAdmins: false,
  allRegions: false,
};

type AuthContextValue = {
  status: Status;
  user: User | null;
  token: string | null;
  permissions: Permissions;
  login: (email: string, password: string) => Promise<User>;
  register: (name: string, email: string, password: string) => Promise<User>;
  /** State admin registration with a superadmin invite code. */
  registerAdmin: (code: string, name: string, email: string, password: string) => Promise<User>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<User>;
  /** Finish a "forgot password" reset with the token from the email; signs the user in. */
  resetPassword: (token: string, newPassword: string) => Promise<User>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type AuthResponse = { token: string; user: User; permissions: Permissions };

const readToken = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

const writeToken = (token: string | null) => {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode): session-only login */
  }
};

type State = { status: Status; user: User | null; token: string | null; permissions: Permissions };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading", user: null, token: null, permissions: NO_PERMISSIONS });

  const applySession = useCallback((token: string | null, user: User | null, permissions?: Permissions) => {
    setApiToken(token);
    writeToken(token);
    setState({
      status: token && user ? "authenticated" : "anonymous",
      user,
      token,
      permissions: (token && user && permissions) || NO_PERMISSIONS,
    });
  }, []);

  const logout = useCallback(() => applySession(null, null), [applySession]);

  // Validate any stored token once on startup.
  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      const stored = readToken();
      if (!stored) {
        if (!cancelled) applySession(null, null);
        return;
      }
      setApiToken(stored);
      try {
        const { user, permissions } = await api<{ user: User; permissions: Permissions }>("/auth/me");
        if (!cancelled) applySession(stored, user, permissions);
      } catch {
        if (!cancelled) applySession(null, null);
      }
    };
    bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  useEffect(() => {
    onUnauthorized(logout);
    return () => onUnauthorized(null);
  }, [logout]);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api<AuthResponse>("/auth/login", { method: "POST", body: { email, password } });
      applySession(res.token, res.user, res.permissions);
      return res.user;
    },
    [applySession]
  );

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const res = await api<AuthResponse>("/auth/register", { method: "POST", body: { name, email, password } });
      applySession(res.token, res.user, res.permissions);
      return res.user;
    },
    [applySession]
  );

  const registerAdmin = useCallback(
    async (code: string, name: string, email: string, password: string) => {
      const res = await api<AuthResponse>("/auth/register-admin", { method: "POST", body: { code, name, email, password } });
      applySession(res.token, res.user, res.permissions);
      return res.user;
    },
    [applySession]
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      const res = await api<AuthResponse>("/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
      });
      applySession(res.token, res.user, res.permissions);
      return res.user;
    },
    [applySession]
  );

  const resetPassword = useCallback(
    async (token: string, newPassword: string) => {
      const res = await api<AuthResponse>("/auth/reset-password", { method: "POST", body: { token, newPassword } });
      applySession(res.token, res.user, res.permissions);
      return res.user;
    },
    [applySession]
  );

  const value = useMemo(
    () => ({ ...state, login, register, registerAdmin, changePassword, resetPassword, logout }),
    [state, login, register, registerAdmin, changePassword, resetPassword, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

export const isStaff = (role?: Role) => role === "dispatcher" || role === "admin" || role === "superadmin";
export const STAFF_ROLES: Role[] = ["dispatcher", "admin", "superadmin"];
export const MANAGER_ROLES: Role[] = ["admin", "superadmin"];

/** Where each user lands after login. */
export const homeFor = (role?: Role, mustChangePassword?: boolean) =>
  mustChangePassword ? "/change-password" : isStaff(role) ? "/" : "/my-reports";

export const ROLE_SUMMARY: Record<Role, string> = {
  citizen: "Report issues · track your reports",
  dispatcher: "One state · monitor, dispatch, resolve",
  admin: "One state · full oversight, manages dispatchers",
  superadmin: "All states · invites state admins",
};
