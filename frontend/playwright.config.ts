import { defineConfig, devices } from "@playwright/test";

/**
 * Browser end-to-end tests. `npm run test:e2e` starts both servers itself:
 *   - the API on :5055 against a throwaway "urbanops_e2e" database (needs MongoDB running)
 *   - this Next.js app on :3100, pointed at that API
 * Neither touches your dev database or dev servers on :5000 / :3000.
 */

const API = "http://127.0.0.1:5055";
const WEB = "http://localhost:3100";

export default defineConfig({
  testDir: "./e2e",
  // The flows build on each other (report → dispatch → resolve), so run in order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // The report form reads the browser's position: pretend to be on MG Road, Bengaluru.
    geolocation: { latitude: 12.975, longitude: 77.605 },
    permissions: ["geolocation"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node ../scripts/e2e-server.js",
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { PORT: "5055", CLIENT_ORIGIN: WEB },
    },
    {
      command: "npx next dev --port 3100",
      url: `${WEB}/login`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { NEXT_PUBLIC_API_URL: API },
    },
  ],
});
