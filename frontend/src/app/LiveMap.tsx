"use client";

import { useEffect, useState } from "react";
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

type Priority = "high" | "medium" | "low";

type Incident = {
  id: string;
  title: string;
  location: string;
  priority: Priority;
  reports: number;
  position: [number, number];
};

const incidents: Incident[] = [
  {
    id: "INC-1042",
    title: "Water leak",
    location: "MG Road, District 04",
    priority: "high",
    reports: 8,
    position: [12.9750, 77.6050],
  },
  {
    id: "INC-1041",
    title: "Road hazard",
    location: "12th Main, District 04",
    priority: "high",
    reports: 5,
    position: [12.9810, 77.6150],
  },
  {
    id: "INC-1040",
    title: "Pothole",
    location: "Church Street, District 03",
    priority: "medium",
    reports: 3,
    position: [12.9745, 77.6000],
  },
  {
    id: "INC-1039",
    title: "Street light",
    location: "Indiranagar, District 02",
    priority: "low",
    reports: 2,
    position: [12.9720, 77.6350],
  },
];

const createCivicIcon = (level: Priority) => {
  const pulseHtml =
    level === "high"
      ? '<div class="pulse-ring"></div>'
      : "";

  return L.divIcon({
    className: `civic-marker ${level}`,
    html: pulseHtml,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
};

const highPriorityIcon = createCivicIcon("high");
const mediumPriorityIcon = createCivicIcon("medium");
const lowPriorityIcon = createCivicIcon("low");

const getIcon = (priority: Priority) => {
  if (priority === "high") {
    return highPriorityIcon;
  }

  if (priority === "medium") {
    return mediumPriorityIcon;
  }

  return lowPriorityIcon;
};

export default function LiveMap() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);

    return () => {
      setIsMounted(false);
    };
  }, []);

  if (!isMounted) {
    return (
      <div
        className="map-wrapper"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span className="mono">
          Loading geospatial data...
        </span>
      </div>
    );
  }

  const position: [number, number] = [
    12.9716,
    77.5946,
  ];

  return (
    <div
      className="map-wrapper"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
      }}
    >
      <MapContainer
        center={position}
        zoom={13}
        scrollWheelZoom={true}
        style={{
          height: "100%",
          width: "100%",
        }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        {incidents.map((incident) => (
          <Marker
            key={incident.id}
            position={incident.position}
            icon={getIcon(incident.priority)}
          >
            <Popup>
              <div
                className="mono"
                style={{
                  fontSize: "12px",
                  lineHeight: "1.6",
                  minWidth: "180px",
                }}
              >
                <strong>
                  [{incident.id}] {incident.title}
                </strong>

                <br />

                {incident.location}

                <br />

                <span
                  style={{
                    color:
                      incident.priority === "high"
                        ? "#CC3333"
                        : incident.priority === "medium"
                        ? "#D97706"
                        : "#4A7C59",
                    fontWeight: 600,
                  }}
                >
                  PRIORITY:{" "}
                  {incident.priority.toUpperCase()}
                </span>

                <br />

                Reports: {incident.reports}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {/* Map Legend */}
      <div className="map-legend">
        <div className="legend-title">
          INCIDENT PRIORITY
        </div>

        <div className="legend-item">
          <span className="legend-marker high"></span>
          High
        </div>

        <div className="legend-item">
          <span className="legend-marker medium"></span>
          Medium
        </div>

        <div className="legend-item">
          <span className="legend-marker low"></span>
          Low
        </div>
      </div>

      {/* Incident Counter */}
      <div className="map-counter">
        <strong>{incidents.length}</strong>
        <span> active incidents</span>
      </div>
    </div>
  );
}