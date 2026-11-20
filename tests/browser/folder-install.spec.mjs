import { test, expect } from "@playwright/test";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { folderInstall } from "../folder-install.mjs";

let install;
test.beforeEach(async ({ page }) => {
  install = await folderInstall();
  // Never use live tiles or private sync to validate bundled map rendering.
  await page.route("https://tile.openstreetmap.org/**", (route) => route.abort());
});
test.afterEach(async () => { await install.dispose(); });

async function expectMap(page) {
  await expect(page.locator("#map")).toHaveClass(/leaflet-container/);
  await expect(page.locator(".leaflet-overlay-pane path")).toHaveCount(439);
  await expect(page.locator(".leaflet-control-zoom-in")).toBeVisible();
  await expect(page.locator(".leaflet-control-attribution")).toContainText("OpenStreetMap");
  await expect(page.locator("#map-assets-error")).toBeHidden();
  await expect(page.locator("#map-loading")).toBeHidden();
  await expect(page.locator("#map .leaflet-tile-pane")).toHaveCSS("position", "absolute");
  await expect(page.locator('#map .leaflet-overlay-pane path[fill="#596960"]')).not.toHaveCount(0);
}

test("clean folder initializes the real styled map with no install step or third-party scripts", async ({ page }) => {
  const errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== new URL(install.url).origin) external.push(request.url());
  });
  await page.goto(install.url);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expectMap(page);
  await expect(page.locator("#map-error")).toBeVisible();
  // Tile outages do not break interaction, markers or collection filtering.
  await page.getByLabel("Filter passes by name").fill("Mortirolo");
  await expect(page.locator(".leaflet-overlay-pane path")).toHaveCount(1);
  await page.getByRole("button", { name: "Show all matching passes" }).click();
  await page.locator(".leaflet-overlay-pane path").click();
  await expect(page.locator("#detail-title")).toHaveText("Mortirolo");
  await page.getByRole("button", { name: "Back to map", exact: false }).click();
  await page.getByRole("button", { name: "Collection", exact: true }).click();
  await expect(page.locator(".pass-card")).toHaveCount(1);
  expect(errors).toEqual([]);
  expect(external.length).toBeGreaterThan(0);
  expect(external.every((url) => new URL(url).origin === "https://tile.openstreetmap.org")).toBe(true);
  expect(install.runtime.store.revision()).toBe(0);
});

for (const asset of ["leaflet.js", "leaflet.css"]) {
  test(`Map waits for delayed ${asset} before initialization`, async ({ page }) => {
    let release;
    const delayed = new Promise((resolve) => { release = resolve; });
    await page.route(`**/vendor/${asset}`, async (route) => {
      await delayed;
      await route.continue();
    });
    await page.goto(install.url);
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.locator("#map-loading")).toBeVisible();
    await expect(page.locator("#fit-map")).toBeDisabled();
    await expect(page.locator("#map-assets-error")).toBeHidden();
    // Switching away while loading must not force the map back into view.
    await page.getByRole("button", { name: "Collection", exact: true }).click();
    release();
    await expect(page.locator("#map-view")).toBeHidden();
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expectMap(page);
  });
}

for (const asset of ["leaflet.js", "leaflet.css"]) {
  test(`missing ${asset} keeps records usable and Retry map recovers in the same document`, async ({ page }) => {
    install.runtime.store.saveAscent({ revision: 0, approachId: "stelvio-prad", note: "Synthetic journal entry to preserve" });
    const saved = install.runtime.store.state();
    const path = join(install.extension, "web/vendor", asset);
    await rename(path, path + ".temporarily-missing");
    await page.goto(install.url);
    await page.getByRole("button", { name: "Map", exact: true }).click();
    await expect(page.locator("#map-assets-error")).toContainText("complete Col Collector extension folder");
    await expect(page.locator("#map-assets-error")).not.toContainText("npm ci");
    await expect(page.locator(".leaflet-container")).toHaveCount(0);
    await expect(page.locator("#location-input")).toBeDisabled();
    await page.getByRole("button", { name: "Collection", exact: true }).click();
    await expect(page.locator(".pass-card")).toHaveCount(439);
    await page.getByLabel("Filter passes by name").fill("Galibier");
    await page.locator(".pass-card").click();
    await expect(page.locator("#detail-title")).toHaveText("Col du Galibier");
    await page.getByRole("button", { name: "Show on map", exact: false }).click();
    await expect(page.locator("#map-assets-error")).toBeVisible();
    await rename(path + ".temporarily-missing", path);
    await page.getByRole("button", { name: "Retry map" }).click();
    await expectMap(page);
    await expect(page.locator("#error")).toBeHidden();
    expect(install.runtime.store.state()).toEqual(saved);
  });
}

test("HTTP 200 without Leaflet execution is an explicit recoverable failure", async ({ page }) => {
  const source = await readFile(join(install.extension, "web/vendor/leaflet.js"));
  let broken = true;
  await page.route("**/vendor/leaflet.js", (route) => route.fulfill({
    contentType: "text/javascript", body: broken ? "/* incomplete map installation */" : source,
  }));
  await page.goto(install.url);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator("#map-assets-error")).toContainText("script did not initialize");
  broken = false;
  await page.getByRole("button", { name: "Retry map" }).click();
  await expectMap(page);
});

test("a hung asset times out and can be retried without reloading records", async ({ page }) => {
  await page.clock.install();
  let release, requests = 0;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route("**/vendor/leaflet.js", async (route) => {
    if (++requests === 1) {
      await held;
      await route.abort();
    } else await route.continue();
  });
  await page.goto(install.url);
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator("#map-loading")).toBeVisible();
  await page.clock.fastForward(15001);
  await expect(page.locator("#map-assets-error")).toContainText("timed out");
  await expect(page.locator("#map-loading")).toBeHidden();
  release();
  await page.getByRole("button", { name: "Retry map" }).click();
  await expectMap(page);
});
