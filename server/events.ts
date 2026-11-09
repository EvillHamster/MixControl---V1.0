import pg from "pg";
import type { RequestHandler, Response } from "express";
import { currentUser } from "./auth.js";
// One PostgreSQL LISTEN connection per Node process, not per connected employee.
let listener: pg.Client | null = null;
let stopped = false;
let retry: ReturnType<typeof setTimeout> | undefined;
const clients = new Map<Response, string>();
export async function startEvents() {
  if (stopped) return;
  const connection = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
  });
  listener = connection;
  const recover = () => {
    if (listener !== connection || stopped) return;
    listener = null;
    void connection.end().catch(() => {});
    if (!retry)
      retry = setTimeout(() => {
        retry = undefined;
        void startEvents();
      }, 3000);
  };
  connection.on("error", recover);
  connection.on("end", recover);
  connection.on("notification", (message) => {
    for (const res of clients.keys())
      res.write(`event: change\ndata: ${JSON.stringify(message.payload)}\n\n`);
  });
  try {
    await connection.connect();
    await connection.query("LISTEN mixcontrol_changes");
    for (const res of clients.keys())
      res.write('event: change\ndata: "reconnected"\n\n');
  } catch {
    recover();
  }
}
export const changeStream: RequestHandler = (req, res) => {
  const userId = currentUser(res).id;
  if ([...clients.values()].filter((id) => id === userId).length >= 5) {
    res.status(429).json({ message: "Открыто слишком много вкладок" });
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  clients.set(res, userId);
  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25000);
  const expiry = setTimeout(() => res.end(), 5 * 60 * 1000);
  req.on("close", () => {
    clients.delete(res);
    clearInterval(heartbeat);
    clearTimeout(expiry);
  });
};
export async function stopEvents() {
  stopped = true;
  if (retry) clearTimeout(retry);
  for (const res of clients.keys()) res.end();
  clients.clear();
  await listener?.end().catch(() => {});
}
