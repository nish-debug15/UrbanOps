import path from "path";
import type { NextConfig } from "next";

// Hosts other than localhost that may load the dev server, e.g. this PC's LAN IP when
// testing from a phone (see .env.example). Dev only; ignored in production.
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS || "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  // The repo root also has a package-lock.json (the Express backend), so pin the
  // frontend as Turbopack's root instead of letting it guess.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
