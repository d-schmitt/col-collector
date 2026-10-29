import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../../.github/extensions/col-collector/runtime.mjs";
import { FakeGitHub } from "../fake-github.mjs";

let runtime, dir, url;
test.beforeEach(async ({ page }) => {
  dir = await mkdtemp(join(tmpdir(), "col-browser-"));
  runtime = await createRuntime({ dataPath: join(dir, "passport.sqlite") });
  url = (await runtime.open("browser-test")).url;
  // Keep the visual checks independent of third-party tile availability.
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Your Alpine collection" })).toBeVisible();
});
test.afterEach(async () => { await runtime.dispose(); await rm(dir, { recursive: true }); });

test("completed map markers use the contrasting legend color and a stronger outline", async ({ page }) => {
  runtime.store.saveAscent({ revision: runtime.store.revision(), approachId: "stelvio-prad" });
  await page.reload();
  await page.getByRole("button", { name: "Map", exact: true }).click();
  const collected = page.locator('.leaflet-overlay-pane path[fill="#b51b78"]');
  await expect(collected).toHaveCount(1);
  await expect(collected).toHaveCSS("fill", "rgb(181, 27, 120)");
  await expect(collected).toHaveAttribute("stroke", "#fff");
  await expect(collected).toHaveAttribute("stroke-width", "2.5");
  await expect(page.locator(".legend-dot.done")).toHaveCSS("background-color", "rgb(181, 27, 120)");
  await expect(page.locator('.leaflet-overlay-pane path[fill="#596960"]')).toHaveCount(436);
});

test("filters, location search, map bounds and mobile layout", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await expect(page.locator(".pass-card")).toHaveCount(437);
  await page.getByLabel("Summit group").selectOption("high");
  await expect(page.locator(".pass-card")).toHaveCount(86);
  await page.getByLabel("Summit group").selectOption("low");
  await expect(page.locator(".pass-card")).toHaveCount(351);
  await page.getByRole("combobox", { name: "Progress", exact: true }).selectOption("done");
  await expect(page.getByRole("heading", { name: "No passes here yet" })).toBeVisible();
  await page.getByRole("button", { name: "Reset filters" }).click();
  await page.getByLabel("Filter passes by name").fill("Galibier");
  await expect(page.locator(".pass-card")).toHaveCount(1);
  await page.getByLabel("Filter passes by name").fill("");
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.route("**/api/search?**", (route) => route.fulfill({ json: [{ label: "Bormio, Italy", latitude: 46.467, longitude: 10.37 }] }));
  await page.getByLabel("Find a location").fill("Bormio");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: "Bormio, Italy" }).click();
  await expect(page.locator("#map-caption")).toHaveText("Around Bormio, Italy");
  await expect(page.locator("#cards")).toContainText("Passo dello Stelvio");
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await page.screenshot({ path: "test-results/collection-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/collection-mobile.png", fullPage: false });
  expect(errors).toEqual([]);
});

