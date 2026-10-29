import { createRuntime } from "./runtime.mjs";

const runtime = await createRuntime();
const server = await runtime.open("preview", { port: Number(process.env.PORT || 0) });
console.log(`Col Collector: ${server.url}`);
const close = async () => { await runtime.dispose(); process.exit(0); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
