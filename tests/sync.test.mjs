import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRuntime } from "../.github/extensions/col-collector/runtime.mjs";
import { GitHubSync } from "../.github/extensions/col-collector/github-sync.mjs";
import { FakeGitHub } from "./fake-github.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const save = (runtime, input = {}) => runtime.store.saveAscent({ revision: runtime.store.revision(), approachId: "stelvio-prad", ...input });
const push = (runtime) => runtime.sync.push(runtime.store.revision());
const pull = (runtime, replace = false) => runtime.sync.pull(runtime.store.revision(), replace);

async function setup(t, count = 2) {
  const dir = await mkdtemp(join(tmpdir(), "col-sync-"));
  const github = new FakeGitHub();
  const devices = [];
  for (let i = 0; i < count; i++) {
    const runtime = await createRuntime({ dataPath: join(dir, `${i}.sqlite`), syncRequest: github.request });
    await runtime.sync.connect(github.repo.full_name);
    devices.push(runtime);
  }
  t.after(async () => { await Promise.all(devices.map((runtime) => runtime.dispose())); await rm(dir, { recursive: true }); });
  return { github, devices, dir };
}

test("private sync stores separate binary photos and round-trips the passport", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a, { photo: PNG, note: "A private memory", date: "2020-07-12" });
  await push(a);
  const manifest = JSON.parse(github.read("passport.json").toString());
  const path = manifest.backup.ascents[0].photo;
  assert.match(path, /^photos\/[0-9a-f]{64}\.png$/);
  assert.equal(github.read(path).toString("base64"), PNG.split(",")[1]);
  assert.ok(!JSON.stringify(manifest).includes("base64"));
  assert.ok(!JSON.stringify(manifest).includes("githubSync"));
  assert.equal(github.read("README.md").toString(), "Private passport data\n");
  await pull(b);
  assert.deepEqual(b.store.export().ascents, a.store.export().ascents);
  assert.equal(b.sync.status().localChanged, false);
  assert.equal(b.sync.status().hasRecovery, true);
});

test("unknown approaches survive private sync, edits, conflict recovery and deletion", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  const passId = "pass-965d3e148f028ea0";
  const first = save(a, { approachId: null, passId, photo: PNG, note: "Unknown approach" });
  save(a, { approachId: null, passId });
  await push(a);
  const manifest = JSON.parse(github.read("passport.json"));
  assert.equal(manifest.backup.version, 2);
  assert.ok(manifest.backup.ascents.every((ascent) => ascent.approachId === null && ascent.passId === passId));
  await pull(b);
  assert.deepEqual(b.store.export().ascents, a.store.export().ascents);
  save(b, { id: first.id, approachId: null, passId, note: "Edited on another device" });
  await push(b);
  save(a, { approachId: null, passId, note: "Local repeat" });
  const before = a.store.export();
  await assert.rejects(push(a), /have not pulled/);
  await assert.rejects(pull(a), /unpushed local/);
  await pull(a, true);
  assert.deepEqual(a.store.getMetadata("syncRecovery").ascents, before.ascents);
  assert.deepEqual(a.store.export().ascents, b.store.export().ascents);
  a.store.restore({ revision: a.store.revision(), backup: a.store.getMetadata("syncRecovery") });
  assert.deepEqual(a.store.export().ascents, before.ascents);
  for (const ascent of a.store.state().ascents) a.store.deleteAscent({ revision: a.store.revision(), id: ascent.id });
  await push(a);
  await pull(b);
  assert.equal(b.store.state().ascents.length, 0);
});

test("private sync accepts version-one backups without changing their records", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a, { photo: PNG });
  await push(a);
  const manifest = JSON.parse(github.read("passport.json"));
  manifest.backup.version = 1;
  for (const ascent of manifest.backup.ascents) delete ascent.passId;
  github.commitFiles({ "passport.json": Buffer.from(JSON.stringify(manifest)) });
  await pull(b);
  assert.deepEqual(b.store.export().ascents, a.store.export().ascents);
  await push(b);
  assert.equal(JSON.parse(github.read("passport.json")).backup.version, 2);
});

test("fresh device cannot push over an existing remote backup", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a);
  await push(a);
  const head = github.head;
  await assert.rejects(push(b), /have not pulled/);
  assert.equal(github.head, head);
  assert.equal(b.store.state().ascents.length, 0);
});

test("diverged copies refuse both unsafe push and unconfirmed pull", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a);
  await push(a);
  await pull(b);
  save(b, { note: "Remote changes" });
  await push(b);
  save(a, { note: "Local changes" });
  const before = github.head;
  await assert.rejects(push(a), /have not pulled/);
  await assert.rejects(pull(a), /unpushed local/);
  assert.equal(github.head, before);
  assert.equal(a.store.state().ascents.length, 2);
});

test("explicit replacement keeps an exact recovery copy and can be restored", async (t) => {
  const { devices: [a, b] } = await setup(t);
  save(a, { photo: PNG });
  await push(a);
  save(b, { note: "Unpushed work" });
  const before = b.store.export();
  await pull(b, true);
  const recovery = b.store.getMetadata("syncRecovery");
  assert.deepEqual(recovery.ascents, before.ascents);
  const revision = b.store.revision();
  await pull(b);
  assert.equal(b.store.revision(), revision);
  assert.deepEqual(b.store.getMetadata("syncRecovery"), recovery);
  b.store.restore({ revision: b.store.revision(), backup: recovery });
  assert.equal(b.store.state().ascents[0].note, "Unpushed work");
  assert.equal(b.sync.status().localChanged, true);
});

