import { completedPassIds, filterPasses } from "./model.mjs";

export function collectorCanvas({ createCanvas, CanvasError }, runtime) {
  const inputSchema = { type: "object", properties: {}, additionalProperties: false };
  return createCanvas({
    id: "col-collector",
    displayName: "Col Collector",
    description: "Explore paved Alpine passes, collect completed climbs, and keep a private ascent journal.",
    inputSchema,
    open: async ({ instanceId }) => {
      const server = await runtime.open(instanceId);
      return { title: "Col Collector", url: server.url };
    },
    onClose: ({ instanceId }) => runtime.close(instanceId),
    actions: [
      {
        name: "get_progress",
        description: "Read completion counts without revealing personal notes or photos.",
        inputSchema,
        handler: () => {
          const state = runtime.store.state();
          const completed = completedPassIds(state.approaches, state.ascents);
          return { totalPasses: runtime.catalogue.passes.length, completedPasses: completed.size, recordedAscents: state.ascents.length };
        },
      },
      {
        name: "find_passes",
        description: "Find catalogue passes by name, with completion status.",
        inputSchema: {
          type: "object", required: ["query"], additionalProperties: false,
          properties: { query: { type: "string", minLength: 1, maxLength: 160 } },
        },
        handler: ({ input }) => {
          if (!input?.query?.trim()) throw new CanvasError("invalid_query", "Enter a pass name.");
          const state = runtime.store.state();
          const done = completedPassIds(state.approaches, state.ascents);
          return filterPasses(runtime.catalogue.passes, done, { query: input.query })
            .slice(0, 20).map((p) => ({ id: p.id, name: p.displayName || p.name, elevation: p.elevation, completed: done.has(p.id) }));
        },
      },
    ],
  });
}