test("log, edit, repeat, photo, backup, reload and last-ascent deletion", async ({ page }) => {
  await page.getByLabel("Filter passes by name").fill("Galibier");
  await page.locator(".pass-card").click();
  await page.getByRole("button", { name: "Log ascent", exact: true }).first().click();
  await page.getByLabel("Date", { exact: false }).fill("2024-08-12");
  await page.getByLabel("A few words", { exact: false }).fill("A brilliant day. <img src=x onerror=alert(1)>");
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 100;
    canvas.height = 100;
    const context = canvas.getContext("2d");
    context.fillStyle = "#205c40";
    context.fillRect(0, 0, 100, 100);
    return canvas.toDataURL("image/png").split(",")[1];
  });
  await page.locator('input[name="photo"]').setInputFiles({
    name: "summit.png", mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("✓ Collected");
  await expect(page.locator(".journal-photo")).toBeVisible();
  await expect(page.locator(".note")).toContainText("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("A few words", { exact: false }).fill("Updated memory");
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".journal-photo")).toBeVisible();
  await page.getByRole("button", { name: "Log another ascent" }).click();
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await page.getByText("Passport tools", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const backup = await download;
  const backupPath = await backup.path();
  expect(backup.suggestedFilename()).toMatch(/col-collector.*json/);
  await page.reload();
  await expect(page.locator("#progress-label")).toHaveText("1 / 437 collected");
  await page.getByLabel("Filter passes by name").fill("Galibier");
  await page.locator(".pass-card").click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await page.getByRole("button", { name: "Delete", exact: true }).first().click();
  await page.getByRole("button", { name: "Delete ascent", exact: true }).click();
  await expect(page.locator(".journal-entry")).toHaveCount(1);
  await expect(page.locator(".status-pill")).toHaveText("✓ Collected");
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("button", { name: "Delete ascent", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("Still to ride");
  await page.locator("#restore-file").setInputFiles(backupPath);
  await page.getByRole("button", { name: "Replace passport", exact: true }).click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await expect(page.locator(".journal-photo")).toBeVisible();
});

test("Klausenpass has preloaded approaches and can be logged without route entry", async ({ page }) => {
  await page.getByLabel("Filter passes by name").fill("Klausenpass");
  await page.locator(".pass-card").click();
  await expect(page.getByRole("button", { name: "Add approach", exact: true })).toHaveCount(0);
  await expect(page.locator("#approach-form")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "From Altdorf (Tell monument)" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "From Linthal station" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "From Schattdorf" })).toBeVisible();
  await page.getByRole("button", { name: "Log ascent", exact: true }).first().click();
  await expect(page.locator('select[name="approachId"] option')).toHaveCount(4);
  await expect(page.locator('select[name="approachId"]')).not.toHaveValue("");
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.getByText("Date not recorded", { exact: true })).toBeVisible();
  await expect(page.locator(".status-pill")).toHaveText("✓ Collected");
});

test("stale writes show a recoverable error without losing the draft", async ({ page }) => {
  await page.getByLabel("Filter passes by name").fill("Galibier");
  await page.locator(".pass-card").click();
  await page.getByRole("button", { name: "Log ascent", exact: true }).first().click();
  await page.getByLabel("A few words", { exact: false }).fill("Keep this draft");
  runtime.store.saveAscent({ revision: runtime.store.revision(), approachId: "stelvio-prad" });
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("another panel");
  await expect(page.getByLabel("A few words", { exact: false })).toHaveValue("Keep this draft");
  await page.getByRole("button", { name: "Reload records", exact: true }).click();
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".note")).toHaveText("Keep this draft");
});

