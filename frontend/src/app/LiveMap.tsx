"use client";

import { useEffect, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

const createCivicIcon = (level: 'high' | 'medium' | 'low') => {
  const pulseHtml = level === 'high' ? '<div class="pulse-ring"></div>' : '';
  
  return L.divIcon({
    className: `civic-marker ${level}`,
    html: pulseHtml,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
};

const highPriorityIcon = createCivicIcon('high');
const mediumPriorityIcon = createCivicIcon('medium');
const lowPriorityIcon = createCivicIcon('low');

export default function LiveMap() {
  const [isMounted, setIsMounted] = useState(false);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  if (!isMounted) {
    return (
      <div className="map-wrapper" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span className="mono">Loading geospatial data...</span>
      </div>
    );
  }

  // coordinates for Bangalore
  const position: [number, number] = [12.9716, 77.5946]; 

  return (
    <div className="map-wrapper">
      <MapContainer center={position} zoom={13} style={{ height: "100%", width: "100%" }}>
        <TileLayer
          attribution='&copy; <a href="https://carto.com/">Carto</a>'
          url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
        />
        <Marker position={[12.9750, 77.6050]} icon={highPriorityIcon}>
          <Popup>
            <div className="mono" style={{ fontSize: '12px' }}>
              <strong>[INC-1042] Water leak</strong><br />
              MG Road, District 04<br />
              <span style={{ color: "#CC3333", fontWeight: 600 }}>PRIORITY: HIGH (8 reports)</span>
            </div>
          </Popup>
        </Marker>
        <Marker position={[12.9720, 77.6350]} icon={lowPriorityIcon}>
          <Popup>
            <div className="mono" style={{ fontSize: '12px' }}>
              <strong>[INC-1039] Street light</strong><br />
              Indiranagar, District 02<br />
              <span style={{ color: "#4A7C59", fontWeight: 600 }}>PRIORITY: LOW (2 reports)</span>
            </div>
          </Popup>
        </Marker>
        <Marker position={[12.9745, 77.6000]} icon={mediumPriorityIcon}>
          <Popup>
            <div className="mono" style={{ fontSize: '12px' }}>
              <strong>[INC-1040] Pothole</strong><br />
              Church Street, District 03<br />
              <span style={{ color: "#D97706", fontWeight: 600 }}>PRIORITY: MEDIUM (3 reports)</span>
            </div>
          </Popup>
        </Marker>
      </MapContainer>
    </div>
  );
}
