import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { get } from "node:http";
import { createRuntime } from "../.github/extensions/col-collector/runtime.mjs";
import { createGeocoder } from "../.github/extensions/col-collector/server.mjs";
import { collectorCanvas } from "../.github/extensions/col-collector/canvas.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "col-http-"));
  const runtime = await createRuntime({ dataPath: join(dir, "passport.sqlite") });
  t.after(async () => { await runtime.dispose(); await rm(dir, { recursive: true }); });
  const server = await runtime.open("test");
  return { runtime, server };
}

test("loopback server serves bundled HTML, modules, assets and catalogue", async (t) => {
  const { server } = await fixture(t);
  for (const path of ["", "app.js", "model.mjs", "styles.css", "mountain.svg", "vendor/leaflet.js", "vendor/leaflet.css", "api/catalogue", "api/state"]) {
    const response = await fetch(server.url + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
});

test("server refuses requests without the capability or with a foreign origin", async (t) => {
  const { server } = await fixture(t);
  assert.equal((await fetch(new URL("/api/state", server.url))).status, 404);
  assert.equal((await fetch(server.url + "api/state", { headers: { Origin: "https://unrelated.example" } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    get(server.url + "api/state", { headers: { Host: "attacker.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(status, 403);
});

test("HTTP mutation, conflict and reload retain saved data", async (t) => {
  const { server } = await fixture(t);
  const post = (body) => fetch(server.url + "api/ascents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await post({ revision: 0, approachId: "stelvio-prad", note: "Good day." });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).state.ascents.length, 1);
  assert.equal((await post({ revision: 0, approachId: "stelvio-bormio" })).status, 409);
  assert.equal((await post(null)).status, 400);
  assert.equal((await fetch(server.url + "api/state").then((r) => r.json())).ascents.length, 1);
});

test("manual approach creation is retired and every pass is ready to log", async (t) => {
  const { server } = await fixture(t);
  const response = await fetch(server.url + "api/approaches", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 0, name: "New custom approach" }),
  });
  assert.equal(response.status, 410);
  assert.match((await response.json()).error, /preloaded/);
  const state = await fetch(server.url + "api/state").then((r) => r.json());
  assert.equal(state.revision, 0);
  assert.equal(new Set(state.approaches.filter((a) => a.verified).map((a) => a.passId)).size, 439);
});

test("HTTP and canvas support unknown ascents and Mortirolo's source aliases", async (t) => {
  const { runtime, server } = await fixture(t);
  const response = await fetch(server.url + "api/ascents", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: 0, approachId: null, passId: "pass-965d3e148f028ea0" }),
  });
  assert.equal(response.status, 200);
  const { state } = await response.json();
  assert.equal(state.ascents[0].approachId, null);
  assert.equal(state.ascents[0].passId, "pass-965d3e148f028ea0");
  const canvas = collectorCanvas({ createCanvas: (options) => options, CanvasError: Error }, runtime);
  assert.deepEqual(canvas.actions[0].handler(), { totalPasses: 439, completedPasses: 1, recordedAscents: 1 });
  for (const query of ["Mortirolo", "Foppa"]) {
    assert.deepEqual(canvas.actions[1].handler({ input: { query } }), [
      { id: "pass-965d3e148f028ea0", name: "Mortirolo", elevation: 1855, completed: true },
    ]);
  }
});

test("geocoder validates coordinates, caches searches and throttles uncached requests", async (t) => {
  const { runtime } = await fixture(t);
  let calls = 0;
  const geocode = createGeocoder(runtime.store, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url.searchParams.get("q"), "Bormio");
    assert.match(options.headers["User-Agent"], /ColCollector/);
    return new Response(JSON.stringify({ features: [
      { geometry: { coordinates: [10.37, 46.47] }, properties: { name: "Bormio", country: "Italy" } },
      { geometry: { coordinates: [999, 300] }, properties: { name: "Invalid" } },
    ] }));
  } });
  const result = await geocode("Bormio");
  assert.deepEqual(result, [{ label: "Bormio, Italy", latitude: 46.47, longitude: 10.37 }]);
  assert.deepEqual(await geocode("Bormio"), result);
  assert.equal(calls, 1);
  await assert.rejects(geocode("Innsbruck"), /wait a moment/);
});

test("geocoder reports network failure instead of empty success", async (t) => {
  const { runtime } = await fixture(t);
  const geocode = createGeocoder(runtime.store, { fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(geocode("Bormio"), /unavailable.*offline/);
});

test("canvas opens idempotently and fresh instances share the passport", async (t) => {
  const { runtime } = await fixture(t);
  const canvas = collectorCanvas({ createCanvas: (options) => options, CanvasError: Error }, runtime);
  const first = await canvas.open({ instanceId: "one" });
  const same = await canvas.open({ instanceId: "one" });
  const other = await canvas.open({ instanceId: "two" });
  assert.equal(first.url, same.url);
  assert.notEqual(first.url, other.url);
  runtime.store.saveAscent({ revision: 0, approachId: "stelvio-prad" });
  assert.equal((await fetch(other.url + "api/state").then((r) => r.json())).ascents.length, 1);
  assert.deepEqual(canvas.actions[0].handler(), { totalPasses: 439, completedPasses: 1, recordedAscents: 1 });
  assert.equal(canvas.actions[1].handler({ input: { query: "Stelvio" } })[0].completed, true);
  await canvas.onClose({ instanceId: "one" });
  await assert.rejects(fetch(first.url));
  const reopened = await canvas.open({ instanceId: "one" });
  assert.equal((await fetch(reopened.url + "api/state").then((r) => r.json())).ascents.length, 1);
});
