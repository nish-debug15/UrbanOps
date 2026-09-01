"use client";

import { FormEvent, useState } from "react";

export default function ReportIncident() {
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = new FormData(event.currentTarget);

    const incident = {
      id: `INC-${Math.floor(1000 + Math.random() * 9000)}`,
      issue: form.get("category"),
      location: form.get("location"),
      description: form.get("description"),
      status: "Unassigned",
      priority: "Medium",
      reports: 1,
    };

    const existing = JSON.parse(
      localStorage.getItem("urbanops-incidents") || "[]"
    );

    localStorage.setItem(
      "urbanops-incidents",
      JSON.stringify([incident, ...existing])
    );

    setSubmitted(true);
    event.currentTarget.reset();
  }

  if (submitted) {
    return (
      <main className="report-page">
        <div className="success-message">
          <div className="success-icon">✓</div>

          <p className="eyebrow">REPORT RECEIVED</p>

          <h1>Thanks. Your report has been submitted.</h1>

          <p>
            UrbanOps will check the report against nearby incidents and
            add it to the city's priority queue.
          </p>

          <div className="success-actions">
            <a href="/" className="submit-button">
              Return to dashboard
            </a>

            <button
              className="location-button"
              onClick={() => setSubmitted(false)}
            >
              Submit another report
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="report-page">
      <div className="report-container">
        <a href="/" className="back-link">
          ← Back to dashboard
        </a>

        <div className="report-header">
          <p className="eyebrow">CITIZEN REPORT</p>

          <h1>Report an infrastructure issue</h1>

          <p>
            Tell us what happened and where it happened. Your report
            helps the city identify and prioritize problems.
          </p>
        </div>

        <form className="report-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="category">What is the issue?</label>

            <select id="category" name="category" required>
              <option value="">Select an issue</option>
              <option value="Pothole">Pothole</option>
              <option value="Water leak">Water leak</option>
              <option value="Road hazard">Road hazard</option>
              <option value="Street light">Street light</option>
              <option value="Other">Other</option>
            </select>
          </div>

          <div className="form-group">
            <label htmlFor="location">Location</label>

            <input
              id="location"
              name="location"
              type="text"
              placeholder="Enter street, landmark or area"
              required
            />

            <button type="button" className="location-button">
              Use my current location
            </button>
          </div>

          <div className="form-group">
            <label htmlFor="description">What did you notice?</label>

            <textarea
              id="description"
              name="description"
              rows={5}
              placeholder="Briefly describe the problem..."
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="photo">Add a photo</label>

            <div className="upload-box">
              <input id="photo" name="photo" type="file" accept="image/*" />
              <span>Choose a photo from your device</span>
            </div>
          </div>

          <button type="submit" className="submit-button">
            Submit report
          </button>
        </form>
      </div>
    </main>
  );
}