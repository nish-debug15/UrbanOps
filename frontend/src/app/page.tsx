import dynamic from 'next/dynamic';

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
      priority: "High",
      status: "Unassigned",
    },
    {
      id: "INC-1041",
      issue: "Road hazard",
      location: "12th Main, District 04",
      reports: 5,
      priority: "High",
      status: "Assigned",
    },
    {
      id: "INC-1040",
      issue: "Pothole",
      location: "Church Street, District 03",
      reports: 3,
      priority: "Medium",
      status: "In progress",
    },
    {
      id: "INC-1039",
      issue: "Street light",
      location: "Indiranagar, District 02",
      reports: 2,
      priority: "Low",
      status: "Resolved",
    },
  ];

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="logo">UrbanOps</div>

        <nav>
          <a className="nav-item active" href="#">
            Dashboard
          </a>
          <a className="nav-item" href="#">
            Incidents
          </a>
          <a className="nav-item" href="#">
            Live Map
          </a>
          <a className="nav-item" href="#">
            Crews
          </a>
          <a className="nav-item" href="#">
            Reports
          </a>
        </nav>

        <div className="sidebar-bottom">
          <div className="user">
            <div className="avatar">D</div>
            <div>
              <strong>Dispatcher</strong>
              <span>District 04</span>
            </div>
          </div>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">CITY OPERATIONS</p>
            <h1>Dashboard</h1>
          </div>

          <a href="/report" className="report-button">
  + Report incident
</a>
        </header>

        <div className="stats">
          <div className="stat-card">
            <span>Active incidents</span>
            <strong>12</strong>
            <small>+3 today</small>
          </div>

          <div className="stat-card">
            <span>High priority</span>
            <strong>4</strong>
            <small>Needs attention</small>
          </div>

          <div className="stat-card">
            <span>Assigned crews</span>
            <strong>8</strong>
            <small>6 currently active</small>
          </div>

          <div className="stat-card">
            <span>Resolved today</span>
            <strong>17</strong>
            <small>↑ 12% from yesterday</small>
          </div>
        </div>

        <div className="main-grid">
          <section className="panel incidents-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">PRIORITY QUEUE</p>
                <h2>Active incidents</h2>
              </div>

              <button className="text-button">View all →</button>
            </div>

            <div className="filters">
              <button className="filter active">All</button>
              <button className="filter">High priority</button>
              <button className="filter">Unassigned</button>
            </div>

            <div className="incident-list">
              {incidents.map((incident) => (
                <div className="incident" key={incident.id}>
                  <div className="incident-main">
                    <div className={`priority-dot ${incident.priority.toLowerCase()}`} />

                    <div>
                      <strong>{incident.issue}</strong>
                      <span>{incident.location}</span>
                    </div>
                  </div>

                  <div className="incident-meta">
                    <span>{incident.reports} reports</span>
                    <span className={`priority ${incident.priority.toLowerCase()}`}>
                      {incident.priority}
                    </span>
                    <span className="status">{incident.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="panel map-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">DISTRICT 04</p>
                <h2>Live map</h2>
              </div>

              <span className="live">
                <i /> Live
              </span>
            </div>

            <div className="map-container-wrapper" style={{ padding: "0 20px 20px" }}>
              <LiveMap />
            </div>
          </section>
        </div>

        <section className="panel workflow-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">WORKFLOW</p>
              <h2>How UrbanOps handles an incident</h2>
            </div>
          </div>

          <div className="workflow">
            <div>
              <b>01</b>
              <strong>Report received</strong>
              <span>Citizen submits location and issue details.</span>
            </div>

            <div>
              <b>02</b>
              <strong>Duplicates grouped</strong>
              <span>Nearby reports are combined into one incident.</span>
            </div>

            <div>
              <b>03</b>
              <strong>Priority calculated</strong>
              <span>Severity and report count determine urgency.</span>
            </div>

            <div>
              <b>04</b>
              <strong>Crew assigned</strong>
              <span>Dispatcher sends the right crew to the location.</span>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}