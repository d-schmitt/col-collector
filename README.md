# col-collector

A personal cycling passport to the Alps, built as a **Copilot canvas extension**.
Find paved passes on a map, collect the ones you have ridden, and keep a private
ascent journal. The same interface can also run in a local browser.

## What it does

- **437 mapped passes:** 86 in the original "Paved passes +2000" layer and 351 in
  "Paved passes -2000", with location search, map browsing, and shared
  elevation/completion/name filters.
- **A collectible passport:** unfinished passes are grayscale; completed passes
  become colorful. Your own summit photo appears on the card when available.
- **Approach-level tracking:** riding any one approach collects the pass, without
  marking its other approaches complete. Repeat ascents are separate records.
- **An optional date, photo and note** for each ascent, with editing and deletion.
- **Private local storage, backups and restoration**, with stale-write protection
  when several panels or sessions share the passport.

## Run locally

Requires **Node.js 22.16+** (including `node:sqlite`) and npm. Node 24 LTS is also
suitable. Python 3 is only needed to refresh or test the catalogue importer.

```sh
npm ci
npm start
```

Open the loopback URL printed by the server. It includes a randomly generated
access token; do not share that URL. The process binds only to `127.0.0.1`.
Use Ctrl+C to stop the standalone server. No build step or external account is
required. `npm ci` copies Leaflet's assets and license into the extension's
ignored `web/vendor/` directory.

## Open in Copilot

The project-scoped extension lives at
`.github/extensions/col-collector/extension.mjs`.

1. Run `npm ci` in this checkout.
2. Reload extensions if your Copilot runtime exposes that action, or start a new
   Copilot session **in this checkout** so the project extension is discovered.
3. Ask Copilot to **open the Col Collector canvas**.

The canvas type is `col-collector`, under provider `project:col-collector`.
The runtime supplies `@github/copilot-sdk`; do not install a separate SDK copy.
The host must support extension canvases and a JavaScript runtime with
`node:sqlite`. The extension uses the installed SDK's `createCanvas` / `joinSession`
API and exposes read-only `get_progress` and `find_passes` actions. All editing
controls live inside the canvas.

Closing a panel stops its local HTTP server, not the passport. Reopening the
canvas, using another instance ID, or switching worktrees loads the same private
records. The development browser preview uses exactly the same application and
storage.

**Activation caveat:** the authoring session did not expose extension scaffold,
reload, or inspection tools. The declaration was checked against the installed
SDK and the application/lifecycle exercised locally, but live host registration
must be checked after discovery in a new or reloaded session.

## Data sources and coverage

The catalogue is a factual snapshot of the two selected paved-pass layers from
[this Google My Maps list](https://www.google.com/maps/d/viewer?mid=1GPHWvjnIKIObSl2m5ykGzmm-BJd5aXWU),
attributed by its creator to [cycloclimbing.com](https://cycloclimbing.com).
No gravel, valley, mountainside, or other layers are imported.
Original membership determines the groups; summit elevation is **not** climbing
elevation gain.

The snapshot records source URLs, import time, counts, and validation warnings.
Two CentCols references are shared by differently named, differently located
points. They remain distinct mapped passes; reference codes alone are not used
as identifiers. IDs derive from the source name and coordinates, not list order.
Renaming or moving a source entry changes its generated ID, so catalogue refreshes
must be reviewed before replacing a version used by existing passports.

**Approach coverage is deliberately explicit:** five approaches for Stelvio and
Galibier have names and metrics checked against
[quäldich](https://www.quaeldich.de/paesse/) on 29 October 2026. Other passes show
that approach data is unverified and let you add a starting place/side and an
optional source link. Even a verified list is not claimed to be exhaustive.
There is no bulk scraper, copied article text, or third-party photo collection.
Summit elevations remain those of the selected map, even where another source
uses a different figure. Source rights remain with their respective owners.

To refresh the snapshot deliberately:

```sh
npm run catalogue:import
# Or use a previously downloaded KML:
python3 scripts/import_catalogue.py --input /path/to/source.kml
```

The importer rejects missing layers, invalid coordinates, and duplicate
identities rather than silently dropping records. Missing numerical elevations
and layer-boundary exceptions are reported in `catalogue.json`.

## Privacy, persistence and recovery

By default, the SQLite database is stored at:

```text
$COPILOT_HOME/extensions/col-collector/artifacts/passport.sqlite
```

`COPILOT_HOME` defaults to `~/.copilot`. Records and photos are **never written
into the repository**. The parent directory is created privately and the database
file is owner-readable/writable. SQLite transactions and revision checks prevent
partial restores and silent concurrent overwrites. This is local storage, not
encryption; someone with access to your operating-system account can read it.

- Use **Passport tools → Download backup** for a JSON archive, including photos.
- **Restore backup** replaces the current passport after confirmation and full
  validation. Download the existing passport first.
- JSON backups/restores support up to **60 MB** and 10,000 approaches/ascents.
  Oversized exports fail explicitly, rather than producing an unrestorable file.
  For larger passports, stop all collector instances and back up the SQLite
  database and any accompanying `-wal`/`-shm` files together.
- Uploaded photos are resized to a maximum 1,600-pixel edge and re-encoded as
  JPEG, removing original metadata. The upload accepts JPEG/PNG/WebP up to 20 MB.
  Restored backup photos are validated but not re-encoded.
- Optional dates are kept as calendar dates; leaving one blank does not invent a
  ride date.

No analytics, login, cloud sync, Strava/Garmin connection, or location permission
is used. Online requests are limited to:

| Service | What is sent | Usage |
|---|---|---|
| [Photon](https://github.com/komoot/photon) | A location search you submit | Six results maximum, cached for seven days, at most one uncached request per 1.1 seconds per passport. No autocomplete or background searches. |
| [OpenStreetMap tiles](https://operations.osmfoundation.org/policies/tiles/) | Tiles for the map area being viewed, with an origin-only referrer | Browser caching and visible attribution; no offline tile downloads or bulk prefetching. |

These public services are best-effort and intended here for modest personal
use. Location search or maps can fail independently without losing saved rides.
The collection and journal remain usable offline while the local server runs.
Verify road conditions, seasonal closures, surfaces and cycling restrictions
before riding; this app is not a navigation or road-safety service.

Environment overrides:

| Variable | Purpose |
|---|---|
| `COL_COLLECTOR_DATA_PATH` | Absolute SQLite path for a separate passport or disposable development data |
| `COL_COLLECTOR_GEOCODER` | HTTPS URL of a Photon-compatible endpoint, for a self-hosted or alternative deployment |
| `PORT` | Standalone preview port; default `0` chooses an available port |

## Development

The frontend is vanilla HTML/CSS/ES modules plus Leaflet. The extension entry point
only wires the canvas; `runtime.mjs`, `server.mjs`, and `store.mjs` own lifecycle,
HTTP, and persistence. The browser and canvas use the same local API. Personal
photos and notes are not exposed through the agent-facing canvas actions.

```sh
npm test
python3 -m unittest discover -s tests -p '*_test.py'
npx playwright install chromium
npm run test:browser
```

Tests use disposable databases, never the default personal passport. Browser
tests stub external map tiles and location results; they cover both viewport
sizes, filtering, custom approaches, repeat ascents, optional dates, photo
editing, backup/restore, deletion, and stale-write recovery.
