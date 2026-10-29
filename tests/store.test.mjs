import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, decodePhoto } from "../.github/extensions/col-collector/store.mjs";
import { completedPassIds, filterPasses, validateDate } from "../.github/extensions/col-collector/model.mjs";

const catalogue = JSON.parse(await readFile(new URL("../.github/extensions/col-collector/data/catalogue.json", import.meta.url)));
const verified = JSON.parse(await readFile(new URL("../.github/extensions/col-collector/data/approaches.json", import.meta.url)));
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "col-test-"));
  const path = join(dir, "passport.sqlite");
  const store = await Store.open(path, catalogue, verified);
  t.after(async () => { store.close(); await rm(dir, { recursive: true }); });
  return { store, path };
}
const save = (store, overrides = {}) => store.saveAscent({ revision: store.revision(), approachId: "stelvio-prad", ...overrides });
function restoreLegacy(store, { name = "East side", passId = catalogue.passes[0].id, photo = PNG } = {}) {
  const backup = store.export();
  backup.approaches.push({ id: "legacy-route", passId, name, sourceUrl: "https://www.quaeldich.de/paesse/" });
  backup.ascents.push({ id: "legacy-ride", approachId: "legacy-route", date: "2019-09-10", note: "<script>not executable</script>", photo, createdAt: "2019-09-10T12:00:00Z" });
  store.restore({ revision: store.revision(), backup });
}

test("catalogue contains exactly both paved layers and valid distinct IDs", () => {
  assert.equal(catalogue.passes.length, 437);
  assert.equal(new Set(catalogue.passes.map((p) => p.id)).size, 437);
  assert.equal(catalogue.passes.filter((p) => p.group === "high").length, 86);
  assert.equal(catalogue.passes.filter((p) => p.group === "low").length, 351);
  for (const p of catalogue.passes) {
    assert.ok(p.latitude >= -90 && p.latitude <= 90);
    assert.ok(p.longitude >= -180 && p.longitude <= 180);
    assert.ok(Number.isFinite(p.elevation));
    assert.ok(p.sourceLayer.startsWith("Paved passes"));
  }
  assert.equal(catalogue.warnings.length, 2);
});

