import { DatabaseSync } from "node:sqlite";
import { mkdir, chmod, lstat, realpath, readlink, open as openFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { InputError, text, validateDate, validateSourceUrl } from "./model.mjs";

export function defaultDataPath() {
  return join(process.env.COPILOT_HOME || join(homedir(), ".copilot"),
    "extensions", "col-collector", "artifacts", "passport.sqlite");
}

async function resolveStoragePath(path, depth = 0) {
  if (depth > 40) throw new Error("The passport storage path contains too many symbolic links.");
  try { return await realpath(path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Resolve dangling links too: their future target must not land in a checkout.
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      return resolveStoragePath(resolve(dirname(path), await readlink(path)), depth + 1);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const parent = dirname(path);
  if (parent === path) throw new Error("The passport storage location could not be resolved.");
  return join(await resolveStoragePath(parent, depth + 1), basename(path));
}

export async function privateStoragePath(path) {
  if (!isAbsolute(path)) throw new Error("COL_COLLECTOR_DATA_PATH must be an absolute path outside Git repositories.");
  const canonical = await resolveStoragePath(path);
  for (const candidate of new Set([resolve(path), canonical])) {
    let directory = dirname(candidate);
    while (true) {
      let marker;
      try { marker = await lstat(join(directory, ".git")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (marker) throw new Error("Private passport storage cannot be inside a Git repository. Choose a different COL_COLLECTOR_DATA_PATH.");
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return canonical;
}

export function decodePhoto(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > 5_600_000) {
    throw new InputError("Choose a JPEG, PNG or WebP photo smaller than 4 MB.");
  }
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new InputError("The photo must be JPEG, PNG or WebP.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > 4 * 1024 * 1024 || bytes.toString("base64") !== match[2]) {
    throw new InputError("The photo is too large or its encoding is invalid.");
  }
  const valid = match[1] === "image/jpeg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : match[1] === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  if (!valid) throw new InputError("The photo contents do not match its format.");
  return { bytes, mime: match[1] };
}

function id(value) { return text(value, "Identifier", 100, true); }

export class Store {
  static async open(path, catalogue, verifiedApproaches = []) {
    path = await privateStoragePath(path);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await openFile(path, "a", 0o600);
    await file.close();
    await chmod(path, 0o600);
    const store = new Store(path, catalogue, verifiedApproaches);
    try {
      for (const suffix of ["-wal", "-shm"]) {
        try { await chmod(path + suffix, 0o600); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    } catch (error) { store.close(); throw error; }
    return store;
  }

  constructor(path, catalogue, verifiedApproaches) {
    this.catalogue = catalogue;
    this.passIds = new Set(catalogue.passes.map((p) => p.id));
    this.verifiedApproaches = verifiedApproaches;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('revision', '0');
      INSERT OR IGNORE INTO metadata VALUES ('schemaVersion', '2');
      CREATE TABLE IF NOT EXISTS approaches (
        id TEXT PRIMARY KEY, pass_id TEXT NOT NULL, name TEXT NOT NULL,
        source_url TEXT, distance_km REAL, gain_m REAL, gradient REAL,
        verified INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS ascents (
        id TEXT PRIMARY KEY, approach_id TEXT NOT NULL REFERENCES approaches(id),
        date TEXT NOT NULL, note TEXT NOT NULL, photo BLOB, mime TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS geocache (query TEXT PRIMARY KEY, response TEXT NOT NULL, saved_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_lock (id INTEGER PRIMARY KEY CHECK(id=1), token TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    if (!["1", "2", "3"].includes(this.db.prepare("SELECT value FROM metadata WHERE key='schemaVersion'").get().value)) {
      this.db.close();
      throw new Error("This passport uses a newer schema. Upgrade Col Collector before opening it.");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("PRAGMA table_info(approaches)").all().some((column) => column.name === "source_kind")) {
        this.db.exec("ALTER TABLE approaches ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'");
      }
      this.seed();
      if (!this.db.prepare("PRAGMA table_info(ascents)").all().some((column) => column.name === "pass_id")) {
        this.db.exec(`
          CREATE TABLE ascents_v3 (
            id TEXT PRIMARY KEY, approach_id TEXT REFERENCES approaches(id),
            date TEXT NOT NULL, note TEXT NOT NULL, photo BLOB, mime TEXT,
            created_at TEXT NOT NULL, pass_id TEXT NOT NULL
          );
          INSERT INTO ascents_v3
            SELECT a.*, p.pass_id FROM ascents a LEFT JOIN approaches p ON p.id=a.approach_id;
          DROP TABLE ascents;
          ALTER TABLE ascents_v3 RENAME TO ascents;
        `);
      }
      this.db.prepare("UPDATE metadata SET value='3' WHERE key='schemaVersion'").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  seed() {
    const insert = this.db.prepare(`INSERT INTO approaches
      (id, pass_id, name, source_url, distance_km, gain_m, gradient, verified, source_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, source_url=excluded.source_url,
      distance_km=excluded.distance_km, gain_m=excluded.gain_m, gradient=excluded.gradient,
      source_kind=excluded.source_kind WHERE approaches.verified=1`);
    for (const approach of this.verifiedApproaches) {
      if (!this.passIds.has(approach.passId)) throw new Error(`Unknown curated pass: ${approach.passId}`);
      insert.run(approach.id, approach.passId, approach.name, approach.sourceUrl,
        approach.distanceKm ?? null, approach.gainM ?? null, approach.gradient ?? null,
        approach.sourceKind ?? "verified-route");
    }
  }

  revision() { return Number(this.db.prepare("SELECT value FROM metadata WHERE key='revision'").get().value); }

  state() {
    // Keep the revision and rows from the same snapshot, even with multiple sessions open.
    this.db.exec("BEGIN");
    try {
      return {
        revision: this.revision(),
        approaches: this.db.prepare(`SELECT id, pass_id AS passId, name, source_url AS sourceUrl,
          distance_km AS distanceKm, gain_m AS gainM, gradient, verified, source_kind AS sourceKind
          FROM approaches ORDER BY name`).all(),
        ascents: this.db.prepare(`SELECT id, approach_id AS approachId, pass_id AS passId, date, note,
          photo IS NOT NULL AS hasPhoto, created_at AS createdAt FROM ascents ORDER BY created_at DESC`).all(),
      };
    } finally { this.db.exec("COMMIT"); }
  }

  mutate(expectedRevision, callback) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new InputError("A valid passport revision is required.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.revision();
      if (current !== expectedRevision) {
        throw new InputError("Your passport changed in another panel. Reload the latest records before saving again; your draft is still here.", 409);
      }
      const result = callback();
      this.db.prepare("UPDATE metadata SET value=? WHERE key='revision'").run(String(current + 1));
      this.db.exec("COMMIT");
      return result;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  saveAscent(input) {
    const approachId = input.approachId === null ? null : id(input.approachId);
    const date = validateDate(input.date ?? "");
    const note = text(input.note ?? "", "Note", 4000);
    const photo = decodePhoto(input.photo);
    return this.mutate(input.revision, () => {
      const approach = approachId === null ? null
        : this.db.prepare("SELECT verified, pass_id FROM approaches WHERE id=?").get(approachId);
      if (approachId !== null && !approach) throw new InputError("Choose an existing approach.");
      const passId = input.passId === undefined && approach ? approach.pass_id : id(input.passId);
      if (!this.passIds.has(passId)) throw new InputError("Choose an existing pass.");
      if (approach && approach.pass_id !== passId) throw new InputError("The approach does not belong to this pass.");
      const ascentId = input.id ? id(input.id) : randomUUID();
      const existing = input.id ? this.db.prepare("SELECT * FROM ascents WHERE id=?").get(ascentId) : null;
      if (input.id && !existing) throw new InputError("This ascent no longer exists.", 404);
      if (approach && !approach.verified && existing?.approach_id !== approachId) {
        throw new InputError("Choose a preloaded approach for a new ascent. Historical custom routes are retained only for existing records.");
      }
      const keepPhoto = input.photo === undefined && existing;
      this.db.prepare(`INSERT INTO ascents VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET approach_id=excluded.approach_id, pass_id=excluded.pass_id, date=excluded.date,
        note=excluded.note, photo=excluded.photo, mime=excluded.mime`).run(
        ascentId, approachId, date, note,
        keepPhoto ? existing.photo : photo?.bytes ?? null,
        keepPhoto ? existing.mime : photo?.mime ?? null,
        existing?.created_at ?? new Date().toISOString(), passId);
      return { id: ascentId };
    });
  }

  deleteAscent(input) {
    return this.mutate(input.revision, () => {
      const result = this.db.prepare("DELETE FROM ascents WHERE id=?").run(id(input.id));
      if (!result.changes) throw new InputError("This ascent no longer exists.", 404);
      return { deleted: true };
    });
  }

  photo(ascentId) {
    const row = this.db.prepare("SELECT photo, mime FROM ascents WHERE id=?").get(id(ascentId));
    if (!row?.photo) throw new InputError("Photo not found.", 404);
    return { bytes: row.photo, mime: row.mime };
  }

  export() {
    return this.exportSnapshot().backup;
  }

  backupData() {
    return {
      format: "col-collector-passport", version: 2, exportedAt: new Date().toISOString(),
      approaches: this.db.prepare(`SELECT id, pass_id AS passId, name, source_url AS sourceUrl
        FROM approaches WHERE verified=0 ORDER BY id`).all(),
      ascents: this.db.prepare("SELECT * FROM ascents ORDER BY id").all().map((row) => ({
        id: row.id, approachId: row.approach_id, passId: row.pass_id, date: row.date, note: row.note, createdAt: row.created_at,
        photo: row.photo ? `data:${row.mime};base64,${Buffer.from(row.photo).toString("base64")}` : null,
      })),
    };
  }

  exportSnapshot() {
    this.db.exec("BEGIN");
    try {
      return { revision: this.revision(), backup: this.backupData() };
    } finally { this.db.exec("COMMIT"); }
  }

  restore(input, syncConfig) {
    const data = input.backup;
    if (!data || data.format !== "col-collector-passport" || ![1, 2].includes(data.version) ||
        !Array.isArray(data.approaches) || !Array.isArray(data.ascents) ||
        data.approaches.length > 10000 || data.ascents.length > 10000) {
      throw new InputError("This is not a supported Col Collector backup.");
    }
    return this.mutate(input.revision, () => {
      if (syncConfig) this.setMetadata("syncRecovery", this.backupData());
      this.db.exec("DELETE FROM ascents; DELETE FROM approaches WHERE verified=0;");
      const approachPasses = new Map(this.verifiedApproaches.map((a) => [a.id, a.passId]));
      const names = new Set();
      for (const a of data.approaches) {
        if (!a || !this.passIds.has(a.passId)) throw new InputError("A backup approach refers to an unknown pass.");
        const approachId = id(a.id);
        const name = text(a.name, "Approach name", 160, true);
        const key = `${a.passId}|${name.toLocaleLowerCase()}`;
        if (approachPasses.has(approachId) || names.has(key)) throw new InputError("The backup contains duplicate approaches.");
        approachPasses.set(approachId, a.passId);
        names.add(key);
        this.db.prepare("INSERT INTO approaches (id, pass_id, name, source_url) VALUES (?, ?, ?, ?)")
          .run(approachId, a.passId, name, validateSourceUrl(a.sourceUrl));
      }
      const ascentIds = new Set();
      for (const a of data.ascents) {
        if (!a || (!(data.version === 2 && a.approachId === null) && !approachPasses.has(a.approachId))) {
          throw new InputError("A backup ascent refers to an unknown approach. Update the app's catalogue before restoring.");
        }
        const passId = data.version === 1 ? approachPasses.get(a.approachId) : a.passId;
        if (!this.passIds.has(passId)) throw new InputError("A backup ascent refers to an unknown pass.");
        if (a.approachId !== null && approachPasses.get(a.approachId) !== passId) {
          throw new InputError("A backup approach does not belong to its ascent's pass.");
        }
        const ascentId = id(a.id);
        if (ascentIds.has(ascentId)) throw new InputError("The backup contains duplicate ascents.");
        ascentIds.add(ascentId);
        const photo = decodePhoto(a.photo);
        if (typeof a.createdAt !== "string" || !Number.isFinite(Date.parse(a.createdAt))) {
          throw new InputError("An ascent has an invalid creation date.");
        }
        this.db.prepare("INSERT INTO ascents VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(ascentId, a.approachId, validateDate(a.date), text(a.note, "Note", 4000),
            photo?.bytes ?? null, photo?.mime ?? null, new Date(a.createdAt).toISOString(), passId);
      }
      if (syncConfig) this.setMetadata("githubSync", { ...syncConfig, syncedRevision: input.revision + 1 });
      return { restored: data.ascents.length };
    });
  }

  getMetadata(key) {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key=?").get(key);
    return row ? JSON.parse(row.value) : null;
  }

  setMetadata(key, value) {
    this.db.prepare("INSERT OR REPLACE INTO metadata VALUES (?, ?)").run(key, JSON.stringify(value));
  }

  hasRecovery() {
    return !!this.db.prepare("SELECT 1 FROM metadata WHERE key='syncRecovery'").get();
  }

  hasPersonalRecords() {
    return !!this.db.prepare("SELECT 1 FROM ascents UNION ALL SELECT 1 FROM approaches WHERE verified=0 LIMIT 1").get();
  }

  acquireSyncLease() {
    const token = randomUUID();
    const result = this.db.prepare(`INSERT INTO sync_lock VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET token=excluded.token, expires_at=excluded.expires_at
      WHERE sync_lock.expires_at < ?`).run(token, Date.now() + 120000, Date.now());
    if (!result.changes) throw new InputError("Another panel is already syncing this passport. Wait for it to finish.", 409);
    return {
      renew: () => {
        const renewed = this.db.prepare("UPDATE sync_lock SET expires_at=? WHERE id=1 AND token=? AND expires_at>=?")
          .run(Date.now() + 120000, token, Date.now());
        if (!renewed.changes) throw new InputError("The sync lock expired. Retry the operation; no force overwrite is performed.", 409);
      },
      release: () => { this.db.prepare("DELETE FROM sync_lock WHERE token=?").run(token); },
    };
  }

  cachedSearch(query) {
    const row = this.db.prepare("SELECT response FROM geocache WHERE query=? AND saved_at>?")
      .get(query, Date.now() - 7 * 86400000);
    return row ? JSON.parse(row.response) : null;
  }

  cacheSearch(query, response) {
    this.db.prepare("INSERT OR REPLACE INTO geocache VALUES (?, ?, ?)").run(query, JSON.stringify(response), Date.now());
    this.db.prepare("DELETE FROM geocache WHERE saved_at<?").run(Date.now() - 7 * 86400000);
  }

  reserveSearch() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT value FROM metadata WHERE key='lastSearch'").get();
      if (row && Date.now() - Number(row.value) < 1100) throw new InputError("Please wait a moment before searching again.", 429);
      this.db.prepare("INSERT OR REPLACE INTO metadata VALUES ('lastSearch', ?)").run(String(Date.now()));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { this.db.close(); }
}
