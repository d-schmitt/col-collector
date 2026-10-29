import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { privateStoragePath, Store } from "../.github/extensions/col-collector/store.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "col-privacy-"));
  t.after(() => rm(dir, { recursive: true }));
  return dir;
}

test("private storage rejects both repository directories and worktree git files", async (t) => {
  const dir = await fixture(t);
  for (const kind of ["repository", "worktree"]) {
    const root = join(dir, kind);
    await mkdir(root);
    if (kind === "repository") await mkdir(join(root, ".git"));
    else await writeFile(join(root, ".git"), "gitdir: /irrelevant/test-fixture\n");
    const destination = join(root, "nested", "passport.sqlite");
    await assert.rejects(Store.open(destination, { passes: [] }), /cannot be inside a Git repository/);
    await assert.rejects(access(join(root, "nested")), { code: "ENOENT" });
  }
});

test("existing and dangling symbolic links cannot redirect private storage into a checkout", async (t) => {
  const dir = await fixture(t);
  const root = join(dir, "repository");
  await mkdir(join(root, ".git"), { recursive: true });
  await symlink(root, join(dir, "linked-directory"));
  await assert.rejects(privateStoragePath(join(dir, "linked-directory", "new", "passport.sqlite")), /Git repository/);
  await symlink(join(root, "not-created.sqlite"), join(dir, "dangling.sqlite"));
  await assert.rejects(privateStoragePath(join(dir, "dangling.sqlite")), /Git repository/);
  await writeFile(join(root, "existing.sqlite"), "");
  await symlink(join(root, "existing.sqlite"), join(dir, "existing-link.sqlite"));
  await assert.rejects(privateStoragePath(join(dir, "existing-link.sqlite")), /Git repository/);
});

test("paths lexically inside a checkout stay forbidden even if they link outside", async (t) => {
  const dir = await fixture(t);
  const root = join(dir, "repository");
  await mkdir(join(root, ".git"), { recursive: true });
  await mkdir(join(dir, "outside"));
  await symlink(join(dir, "outside"), join(root, "external-data"));
  await assert.rejects(privateStoragePath(join(root, "external-data", "passport.sqlite")), /Git repository/);
});

test("database and SQLite sidecars are owner-only outside the source tree", async (t) => {
  const dir = await fixture(t);
  const path = join(dir, "private", "passport.sqlite");
  const store = await Store.open(path, { passes: [] });
  try {
    for (const suffix of ["", "-wal", "-shm"]) assert.equal((await stat(path + suffix)).mode & 0o777, 0o600);
  } finally { store.close(); }
  await assert.rejects(privateStoragePath("relative.sqlite"), /absolute path/);
});

test("private artifact filenames are ignored without hiding public catalogue files", () => {
  const privateFiles = [
    "passport.sqlite", "nested/passport.sqlite-wal", "nested/passport.sqlite-shm",
    "passport.db", "passport.db-shm", "data/passport.json",
    "col-collector-backup.json", "col-collector-before-pull.json", "col-collector-2026-10-29.json",
    "photos/summit.jpg", ".github/extensions/col-collector/artifacts/private.json", ".env.local",
  ];
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { input: privateFiles.join("\n") + "\n", encoding: "utf8" });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(new Set(ignored.stdout.trim().split("\n")), new Set(privateFiles));
  const publicFiles = [
    ".github/extensions/col-collector/data/catalogue.json",
    ".github/extensions/col-collector/data/approaches.json",
    ".github/extensions/col-collector/data/verified-approaches.json",
    ".github/extensions/col-collector/data/approach-sources.json",
    ".env.example",
  ];
  const publicResult = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { input: publicFiles.join("\n") + "\n", encoding: "utf8" });
  assert.equal(publicResult.status, 1, publicResult.stderr);
  assert.equal(publicResult.stdout, "");
});
