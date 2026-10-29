import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Store, defaultDataPath } from "./store.mjs";
import { createGeocoder, startServer } from "./server.mjs";

export async function createRuntime({ dataPath = process.env.COL_COLLECTOR_DATA_PATH || defaultDataPath() } = {}) {
  if (!isAbsolute(dataPath)) throw new Error("COL_COLLECTOR_DATA_PATH must be an absolute path outside the repository.");
  const catalogue = JSON.parse(await readFile(new URL("./data/catalogue.json", import.meta.url), "utf8"));
  const approaches = JSON.parse(await readFile(new URL("./data/approaches.json", import.meta.url), "utf8"));
  const store = await Store.open(dataPath, catalogue, approaches);
  const servers = new Map();
  let geocode;
  try { geocode = createGeocoder(store); }
  catch (error) { store.close(); throw error; }
  return {
    store,
    catalogue,
    async open(instanceId, options = {}) {
      let pending = servers.get(instanceId);
      if (!pending) {
        pending = startServer({ store, catalogue, geocode, ...options });
        servers.set(instanceId, pending);
        try { await pending; } catch (error) { servers.delete(instanceId); throw error; }
      }
      return pending;
    },
    async close(instanceId) {
      const pending = servers.get(instanceId);
      if (pending) {
        servers.delete(instanceId);
        await (await pending).close();
      }
    },
    async dispose() {
      await Promise.all([...servers.keys()].map((key) => this.close(key)));
      store.close();
    },
  };
}
