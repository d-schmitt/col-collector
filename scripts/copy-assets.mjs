import { cp, mkdir } from "node:fs/promises";

const target = new URL("../.github/extensions/col-collector/web/vendor/", import.meta.url);
await mkdir(target, { recursive: true });
for (const name of ["leaflet.js", "leaflet.css"]) {
  await cp(new URL(`../node_modules/leaflet/dist/${name}`, import.meta.url), new URL(name, target));
}
await cp(new URL("../node_modules/leaflet/LICENSE", import.meta.url), new URL("LEAFLET-LICENSE", target));
