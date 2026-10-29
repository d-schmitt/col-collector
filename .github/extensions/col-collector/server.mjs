import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { InputError, text } from "./model.mjs";

const WEB = new URL("./web/", import.meta.url);
const MIME = { ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".svg": "image/svg+xml" };
const ASSETS = new Set(["app.js", "styles.css", "mountain.svg", "vendor/leaflet.js", "vendor/leaflet.css"]);
const MAX_BODY = 64 * 1024 * 1024;

async function readJson(request) {
  const type = request.headers["content-type"]?.split(";")[0];
  if (type !== "application/json") throw new InputError("Send JSON with Content-Type: application/json.", 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY) throw new InputError("The upload exceeds the 64 MB limit.", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new InputError("The uploaded JSON could not be read."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("A JSON object is required.");
  return value;
}

export function createGeocoder(store, { endpoint = process.env.COL_COLLECTOR_GEOCODER || "https://photon.komoot.io/api/", fetchImpl = fetch } = {}) {
  const base = new URL(endpoint);
  if (base.protocol !== "https:" || base.username || base.password) throw new Error("COL_COLLECTOR_GEOCODER must be an HTTPS Photon API URL without credentials.");
  return async (query) => {
    query = text(query, "Location", 160, true);
    const key = `${base.href}|${query.toLocaleLowerCase()}`;
    const cached = store.cachedSearch(key);
    if (cached) return cached;
    store.reserveSearch();
    const url = new URL(base);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "6");
    url.searchParams.set("lang", "en");
    let response, body;
    try {
      response = await fetchImpl(url, {
        signal: AbortSignal.timeout(10000),
        headers: { "User-Agent": "ColCollector/0.1 (personal Alpine cycling passport)", Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const raw = await response.text();
      if (raw.length > 1_000_000) throw new Error("Oversized geocoder response");
      body = JSON.parse(raw);
      if (!Array.isArray(body.features)) throw new Error("Invalid geocoder response");
    } catch (error) {
      throw new InputError(`Location search is unavailable (${error.message}). Try again later; you can still browse the map.`, 502);
    }
    const results = body.features.flatMap((feature) => {
      const [longitude, latitude] = feature.geometry?.coordinates ?? [];
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return [];
      const p = feature.properties ?? {};
      const label = [...new Set([p.name, p.city, p.state, p.country].filter((s) => typeof s === "string" && s))].join(", ").slice(0, 500);
      return label ? [{ label, latitude, longitude }] : [];
    }).slice(0, 6);
    store.cacheSearch(key, results);
    return results;
  };
}

export async function startServer({ store, catalogue, geocode = createGeocoder(store), sync, port = 0, onError = console.error }) {
  const token = randomBytes(24).toString("hex");
  const prefix = `/${token}/`;
  let origin;
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    // Cross-origin tiles receive only the origin, never the canvas capability path.
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'");
    const json = (value, status = 200) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin)) {
        throw new InputError("Request origin not allowed.", 403);
      }
      const url = new URL(request.url, origin);
      if (!url.pathname.startsWith(prefix)) throw new InputError("This canvas URL has expired or is invalid.", 404);
      const path = url.pathname.slice(prefix.length);
      if (request.method === "GET") {
        if (path === "api/state") return json(store.state());
        if (path === "api/sync/status") return json(sync.status());
        if (path === "api/sync/recovery") {
          const recovery = store.getMetadata("syncRecovery");
          if (!recovery) throw new InputError("There is no pre-pull recovery backup yet.", 404);
          response.setHeader("Content-Disposition", 'attachment; filename="col-collector-before-pull.json"');
          return json(recovery);
        }
        if (path === "api/catalogue") return json(catalogue);
        if (path === "api/search") return json(await geocode(url.searchParams.get("q") || ""));
        if (path === "api/backup") {
          const backup = store.export();
          if (backup.approaches.length > 10000 || backup.ascents.length > 10000 ||
              Buffer.byteLength(JSON.stringify(backup, null, 2)) > 60 * 1024 * 1024) {
            throw new InputError("This passport exceeds the JSON backup limit (60 MB or 10,000 approaches/ascents). Keep a filesystem backup of the passport database instead.", 413);
          }
          response.setHeader("Content-Disposition", 'attachment; filename="col-collector-backup.json"');
          return json(backup);
        }
        if (path.startsWith("api/photo/")) {
          const photo = store.photo(decodeURIComponent(path.slice("api/photo/".length)));
          response.writeHead(200, { "Content-Type": photo.mime });
          return response.end(photo.bytes);
        }
        let content, type;
        if (path === "") {
          content = await readFile(new URL("index.html", WEB));
          type = "text/html";
        } else if (path === "model.mjs") {
          content = await readFile(new URL("./model.mjs", import.meta.url));
          type = "text/javascript";
        } else if (ASSETS.has(path)) {
          try { content = await readFile(new URL(path, WEB)); }
          catch (error) {
            if (error.code === "ENOENT" && path.startsWith("vendor/")) throw new InputError("Map assets are missing. Run npm ci in the repository and reopen the canvas.", 503);
            throw error;
          }
          type = MIME[path.slice(path.lastIndexOf("."))] || "application/octet-stream";
        } else throw new InputError("Not found.", 404);
        response.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
        return response.end(content);
      }
      if (request.method !== "POST") throw new InputError("Method not allowed.", 405);
      const input = await readJson(request);
      let result;
      if (path === "api/approaches") throw new InputError("Approaches are now supplied by the catalogue. Reload the app and choose a preloaded approach.", 410);
      if (path === "api/ascents") result = store.saveAscent(input);
      else if (path === "api/ascents/delete") result = store.deleteAscent(input);
      else if (path === "api/restore") result = store.restore(input);
      else if (path === "api/sync/connect") result = { sync: await sync.connect(input.repository) };
      else if (path === "api/sync/push") result = await sync.push(input.revision);
      else if (path === "api/sync/pull") result = await sync.pull(input.revision, input.replaceLocal ?? false);
      else throw new InputError("Not found.", 404);
      json({ ...result, state: store.state() });
    } catch (error) {
      if (!(error instanceof InputError)) onError(error);
      if (!response.headersSent) json({ error: error instanceof InputError ? error.message : "The operation failed. Your saved passport has not been replaced. Check the extension log and try again." }, error instanceof InputError ? error.status : 500);
      else response.destroy();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}${prefix}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}
