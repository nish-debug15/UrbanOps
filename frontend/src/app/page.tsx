"use client";

import dynamic from 'next/dynamic';
import Link from 'next/link';

const LiveMap = dynamic(() => import('./LiveMap'), {
  ssr: false,
});

export default function Home() {
  const incidents = [
    {
      id: "INC-1042",
      issue: "Water leak",
      location: "MG Road, District 04",
      reports: 8,
      severity: "high",
      status: "Unassigned",
    },
    {
      id: "INC-1041",
      issue: "Road hazard",
      location: "12th Main, District 04",
      reports: 5,
      severity: "high",
      status: "Assigned: Crew 2",
    },
    {
      id: "INC-1040",
      issue: "Pothole",
      location: "Church Street, District 03",
      reports: 3,
      severity: "medium",
      status: "Assigned: Crew 4",
    },
    {
      id: "INC-1039",
      issue: "Street light",
      location: "Indiranagar, District 02",
      reports: 2,
      severity: "low",
      status: "Resolved",
    },
  ];

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo-container">
          <svg className="logo-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square">
            {/* Abstracted city grid 'U' */}
            <path d="M4 4v16h16V4" />
            <path d="M10 4v16" />
            <path d="M16 4v16" />
            <path d="M4 10h16" />
            <path d="M4 16h16" />
          </svg>
          <span className="logo-text">UrbanOps</span>
        </div>

        <nav>
          <Link href="#" className="nav-item active">Dashboard</Link>
          <Link href="#" className="nav-item">Incidents</Link>
          <Link href="#" className="nav-item">Live Map</Link>
          <Link href="#" className="nav-item">Crews</Link>
          <Link href="#" className="nav-item">Reports</Link>
        </nav>

        <div className="sidebar-bottom">
          <div className="user-info">
            <span className="user-name">ID: DISP-804</span>
            <span className="user-role">Operations / District 04</span>
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <h1 className="page-title">Dashboard</h1>
          <Link href="/report" className="report-button">
            [+] Report incident
          </Link>
        </header>

        <div className="stats">
          <div className="stat-block">
            <span className="stat-label">Active incidents</span>
            <span className="stat-value">12</span>
          </div>

          <div className="stat-block">
            <span className="stat-label">High priority</span>
            <span className="stat-value" style={{ color: 'var(--severity-high)' }}>4</span>
          </div>

          <div className="stat-block">
            <span className="stat-label">Assigned crews</span>
            <span className="stat-value">8</span>
          </div>

          <div className="stat-block">
            <span className="stat-label">Resolved today</span>
            <span className="stat-value">17</span>
          </div>
        </div>

        <div className="main-grid">
          <section className="panel incidents-panel">
            <header className="panel-header">
              <h2 className="panel-title">Priority queue</h2>
              <button className="action-link">View full queue</button>
            </header>

            <div className="queue-list">
              {incidents.map((incident) => (
                <div className={`incident-row ${incident.severity}`} key={incident.id}>
                  <div className="incident-details">
                    <div className="incident-title">
                      {incident.severity === 'high' && <span style={{ color: 'var(--severity-high)', fontWeight: 'bold' }}>[!]</span>}
                      {incident.issue}
                    </div>
                    <div className="incident-location">
                      {incident.id} | {incident.location} | {incident.reports} reports
                    </div>
                  </div>

                  <div className="incident-status-group">
                    <span className={`severity-text ${incident.severity}`}>
                      {incident.severity.toUpperCase()}
                    </span>
                    <span className={`status-text ${incident.status === 'Resolved' ? 'resolved' : ''}`}>
                      [{incident.status}]
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel map-panel">
            <header className="panel-header">
              <h2 className="panel-title">Live map</h2>
              <span className="mono" style={{ fontSize: '13px', color: 'var(--text-muted)' }}>BENGALURU</span>
            </header>

            <LiveMap />
          </section>
        </div>
      </section>
    </main>
  );
}