import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { createRuntime } from "./runtime.mjs";
import { collectorCanvas } from "./canvas.mjs";

const runtime = await createRuntime();
try {
  await joinSession({ canvases: [collectorCanvas({ createCanvas, CanvasError }, runtime)] });
} catch (error) {
  await runtime.dispose();
  throw error;
}
process.once("SIGTERM", async () => {
  await runtime.dispose();
  process.exit(0);
});
