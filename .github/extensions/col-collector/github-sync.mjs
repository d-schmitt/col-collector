import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { InputError } from "./model.mjs";
import { decodePhoto } from "./store.mjs";

const CODE_REPOSITORY = "d-schmitt/col-collector";
const MAX_BACKUP = 60 * 1024 * 1024;
const MANIFEST_PATH = "passport.json";
const PHOTO_PATH = /^photos\/([a-f0-9]{64})\.(jpg|png|webp)$/;
const SHA = /^[a-f0-9]{40}$/;
const canonical = (value) => JSON.stringify(value, function (_key, item) {
  return item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item;
});
const gitHash = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

function assertBackupSize(backup) {
  if (!backup || backup.format !== "col-collector-passport" || ![1, 2].includes(backup.version) ||
      !Array.isArray(backup.approaches) || !Array.isArray(backup.ascents) ||
      backup.approaches.length > 10000 || backup.ascents.length > 10000 ||
      [...backup.approaches, ...backup.ascents].some((record) => !record || typeof record.id !== "string") ||
      Buffer.byteLength(JSON.stringify(backup)) > MAX_BACKUP) {
    throw new InputError("The sync backup is invalid or exceeds the 60 MB / 10,000 record limits.");
  }
}

function fingerprint(manifest) {
  const { exportedAt: _exportedAt, ...backup } = manifest.backup;
  return canonical({
    ...backup,
    approaches: [...backup.approaches].sort((a, b) => a.id.localeCompare(b.id)),
    ascents: [...backup.ascents].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

export function packBackup(backup) {
  assertBackupSize(backup);
  const manifest = { format: "col-collector-github", version: 1, backup: structuredClone(backup) };
  const photos = new Map();
  for (const ascent of manifest.backup.ascents) {
    const photo = decodePhoto(ascent.photo);
    if (!photo) { ascent.photo = null; continue; }
    const hash = createHash("sha256").update(photo.bytes).digest("hex");
    const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[photo.mime];
    ascent.photo = `photos/${hash}.${extension}`;
    photos.set(ascent.photo, photo.bytes);
  }
  return { manifest, photos };
}

// Credentials stay in gh's credential store and are never returned to the browser.
export function githubRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const args = ["api", "--hostname", "github.com", "--method", method, path];
    if (body !== undefined) args.push("--input", "-");
    const child = spawn("gh", args, {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", GH_DEBUG: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output = [];
    let size = 0, stderr = "", settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new InputError(message, 502));
    };
    const timer = setTimeout(() => fail("GitHub did not respond in time. Check your connection and retry; the next sync checks the remote state before writing."), 30000);
    child.on("error", () => fail("GitHub CLI could not start. Install gh and sign in to the GitHub account that owns your private data repository."));
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 90 * 1024 * 1024) return fail("GitHub returned an oversized response. Sync stopped without replacing local records.");
      output.push(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
    child.stdin.on("error", () => fail("The GitHub CLI request could not be sent. Check gh authentication and retry."));
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const status = code === 0 ? 200 : Number(/\(HTTP (\d{3})\)/.exec(stderr)?.[1]);
      if (!status) return reject(new InputError("GitHub CLI authentication or connection failed. Check gh authentication and repository access, then retry.", 502));
      let data;
      try { data = JSON.parse(Buffer.concat(output).toString() || "null"); }
      catch { return reject(new InputError("GitHub returned an unreadable response. Sync stopped.", 502)); }
      resolve({ status, data });
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export class GitHubSync {
  constructor(store, { request = githubRequest } = {}) {
    this.store = store;
    this.request = request;
  }

  status() {
    const config = this.store.getMetadata("githubSync");
    return {
      configured: !!config,
      repository: config?.repository ?? null,
      url: config?.url ?? null,
      branch: config?.branch ?? null,
      lastSyncAt: config?.lastSyncAt ?? null,
      baseSha: config?.baseSha ?? null,
      localChanged: config?.syncedRevision == null
        ? this.store.hasPersonalRecords() : this.store.revision() !== config.syncedRevision,
      hasRecovery: this.store.hasRecovery(),
    };
  }

  async locked(operation) {
    const lease = this.store.acquireSyncLease();
    const call = async (method, path, body) => {
      lease.renew();
      const result = await this.request(method, path, body);
      lease.renew();
      return result;
    };
    try { return await operation(call); }
    finally { lease.release(); }
  }

  async verify(call, repository, expectedId, writing = false) {
    const result = await call("GET", `repos/${repository}`);
    if (result.status !== 200) throw new InputError("Cannot access the data repository. Check the repository name and gh authentication.", 403);
    const repo = result.data;
    if (repo.private !== true || repo.visibility !== "private") {
      throw new InputError("Sync refused: the data repository must be private. No further passport data will be transferred.", 403);
    }
    if (expectedId && repo.id !== expectedId) throw new InputError("The configured repository identity changed. Reconnect it explicitly before syncing.", 409);
    if (repo.full_name?.toLowerCase() === CODE_REPOSITORY.toLowerCase()) {
      throw new InputError("Choose a separate private data repository, not the application source repository.");
    }
    if (repo.archived || (writing && repo.permissions?.push !== true)) {
      throw new InputError("The data repository is archived or this account cannot push to it.", 403);
    }
    if (!Number.isSafeInteger(repo.id) || typeof repo.default_branch !== "string" ||
        typeof repo.full_name !== "string" || !/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo.html_url)) {
      throw new InputError("GitHub returned incomplete repository metadata.", 502);
    }
    return repo;
  }

  async connect(repository) {
    if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.length > 200) {
      throw new InputError("Enter a repository in owner/name form.");
    }
    return this.locked(async (call) => {
      const repo = await this.verify(call, repository);
      const previous = this.store.getMetadata("githubSync");
      if (previous?.repositoryId === repo.id) {
        this.store.setMetadata("githubSync", { ...previous, repository: repo.full_name, url: repo.html_url });
      } else {
        this.store.setMetadata("githubSync", {
          repository: repo.full_name, repositoryId: repo.id, branch: repo.default_branch,
          url: repo.html_url, baseSha: null, syncedRevision: null, lastSyncAt: null,
        });
      }
      return this.status();
    });
  }

  config() {
    const config = this.store.getMetadata("githubSync");
    if (!config) throw new InputError("Connect a private data repository first.");
    return config;
  }

  async remote(call, config) {
    const root = `repos/${config.repository}`;
    const ref = await call("GET", `${root}/git/ref/heads/${encodeURIComponent(config.branch)}`);
    if (ref.status === 404 || ref.status === 409) {
      throw new InputError("The data branch is missing. Initialize the private repository with a README before syncing.", 409);
    }
    if (ref.status !== 200 || !SHA.test(ref.data?.object?.sha)) throw new InputError("Could not read the data branch.", 502);
    const sha = ref.data.object.sha;
    const commit = await call("GET", `${root}/git/commits/${sha}`);
    if (commit.status !== 200 || !SHA.test(commit.data?.tree?.sha)) throw new InputError("Could not read the backup commit.", 502);
    const tree = await call("GET", `${root}/git/trees/${commit.data.tree.sha}?recursive=1`);
    if (tree.status !== 200 || !Array.isArray(tree.data?.tree) || tree.data.truncated || tree.data.tree.length > 20000) {
      throw new InputError("The remote repository tree is incomplete or too large. Sync stopped.", 502);
    }
    const entries = new Map(tree.data.tree.map((entry) => [entry.path, entry]));
    const manifestEntry = entries.get(MANIFEST_PATH);
    let manifest = null;
    if (manifestEntry) {
      const bytes = await this.blob(call, config, manifestEntry, MAX_BACKUP);
      try { manifest = JSON.parse(bytes.toString("utf8")); }
      catch { throw new InputError("The remote passport manifest is not valid JSON."); }
      if (manifest?.format !== "col-collector-github" || manifest.version !== 1) {
        throw new InputError("The remote passport manifest has an unsupported format. It will not be overwritten.");
      }
      assertBackupSize(manifest.backup);
      for (const ascent of manifest.backup.ascents) {
        if (!ascent || typeof ascent.id !== "string" || (ascent.photo !== null && !PHOTO_PATH.test(ascent.photo))) {
          throw new InputError("The remote passport contains an invalid photo reference.");
        }
      }
    }
    return { sha, treeSha: commit.data.tree.sha, entries, manifest };
  }

  async blob(call, config, entry, maxBytes) {
    if (!entry || entry.type !== "blob" || entry.mode !== "100644" || !SHA.test(entry.sha) ||
        !Number.isSafeInteger(entry.size) || entry.size > maxBytes || entry.size < 0) {
      throw new InputError("A remote backup file is missing, invalid, or too large.");
    }
    const response = await call("GET", `repos/${config.repository}/git/blobs/${entry.sha}`);
    if (response.status !== 200 || response.data?.encoding !== "base64" || typeof response.data.content !== "string") {
      throw new InputError("A remote backup file could not be downloaded.", 502);
    }
    const bytes = Buffer.from(response.data.content.replace(/\n/g, ""), "base64");
    if (bytes.length !== entry.size || gitHash(bytes) !== entry.sha) throw new InputError("A remote backup file failed its integrity check.");
    return bytes;
  }

  async push(revision) {
    return this.locked(async (call) => {
      const config = this.config();
      await this.verify(call, config.repository, config.repositoryId, true);
      const snapshot = this.store.exportSnapshot();
      if (revision !== snapshot.revision) throw new InputError("The passport changed. Reload records before pushing.", 409);
      const { manifest, photos } = packBackup(snapshot.backup);
      const remote = await this.remote(call, config);
      const alreadyMatches = remote.manifest && fingerprint(remote.manifest) === fingerprint(manifest) &&
        [...photos].every(([path, bytes]) => remote.entries.get(path)?.sha === gitHash(bytes));
      if (alreadyMatches) {
        this.store.setMetadata("githubSync", { ...config, baseSha: remote.sha, syncedRevision: snapshot.revision, lastSyncAt: new Date().toISOString() });
        return { message: "GitHub already has this backup.", sync: this.status() };
      }
      if ((config.baseSha && config.baseSha !== remote.sha) || (!config.baseSha && remote.manifest)) {
        throw new InputError("GitHub has a backup you have not pulled. Push stopped to protect it. Download a local backup, then pull or explicitly replace the local copy.", 409);
      }
      // Recheck privacy immediately before uploading any personal content.
      await this.verify(call, config.repository, config.repositoryId, true);
      const tree = [];
      const root = `repos/${config.repository}`;
      const upload = async (bytes) => {
        const response = await call("POST", `${root}/git/blobs`, { content: bytes.toString("base64"), encoding: "base64" });
        if (response.status !== 200 || response.data?.sha !== gitHash(bytes)) throw new InputError("GitHub did not confirm the uploaded file. Retry sync.", 502);
        return response.data.sha;
      };
      for (const [path, bytes] of photos) {
        const sha = gitHash(bytes);
        if (remote.entries.get(path)?.sha !== sha) tree.push({ path, mode: "100644", type: "blob", sha: await upload(bytes) });
      }
      for (const ascent of remote.manifest?.backup.ascents ?? []) {
        if (ascent.photo && !photos.has(ascent.photo) && !tree.some((entry) => entry.path === ascent.photo)) {
          tree.push({ path: ascent.photo, mode: "100644", type: "blob", sha: null });
        }
      }
      tree.push({ path: MANIFEST_PATH, mode: "100644", type: "blob", sha: await upload(Buffer.from(JSON.stringify(manifest, null, 2) + "\n")) });
      const createdTree = await call("POST", `${root}/git/trees`, { base_tree: remote.treeSha, tree });
      if (createdTree.status !== 200 || !SHA.test(createdTree.data?.sha)) throw new InputError("GitHub could not create the backup tree.", 502);
      const commit = await call("POST", `${root}/git/commits`, {
        message: "Back up Col Collector passport",
        tree: createdTree.data.sha, parents: [remote.sha],
      });
      if (commit.status !== 200 || !SHA.test(commit.data?.sha)) throw new InputError("GitHub could not create the backup commit.", 502);
      await this.verify(call, config.repository, config.repositoryId, true);
      const updated = await call("PATCH", `${root}/git/refs/heads/${encodeURIComponent(config.branch)}`, { sha: commit.data.sha, force: false });
      if (updated.status !== 200) throw new InputError("GitHub could not advance the backup branch, or another device changed it. Nothing was force-pushed. Retry sync to check the remote state.", 409);
      if (updated.data?.object?.sha !== commit.data.sha) throw new InputError("GitHub did not confirm the new backup head. Retry sync to reconcile the remote state.", 502);
      this.store.setMetadata("githubSync", { ...config, baseSha: commit.data.sha, syncedRevision: snapshot.revision, lastSyncAt: new Date().toISOString() });
      return { message: "Passport and photos pushed to the private repository.", sync: this.status() };
    });
  }

  async pull(revision, replaceLocal = false) {
    if (typeof replaceLocal !== "boolean") throw new InputError("Replace-local confirmation must be a boolean.");
    return this.locked(async (call) => {
      const config = this.config();
      if (revision !== this.store.revision()) throw new InputError("The passport changed. Reload records before pulling.", 409);
      if (this.status().localChanged && !replaceLocal) {
        throw new InputError("Pull stopped: you have unpushed local changes. Push them first, or use Replace local from GitHub after saving a backup.", 409);
      }
      assertBackupSize(this.store.exportSnapshot().backup);
      await this.verify(call, config.repository, config.repositoryId);
      const remote = await this.remote(call, config);
      if (!remote.manifest) throw new InputError("There is no Col Collector backup in this repository yet. Push the first backup from the device with your rides.");
      if (config.baseSha === remote.sha && !this.status().localChanged) {
        return { message: "Your local passport already matches the last pulled backup.", sync: this.status() };
      }
      const backup = structuredClone(remote.manifest.backup);
      const photoCache = new Map();
      let decodedSize = Buffer.byteLength(JSON.stringify(backup));
      for (const ascent of backup.ascents) {
        if (!ascent.photo) continue;
        const path = ascent.photo;
        if (!photoCache.has(path)) {
          const bytes = await this.blob(call, config, remote.entries.get(path), 4 * 1024 * 1024);
          const [, hash, ext] = PHOTO_PATH.exec(path);
          if (createHash("sha256").update(bytes).digest("hex") !== hash) throw new InputError("A remote photo failed its content-hash check.");
          const mime = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[ext];
          const data = `data:${mime};base64,${bytes.toString("base64")}`;
          decodePhoto(data);
          photoCache.set(path, data);
        }
        ascent.photo = photoCache.get(path);
        decodedSize += ascent.photo.length;
        if (decodedSize > MAX_BACKUP) throw new InputError("The remote backup exceeds the 60 MB restore limit.");
      }
      assertBackupSize(backup);
      await this.verify(call, config.repository, config.repositoryId);
      const ref = await call("GET", `repos/${config.repository}/git/ref/heads/${encodeURIComponent(config.branch)}`);
      if (ref.status !== 200 || ref.data?.object?.sha !== remote.sha) throw new InputError("The remote backup changed during download. Retry pull.", 409);
      const restored = this.store.restore({ revision, backup }, { ...config, baseSha: remote.sha, lastSyncAt: new Date().toISOString() });
      return { message: `Pulled ${restored.restored} ascents. Your previous local passport is available as a recovery backup.`, sync: this.status() };
    });
  }
}
