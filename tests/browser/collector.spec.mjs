import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../../.github/extensions/col-collector/runtime.mjs";

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

test("unknown approaches can be added and blank dates stay optional", async ({ page }) => {
  await page.getByLabel("Filter passes by name").fill("Tiefenbach");
  await page.locator(".pass-card").click();
  await expect(page.getByText("Approaches for this pass have not been verified yet.", { exact: false })).toBeVisible();
  await page.getByLabel("Starting place or approach name").fill("From Sölden");
  await page.getByRole("button", { name: "Add approach", exact: true }).click();
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
