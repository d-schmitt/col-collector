import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { folderInstall } from "./folder-install.mjs";

test("folder-only distribution includes the exact pinned Leaflet assets and license before postinstall", async (t) => {
  const install = await folderInstall();
  t.after(() => install.dispose());
  for (const path of ["package.json", "package-lock.json", "node_modules", "scripts/copy-assets.mjs"]) {
    await assert.rejects(access(join(install.dir, path)), { code: "ENOENT" });
    await assert.rejects(access(join(install.extension, path)), { code: "ENOENT" });
  }
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  const installed = JSON.parse(await readFile(new URL("../node_modules/leaflet/package.json", import.meta.url)));
  assert.match(manifest.dependencies.leaflet, /^\d+\.\d+\.\d+$/);
  assert.equal(installed.version, manifest.dependencies.leaflet);
  for (const [bundled, upstream] of [
    ["leaflet.js", "dist/leaflet.js"], ["leaflet.css", "dist/leaflet.css"], ["LEAFLET-LICENSE", "LICENSE"],
  ]) {
    const actual = await readFile(join(install.extension, "web/vendor", bundled));
    assert.deepEqual(actual, await readFile(new URL(`../node_modules/leaflet/${upstream}`, import.meta.url)), bundled);
  }
});

test("incomplete folder-only install reports missing assets and serves repairs without restarting", async (t) => {
  const install = await folderInstall();
  t.after(() => install.dispose());
  for (const asset of ["leaflet.js", "leaflet.css"]) {
    const path = join(install.extension, "web/vendor", asset);
    await rename(path, path + ".temporarily-missing");
    try {
      const response = await fetch(install.url + "vendor/" + asset);
      assert.equal(response.status, 503);
      const { error } = await response.json();
      assert.match(error, /complete Col Collector extension folder/);
      assert.doesNotMatch(error, /npm ci/);
      assert.equal((await fetch(install.url + "api/catalogue")).status, 200);
      assert.equal((await fetch(install.url + "api/state")).status, 200);
    } finally { await rename(path + ".temporarily-missing", path); }
    assert.equal((await fetch(install.url + "vendor/" + asset)).status, 200);
  }
});