test("Mortirolo can be collected with an unknown approach from the shared map detail flow", async ({ page }) => {
  await page.getByLabel("Filter passes by name").fill("Foppa");
  await expect(page.locator(".pass-card h3")).toHaveText("Mortirolo");
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page.getByRole("button", { name: "Show all matching passes" }).click();
  const marker = page.locator(".leaflet-overlay-pane path");
  await expect(marker).toHaveCount(1);
  await marker.hover();
  await expect(page.locator(".leaflet-tooltip")).toContainText("Mortirolo");
  await marker.click();
  await expect(page.locator("#detail-title")).toHaveText("Mortirolo");
  await expect(page.locator(".full-name")).toContainText("Passo della Foppa");
  await page.getByRole("button", { name: "Log ascent · approach unknown", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Approach", exact: true })).toHaveValue("");
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".status-pill")).toHaveText("✓ Collected");
  await expect(page.locator(".journal-entry .approach-name")).toHaveText("Approach unknown");
  await expect(page.locator('.approach [aria-label="Completed"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const knownId = await page.locator('select[name="approachId"] option').nth(1).getAttribute("value");
  await page.getByRole("combobox", { name: "Approach", exact: true }).selectOption(knownId);
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator('.approach [aria-label="Completed"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("combobox", { name: "Approach", exact: true }).selectOption("");
  await page.getByLabel("A few words", { exact: false }).fill("Not sure which side");
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator('.approach [aria-label="Completed"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Log ascent · approach unknown", exact: true }).click();
  await page.getByRole("button", { name: "Save ascent", exact: true }).click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await page.screenshot({ path: "test-results/mortirolo-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/mortirolo-mobile.png", fullPage: true });
  await page.getByText("Passport tools", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download backup" }).click();
  const backupPath = await (await download).path();
  await page.reload();
  await expect(page.locator("#progress-label")).toHaveText("1 / 437 collected");
  await page.getByLabel("Filter passes by name").fill("Mortirolo");
  await page.locator(".pass-card").click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await expect(page.locator(".note")).toHaveText("Not sure which side");
  for (let i = 0; i < 2; i++) {
    await page.getByRole("button", { name: "Delete", exact: true }).first().click();
    await page.getByRole("button", { name: "Delete ascent", exact: true }).click();
  }
  await expect(page.locator(".status-pill")).toHaveText("Still to ride");
  await page.getByText("Passport tools", { exact: true }).click();
  await page.locator("#restore-file").setInputFiles(backupPath);
  await page.getByRole("button", { name: "Replace passport", exact: true }).click();
  await expect(page.locator(".journal-entry")).toHaveCount(2);
  await expect(page.locator(".status-pill")).toHaveText("✓ Collected");
  await expect(page.locator('.approach [aria-label="Completed"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator('.leaflet-overlay-pane path[fill="#b51b78"]')).toHaveCount(1);
});

test("manual GitHub sync protects local changes and offers recovery", async ({ page }) => {
  const github = new FakeGitHub();
  runtime.sync.request = github.request;
  await page.getByText("Passport tools", { exact: true }).click();
  await page.getByRole("button", { name: "GitHub sync", exact: true }).click();
  await page.getByLabel("Private data repository").fill(github.repo.full_name);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.locator("#sync-status")).toContainText(github.repo.full_name);
  await page.getByRole("button", { name: "Push backup", exact: true }).click();
  await expect(page.locator("#sync-status")).toContainText("Local copy matches");
  runtime.store.saveAscent({ revision: runtime.store.revision(), approachId: "stelvio-prad", note: "Keep locally" });
  await page.reload();
  await expect(page.locator("#progress-label")).toHaveText("1 / 437 collected");
  await page.getByText("Passport tools", { exact: true }).click();
  await page.getByRole("button", { name: "GitHub sync", exact: true }).click();
  await page.getByRole("button", { name: "Pull backup", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Pull backup", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("unpushed local changes");
  await expect(page.locator("#progress-label")).toHaveText("1 / 437 collected");
  await page.getByText("Conflicts and recovery", { exact: true }).click();
  await page.getByRole("button", { name: "Replace local from GitHub", exact: true }).click();
  await page.getByRole("button", { name: "Replace local passport", exact: true }).click();
  await expect(page.locator("#progress-label")).toHaveText("0 / 437 collected");
  await expect(page.getByRole("button", { name: "Download pre-pull recovery" })).toBeEnabled();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download pre-pull recovery" }).click();
  expect((await download).suggestedFilename()).toBe("col-collector-before-pull.json");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("connecting a public repository fails without enabling sync", async ({ page }) => {
  const github = new FakeGitHub();
  github.repo.private = false;
  github.repo.visibility = "public";
  runtime.sync.request = github.request;
  await page.getByText("Passport tools", { exact: true }).click();
  await page.getByRole("button", { name: "GitHub sync", exact: true }).click();
  await page.getByLabel("Private data repository").fill(github.repo.full_name);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("must be private");
  await expect(page.getByRole("button", { name: "Push backup", exact: true })).toBeDisabled();
});
