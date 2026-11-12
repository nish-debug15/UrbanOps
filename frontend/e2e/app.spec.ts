import { expect, test, type Page } from "@playwright/test";

/**
 * The main journey, in order: a citizen reports an issue with a photo, a second
 * citizen joins it, a dispatcher dispatches and resolves it with a note, the
 * citizen sees the outcome, and an admin sees it in analytics.
 */

const API = "http://127.0.0.1:5055";
const STAMP = Date.now();
const CITIZEN_A = { name: "Asha Rao", email: `asha.${STAMP}@e2e.test`, password: "citizen-pass-1" };
const CITIZEN_B = { name: "Bilal Khan", email: `bilal.${STAMP}@e2e.test`, password: "citizen-pass-2" };
const DISPATCHER = { email: "dispatcher@e2e.test", password: "dispatch12345" };
const ADMIN = { email: "admin@e2e.test", password: "admin12345" };
const NOTE = "Pothole filled and the surface levelled.";

// A real, tiny PNG (1x1 px).
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function signIn(page: Page, account: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function signUp(page: Page, account: { name: string; email: string; password: string }) {
  await page.goto("/login");
  await page.getByRole("tab", { name: "Citizen sign-up" }).click();
  await page.getByLabel("Full name").fill(account.name);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/my-reports/);
}