test("all 437 passes have source-backed preloaded choices and existing IDs survive", () => {
  assert.equal(verified.length, 1340);
  assert.equal(new Set(verified.map((a) => a.id)).size, verified.length);
  assert.equal(new Set(verified.map((a) => a.passId)).size, 437);
  for (const pass of catalogue.passes) assert.ok(verified.some((a) => a.passId === pass.id), pass.name);
  assert.deepEqual(verified.filter((a) => a.passId === "pass-dab2867494683188").map((a) => a.name),
    ["From Altdorf (Tell monument)", "From Linthal station", "From Schattdorf"]);
  for (const id of ["stelvio-prad", "stelvio-bormio", "stelvio-santa-maria", "galibier-valloire", "galibier-lautaret"]) {
    assert.ok(verified.some((a) => a.id === id));
  }
  for (const approach of verified.filter((a) => a.sourceKind === "map-start")) {
    assert.match(approach.sourceUrl, /^https?:\/\//);
    assert.equal(approach.distanceKm, undefined);
    assert.equal(approach.gainM, undefined);
  }
});

test("every pass can be collected without creating an approach", async (t) => {
  const { store } = await fixture(t);
  for (const pass of catalogue.passes) {
    const approach = verified.find((a) => a.passId === pass.id);
    save(store, { approachId: approach.id });
  }
  const state = store.state();
  assert.equal(state.ascents.length, 437);
  assert.equal(completedPassIds(state.approaches, state.ascents).size, 437);
  assert.deepEqual(store.export().approaches, []);
});

test("one ascent completes only its pass, not other approaches; repeats count once", async (t) => {
  const { store } = await fixture(t);
  save(store);
  save(store, { date: "2024-06-13" });
  const state = store.state();
  const done = completedPassIds(state.approaches, state.ascents);
  assert.equal(done.size, 1);
  assert.equal(state.ascents.length, 2);
  assert.equal(state.ascents.filter((a) => a.approachId === "stelvio-bormio").length, 0);
  assert.equal(filterPasses(catalogue.passes, done, { status: "done" }).length, 1);
  assert.equal(filterPasses(catalogue.passes, done, { status: "todo" }).length, 436);
});

test("filters intersect and name search ignores diacritics", () => {
  assert.equal(filterPasses(catalogue.passes, new Set(), { group: "high" }).length, 86);
  assert.equal(filterPasses(catalogue.passes, new Set(), { group: "low" }).length, 351);
  assert.equal(filterPasses(catalogue.passes, new Set(), { query: "galibier", group: "low" }).length, 0);
  assert.equal(filterPasses([{ name: "Viòte", group: "low", id: "1" }], new Set(), { query: "viote" }).length, 1);
});

test("all optional ascent fields may be absent", async (t) => {
  const { store } = await fixture(t);
  save(store);
  const ascent = store.state().ascents[0];
  assert.equal(ascent.date, "");
  assert.equal(ascent.note, "");
  assert.equal(ascent.hasPhoto, 0);
});

test("date validation rejects rollover dates and accepts leap days", () => {
  assert.equal(validateDate("2024-02-29"), "2024-02-29");
  for (const value of ["2023-02-29", "2024-04-31", "2024-13-01", "30/1/2024", null, 2]) {
    assert.throws(() => validateDate(value), /date/i);
  }
});

test("editing preserves an existing photo unless explicitly replaced or removed", async (t) => {
  const { store } = await fixture(t);
  const { id } = save(store, { photo: PNG });
  const bytes = store.photo(id).bytes;
  save(store, { id, note: "A new note" });
  assert.deepEqual(store.photo(id).bytes, bytes);
  save(store, { id, photo: null });
  assert.throws(() => store.photo(id), /not found/);
});

test("deleting last ascent resets completion", async (t) => {
  const { store } = await fixture(t);
  const first = save(store);
  const second = save(store);
  store.deleteAscent({ revision: store.revision(), id: first.id });
  assert.equal(completedPassIds(store.state().approaches, store.state().ascents).size, 1);
  store.deleteAscent({ revision: store.revision(), id: second.id });
  assert.equal(completedPassIds(store.state().approaches, store.state().ascents).size, 0);
});

test("historical custom routes survive, even when their name matches a preloaded route", async (t) => {
  const { store } = await fixture(t);
  restoreLegacy(store, { name: verified[0].name, passId: verified[0].passId });
  assert.equal(store.state().approaches.find((a) => a.id === "legacy-route").sourceKind, "legacy");
  assert.throws(() => save(store, { approachId: "legacy-route" }), /preloaded approach/);
  save(store, { id: "legacy-ride", approachId: "legacy-route", note: "Edited historical memory" });
  assert.equal(store.state().ascents[0].note, "Edited historical memory");
  const bad = store.export();
  bad.approaches[0].sourceUrl = "javascript:alert(1)";
  assert.throws(() => store.restore({ revision: store.revision(), backup: bad }), /HTTPS/);
});

test("invalid inputs do not mutate saved data", async (t) => {
  const { store } = await fixture(t);
  const revision = store.revision();
  assert.throws(() => save(store, { approachId: "unknown" }), /existing approach/);
  assert.throws(() => save(store, { note: "a".repeat(4001) }), /4000/);
  assert.throws(() => save(store, { date: "2023-02-29" }), /calendar date/);
  assert.throws(() => save(store, { photo: "data:image/svg+xml;base64,PHN2Zy8+" }), /JPEG/);
  assert.throws(() => save(store, { id: "missing" }), /no longer exists/);
  assert.equal(store.revision(), revision);
  assert.equal(store.state().ascents.length, 0);
});

test("photo MIME and bytes must agree", () => {
  assert.equal(decodePhoto(PNG).mime, "image/png");
  assert.throws(() => decodePhoto(PNG.replace("image/png", "image/jpeg")), /contents/);
  assert.throws(() => decodePhoto("data:image/png;base64,aGVsbG8="), /contents/);
});

test("multiple connections reject concurrent stale writes", async (t) => {
  const { store, path } = await fixture(t);
  const second = await Store.open(path, catalogue, verified);
  try {
    const revision = second.revision();
    save(store);
    assert.throws(() => second.saveAscent({ revision, approachId: "stelvio-bormio" }), /another panel/);
    assert.equal(second.state().ascents.length, 1);
  } finally { second.close(); }
});

test("records and photos survive opening another store", async (t) => {
  const { store, path } = await fixture(t);
  const { id } = save(store, { photo: PNG, date: "2021-08-03", note: "Remember the summit." });
  const second = await Store.open(path, catalogue, verified);
  try {
    assert.equal(second.state().ascents[0].note, "Remember the summit.");
    assert.deepEqual(second.photo(id).bytes, store.photo(id).bytes);
  } finally { second.close(); }
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("backup round-trips custom approaches, repeat ascents, notes and photos", async (t) => {
  const { store } = await fixture(t);
  restoreLegacy(store);
  save(store);
  const backup = store.export();
  store.restore({ revision: store.revision(), backup: { format: backup.format, version: 1, approaches: [], ascents: [] } });
  assert.equal(store.state().ascents.length, 0);
  store.restore({ revision: store.revision(), backup });
  const restored = store.export();
  assert.deepEqual(restored.ascents, backup.ascents);
  assert.deepEqual(restored.approaches, backup.approaches);
});

test("schema-one passports gain all routes without changing ride IDs, photos or sync state", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "col-migration-"));
  const path = join(dir, "passport.sqlite");
  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO metadata VALUES ('schemaVersion', '1'), ('revision', '7');
    CREATE TABLE approaches (id TEXT PRIMARY KEY, pass_id TEXT NOT NULL, name TEXT NOT NULL,
      source_url TEXT, distance_km REAL, gain_m REAL, gradient REAL, verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ascents (id TEXT PRIMARY KEY, approach_id TEXT NOT NULL REFERENCES approaches(id),
      date TEXT NOT NULL, note TEXT NOT NULL, photo BLOB, mime TEXT, created_at TEXT NOT NULL);
  `);
  const previous = JSON.parse(await readFile(new URL("../.github/extensions/col-collector/data/verified-approaches.json", import.meta.url)));
  for (const a of previous) old.prepare("INSERT INTO approaches VALUES (?, ?, ?, ?, ?, ?, ?, 1)")
    .run(a.id, a.passId, a.name, a.sourceUrl, a.distanceKm, a.gainM, a.gradient);
  old.prepare("INSERT INTO ascents VALUES ('old-ride', 'stelvio-prad', '', 'Keep this', ?, 'image/png', '2020-01-01T12:00:00Z')")
    .run(Buffer.from(PNG.split(",")[1], "base64"));
  old.prepare("INSERT INTO metadata VALUES ('githubSync', ?)").run(JSON.stringify({ syncedRevision: 7, baseSha: "unchanged" }));
  old.close();
  const store = await Store.open(path, catalogue, verified);
  t.after(async () => { store.close(); await rm(dir, { recursive: true }); });
  assert.equal(store.state().approaches.length, 1340);
  assert.equal(store.state().ascents[0].id, "old-ride");
  assert.equal(store.state().ascents[0].note, "Keep this");
  assert.equal(Buffer.from(store.photo("old-ride").bytes).toString("base64"), PNG.split(",")[1]);
  assert.equal(store.revision(), 7);
  assert.deepEqual(store.getMetadata("githubSync"), { syncedRevision: 7, baseSha: "unchanged" });
  assert.equal(store.getMetadata("schemaVersion"), 2);
});

test("restore is atomic for unknown references, duplicates and corrupt photos", async (t) => {
  const { store } = await fixture(t);
  save(store, { photo: PNG });
  const original = store.export();
  for (const mutate of [
    (b) => { b.ascents[0].approachId = "unknown"; },
    (b) => { b.ascents.push(b.ascents[0]); },
    (b) => { b.ascents[0].photo = "corrupt"; },
    (b) => { b.version = 2; },
  ]) {
    const bad = structuredClone(original);
    mutate(bad);
    const revision = store.revision();
    assert.throws(() => store.restore({ revision, backup: bad }));
    assert.equal(store.revision(), revision);
    assert.deepEqual(store.export().ascents, original.ascents);
  }
});
