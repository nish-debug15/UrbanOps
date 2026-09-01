"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

const createPriorityIcon = (color: string) => {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="background-color: ${color}; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.4);"></div>`,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
};

const highPriorityIcon = createPriorityIcon('#ef4444');
const mediumPriorityIcon = createPriorityIcon('#f59e0b');
const lowPriorityIcon = createPriorityIcon('#10b981');

export default function LiveMap() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return (
      <div style={{ height: '380px', background: '#1e293b', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#94a3b8' }}>
        Loading map...
      </div>
    );
  }

  // coordinates for Bangalore
  const position: [number, number] = [12.9716, 77.5946]; 

  return (
    <div style={{ height: "380px", width: "100%", borderRadius: "8px", overflow: "hidden" }}>
      <MapContainer center={position} zoom={13} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
        />
        <Marker position={[12.9750, 77.6050]} icon={highPriorityIcon}>
          <Popup>
            <strong>Water leak</strong><br />
            MG Road, District 04<br />
            <span style={{ color: "#ef4444", fontWeight: "bold", fontSize: "11px" }}>HIGH PRIORITY (8 reports)</span>
          </Popup>
        </Marker>
        <Marker position={[12.9720, 77.6350]} icon={lowPriorityIcon}>
          <Popup>
            <strong>Street light</strong><br />
            Indiranagar, District 02<br />
            <span style={{ color: "#10b981", fontWeight: "bold", fontSize: "11px" }}>LOW PRIORITY (2 reports)</span>
          </Popup>
        </Marker>
        <Marker position={[12.9745, 77.6000]} icon={mediumPriorityIcon}>
          <Popup>
            <strong>Pothole</strong><br />
            Church Street, District 03<br />
            <span style={{ color: "#f59e0b", fontWeight: "bold", fontSize: "11px" }}>MEDIUM PRIORITY (3 reports)</span>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