/** Drop the session directly: in dev mode the Next.js indicator sits over the sidebar's Sign out button. */
async function signOut(page: Page) {
  await page.evaluate(() => localStorage.removeItem("urbanops-token"));
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

const mails = async (page: Page) =>
  (await (await page.request.get(`${API}/__e2e/mails`)).json()) as { to: string; subject: string; text: string }[];

test.describe.configure({ mode: "serial" });

test("a citizen reports a pothole with a photo", async ({ page }) => {
  await signUp(page, CITIZEN_A);
  await page.goto("/report");

  await page.getByLabel("What is the issue?").selectOption("Pothole");
  // Location comes from the (mocked) GPS position.
  await expect(page.locator(".location-readout")).toContainText("12.97500, 77.60500");
  await page.getByLabel("What did you notice?").fill("Deep pothole in the left lane.");
  await page.locator("#photos").setInputFiles({ name: "pothole.png", mimeType: "image/png", buffer: PNG });
  await expect(page.getByAltText(/Selected photo 1/)).toBeVisible();

  await page.getByRole("button", { name: "Submit report" }).click();
  await expect(page.getByText("NEW ISSUE CREATED", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Track my reports" }).click();
  const card = page.locator(".my-report").first();
  await expect(card).toContainText("Pothole");
  // The stored photo is really served back by the API.
  const photo = card.getByAltText("Report photo 1 of 1");
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});

test("a second citizen is shown the nearby issue and joins it instead of re-reporting", async ({ page }) => {
  await signUp(page, CITIZEN_B);
  await page.goto("/report");

  const nearby = page.getByRole("region", { name: "Issues already reported near this location" });
  await expect(nearby).toContainText("Pothole");
  await expect(nearby).toContainText("1 report");
  await nearby.getByRole("button", { name: "I see this too" }).click();

  await expect(page.getByText("ADDED TO AN EXISTING ISSUE", { exact: true })).toBeVisible();
  await expect(page.getByText(/2 reports · severity 35/)).toBeVisible();
});

test("a dispatcher dispatches the issue, then resolves it with a note", async ({ page }) => {
  await signIn(page, DISPATCHER);
  await page.goto("/incidents");

  const open = page.locator(".kanban-col").filter({ has: page.getByRole("heading", { name: "Open" }) });
  const dispatched = page.locator(".kanban-col").filter({ has: page.getByRole("heading", { name: "Dispatched" }) });
  const resolved = page.locator(".kanban-col").filter({ has: page.getByRole("heading", { name: "Resolved" }) });

  await expect(open.locator(".kanban-card")).toHaveCount(1);
  await expect(open.locator(".kanban-card")).toContainText("2 reports");
  await expect(open.getByAltText("Report photo 1 of 1")).toBeVisible();

  await open.getByRole("button", { name: /Dispatch/ }).click();
  await expect(dispatched.locator(".kanban-card")).toHaveCount(1);

  await dispatched.getByRole("button", { name: /Resolve/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: /Mark resolved/ })).toBeDisabled(); // a note is required
  await dialog.getByLabel("What was done?").fill(NOTE);
  await dialog.locator("#resolve-photos").setInputFiles({ name: "after.png", mimeType: "image/png", buffer: PNG });
  await expect(dialog.getByAltText(/Selected photo 1/)).toBeVisible();
  await dialog.getByRole("button", { name: /Mark resolved/ }).click();

  await expect(dialog).toBeHidden();
  await expect(resolved.locator(".kanban-card")).toHaveCount(1);
  await expect(resolved).toContainText(NOTE);

  // The photo attached while resolving is on the card, and another can be added afterwards.
  const after = resolved.locator(".after-photos");
  await expect(after.locator("img")).toHaveCount(1);
  await after.locator('input[type="file"]').setInputFiles({ name: "after2.png", mimeType: "image/png", buffer: PNG });
  await expect(after.locator("img")).toHaveCount(2);

  // Staff act on issues; they are not offered the report form.
  await expect(page.getByRole("link", { name: "Report issue" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "My reports" })).toHaveCount(0);
  await page.goto("/report");
  await expect(page).toHaveURL(/localhost:3100\/$/);

  // Both reporters were emailed at each step; the resolution email carries the note.
  await expect
    .poll(async () => (await mails(page)).filter((m) => m.subject.startsWith("Resolved:")).map((m) => m.to).sort())
    .toEqual([CITIZEN_A.email, CITIZEN_B.email].sort());
  const all = await mails(page);
  expect(all.filter((m) => /crew is on it/i.test(m.subject))).toHaveLength(2);
  expect(all.find((m) => m.subject.startsWith("Resolved:"))?.text).toContain(NOTE);
});

test("the reporter sees the resolution and what was done", async ({ page }) => {
  await signIn(page, CITIZEN_A);
  await page.goto("/my-reports");
  const card = page.locator(".my-report").first();
  await expect(card.locator(".progress li.done")).toHaveCount(3);
  await expect(card).toContainText(`What was done: ${NOTE}`);
  await expect(card).toContainText("2 people reported this");
  await expect(card.locator(".after-photos")).toContainText("After the fix");
  await expect(card.locator(".after-photos img")).toHaveCount(2);
});

test("an admin sees the activity in analytics; a dispatcher cannot open it", async ({ page }) => {
  await signIn(page, ADMIN);
  await page.getByRole("link", { name: "Analytics" }).click();
  await expect(page).toHaveURL(/\/analytics/);

  const stat = (label: string) => page.locator(".stat-block").filter({ hasText: label }).locator(".stat-value");
  await expect(stat("Issues opened")).toHaveText("1");
  await expect(stat("Citizen reports")).toHaveText("2");
  await expect(stat("Issues resolved")).toHaveText("1");
  await expect(page.getByText("1 merged as duplicates")).toBeVisible();
  await expect(page.getByRole("img", { name: /Issues opened and resolved per day/ })).toBeVisible();
  await expect(page.locator(".ranked-bars li")).toContainText(["Pothole"]);

  await page.getByText("Show the daily numbers as a table").click();
  await expect(page.locator(".chart-table tbody tr").first().locator("td").nth(1)).toHaveText("1");

  await page.getByRole("button", { name: "Last 7 days" }).click();
  await expect(page.locator(".chart-table tbody tr")).toHaveCount(7);

  await signOut(page);
  await signIn(page, DISPATCHER);
  await expect(page.getByRole("link", { name: "Analytics" })).toHaveCount(0);
  await page.goto("/analytics");
  await expect(page).toHaveURL(/localhost:3100\/$/); // sent back to the dashboard
});

test("the live map switches between markers and a heatmap", async ({ page }) => {
  await signIn(page, DISPATCHER);
  await page.goto("/livemap");
  await page.getByRole("button", { name: "Resolved" }).click(); // the only issue is resolved by now
  await expect(page.getByText(/1 in view/)).toBeVisible();

  await page.getByRole("button", { name: "Heatmap" }).click();
  await expect(page.getByText("ISSUE DENSITY")).toBeVisible();
  await expect(page.locator(".leaflet-overlay-pane canvas, canvas.leaflet-heatmap-layer, .leaflet-pane canvas").first()).toBeAttached();
  await expect(page.locator(".civic-marker")).toHaveCount(0);

  await page.getByRole("button", { name: "Markers" }).click();
  await expect(page.locator(".civic-marker, .civic-cluster").first()).toBeVisible();
});

test("forgot password: emailed link sets a new password and signs in", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("link", { name: "Forgot your password?" }).click();
  // Wait for the new page: the login form it replaces also has an "Email" field.
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  await page.getByLabel("Email").fill(CITIZEN_B.email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByText(/a reset link is on its way/)).toBeVisible();

  let link = "";
  await expect
    .poll(async () => {
      const mail = (await mails(page)).find((m) => m.to === CITIZEN_B.email && /Reset your/.test(m.subject));
      link = mail?.text.match(/http\S+reset-password\?token=\S+/)?.[0] ?? "";
      return link;
    })
    .not.toBe("");

  await page.goto(link);
  await page.getByLabel("New password", { exact: true }).fill("brand-new-pass-9");
  await page.getByLabel("Repeat new password").fill("brand-new-pass-9");
  await page.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(page).toHaveURL(/\/my-reports/);

  // The old password no longer works; the new one does.
  await signOut(page);
  await page.goto("/login");
  await page.getByLabel("Email").fill(CITIZEN_B.email);
  await page.getByLabel("Password").fill(CITIZEN_B.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).last().click();
  await expect(page.getByText("Invalid email or password")).toBeVisible();
  await signIn(page, { email: CITIZEN_B.email, password: "brand-new-pass-9" });
});