test("public or internal visibility refuses reads and writes before personal transfer", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  save(a, { photo: PNG });
  for (const visibility of ["public", "internal"]) {
    github.repo.visibility = visibility;
    github.repo.private = visibility !== "public";
    github.calls = [];
    await assert.rejects(push(a), /must be private/);
    await assert.rejects(pull(a, true), /must be private/);
    assert.ok(github.calls.every((call) => call.method === "GET" && call.path === `repos/${github.repo.full_name}`));
  }
});

test("repo identity, permissions and source repository are checked", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  github.repo.id++;
  await assert.rejects(push(a), /identity changed/);
  github.repo.id--;
  github.repo.permissions.push = false;
  await assert.rejects(push(a), /cannot push/);
  github.repo.full_name = "d-schmitt/col-collector";
  await assert.rejects(a.sync.connect(github.repo.full_name), /source repository/);
  await assert.rejects(a.sync.connect("https://evil.example/owner/repo"), /owner\/name/);
});

test("remote head race is rejected without a force push", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  save(a);
  github.beforeRequest = (method) => {
    if (method === "PATCH") github.commitFiles({ "README.md": Buffer.from("Another device changed the head") });
  };
  await assert.rejects(push(a), /Nothing was force-pushed/);
  assert.equal(a.sync.status().baseSha, null);
  assert.equal(github.read("passport.json"), undefined);
});

test("an ambiguous successful push is reconciled on retry without duplicate commits", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  save(a, { photo: PNG });
  let interrupted = false;
  a.sync.request = async (...args) => {
    const response = await github.request(...args);
    if (args[0] === "PATCH" && !interrupted) { interrupted = true; throw new Error("Connection lost after remote success"); }
    return response;
  };
  await assert.rejects(push(a), /Connection lost/);
  const head = github.head, count = github.commits.size;
  await push(a);
  assert.equal(github.head, head);
  assert.equal(github.commits.size, count);
  assert.equal(a.sync.status().baseSha, head);
  assert.equal(a.sync.status().localChanged, false);
});

test("a local edit during upload remains marked as unpushed", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  save(a);
  let changed = false;
  github.beforeRequest = (method) => {
    if (method === "POST" && !changed) { changed = true; save(a, { note: "Added during upload" }); }
  };
  await push(a);
  assert.equal(a.sync.status().localChanged, true);
  assert.equal(JSON.parse(github.read("passport.json")).backup.ascents.length, 1);
  await push(a);
  assert.equal(JSON.parse(github.read("passport.json")).backup.ascents.length, 2);
});

test("a local edit during download prevents restoration", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a, { photo: PNG });
  await push(a);
  let changed = false;
  github.beforeRequest = (_method, path) => {
    if (path.includes("/git/blobs/") && !changed) { changed = true; save(b, { note: "Local edit during download" }); }
  };
  await assert.rejects(pull(b), /another panel/);
  assert.equal(b.store.state().ascents[0].note, "Local edit during download");
  assert.equal(b.store.hasRecovery(), false);
});

test("a remote change during download prevents restoration", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a);
  await push(a);
  let changed = false;
  github.beforeRequest = (_method, path) => {
    if (path.includes("/git/blobs/") && !changed) { changed = true; github.commitFiles({ "README.md": Buffer.from("New head") }); }
  };
  await assert.rejects(pull(b), /changed during download/);
  assert.equal(b.store.state().ascents.length, 0);
});

test("invalid remote photos and unknown approaches roll back completely", async (t) => {
  const { github, devices: [a, b] } = await setup(t);
  save(a, { photo: PNG });
  await push(a);
  const original = JSON.parse(github.read("passport.json"));
  for (const mutate of [
    (manifest) => { manifest.backup.ascents[0].photo = "../../private-file"; },
    (manifest) => { manifest.backup.ascents[0].photo = `photos/${"0".repeat(64)}.png`; },
    (manifest) => { manifest.backup.ascents[0].approachId = "unknown"; },
  ]) {
    const manifest = structuredClone(original);
    mutate(manifest);
    github.commitFiles({ "passport.json": Buffer.from(JSON.stringify(manifest)) });
    await assert.rejects(pull(b));
    assert.equal(b.store.state().ascents.length, 0);
    assert.equal(b.store.hasRecovery(), false);
    assert.equal(b.sync.status().baseSha, null);
  }
});

test("photo deletion removes only managed paths from the current tree, not history", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  const ascent = save(a, { photo: PNG });
  await push(a);
  const oldPhoto = JSON.parse(github.read("passport.json")).backup.ascents[0].photo;
  const oldPhotoSha = github.tree().get(oldPhoto).sha;
  a.store.deleteAscent({ revision: a.store.revision(), id: ascent.id });
  await push(a);
  assert.equal(github.read(oldPhoto), undefined);
  assert.ok(github.blobs.has(oldPhotoSha));
  assert.ok(github.read("README.md"));
});

test("sync leases prevent overlapping operations across clients", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  const competing = new GitHubSync(a.store, { request: github.request });
  const lease = a.store.acquireSyncLease();
  try { await assert.rejects(competing.connect(github.repo.full_name), /already syncing/); }
  finally { lease.release(); }
  await competing.connect(github.repo.full_name);
});

test("reconnecting the same repository preserves the synchronization baseline", async (t) => {
  const { github, devices: [a] } = await setup(t, 1);
  save(a);
  await push(a);
  const before = a.sync.status();
  await a.sync.connect(github.repo.full_name);
  assert.equal(a.sync.status().baseSha, before.baseSha);
  assert.equal(a.sync.status().localChanged, false);
});
