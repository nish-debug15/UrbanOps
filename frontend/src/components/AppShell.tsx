"use client";

/**
 * Sidebar layout + route guard. Redirects anonymous users to /login and users
 * without one of `roles` to their own home page. The API enforces the same
 * rules; this only keeps people off screens they can't use.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import type { Role } from "@/lib/api";
import { homeFor, isStaff, useAuth } from "@/lib/auth";

type Props = {
  title: string;
  roles?: Role[];
  actions?: React.ReactNode;
  children: React.ReactNode;
};

const STAFF_NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/incidents", label: "Incidents" },
  { href: "/livemap", label: "Live Map" },
];

const MANAGER_NAV = [
  { href: "/analytics", label: "Analytics" },
  { href: "/users", label: "Team" },
];
const SUPERADMIN_NAV = [{ href: "/invites", label: "States & invites" }];

const COMMON_NAV = [
  { href: "/report", label: "Report issue" },
  { href: "/my-reports", label: "My reports" },
];

export default function AppShell({ title, roles, actions, children }: Props) {
  const { status, user, permissions, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  // Accounts with a temporary password can only use the change-password page.
  const passwordGate = !!user?.mustChangePassword && pathname !== "/change-password";
  const allowed = status === "authenticated" && user && !passwordGate && (!roles || roles.includes(user.role));

  useEffect(() => {
    if (status === "anonymous") router.replace("/login");
    else if (status === "authenticated" && user) {
      if (user.mustChangePassword && pathname !== "/change-password") router.replace("/change-password");
      else if (roles && !roles.includes(user.role)) router.replace(homeFor(user.role));
    }
  }, [status, user, roles, router, pathname]);

  if (!allowed) {
    return (
      <main className="loading-screen">
        <span className="mono">Loading…</span>
      </main>
    );
  }

  // Navigation follows the hierarchy: citizen < dispatcher < admin.
  const nav = user.mustChangePassword
    ? []
    : [
        ...(isStaff(user.role) ? STAFF_NAV : []),
        ...(user.role === "admin" || user.role === "superadmin" ? MANAGER_NAV : []),
        ...(user.role === "superadmin" ? SUPERADMIN_NAV : []),
        // Reporting is for citizens; staff act on issues instead.
        ...(permissions.canReport ? COMMON_NAV : []),
      ];
  const jurisdiction =
    user.role === "superadmin" ? "All states" : isStaff(user.role) ? user.regionName || "No state assigned" : null;

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo-container">
          <span className="logo-text">UrbanOps</span>
        </div>

        <nav>
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className={`nav-item ${pathname === item.href ? "active" : ""}`}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="user-info">
            <span className="user-name">{user.name}</span>
            <span className={`role-pill ${user.role}`}>{user.role}</span>
            {jurisdiction && <span className="jurisdiction">🏛 {jurisdiction}</span>}
            <button
              type="button"
              className="location-button logout-button"
              onClick={() => {
                logout();
                router.replace("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <h1 className="page-title">{title}</h1>
          {actions}
        </header>
        {children}
      </section>
    </main>
  );
}
