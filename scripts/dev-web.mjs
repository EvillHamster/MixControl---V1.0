import "dotenv/config";
import { createServer } from "vite";
// Expose the browser only after the real API (and its migrations) is ready.
const host =
  process.env.HOST === "0.0.0.0"
    ? "127.0.0.1"
    : (process.env.HOST ?? "127.0.0.1");
const api = `http://${host}:${process.env.PORT ?? 3001}/api/health`;
const deadline = Date.now() + 30000;
let ready = false;
while (Date.now() < deadline) {
  try {
    ready = (await fetch(api, { signal: AbortSignal.timeout(1000) })).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
  console.error(
    "API не запустился за 30 секунд. Проверьте сообщения [api] выше.",
  );
  process.exitCode = 1;
} else {
  const server = await createServer({
    server: {
      host: "127.0.0.1",
      port: Number(process.env.DEV_WEB_PORT ?? 5173),
      strictPort: true,
    },
  });
  await server.listen();
  server.printUrls();
}
