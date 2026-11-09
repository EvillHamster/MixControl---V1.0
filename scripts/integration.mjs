import "dotenv/config";
import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
// A real, isolated PostgreSQL database: the working database is never mutated.
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
const database = "mixcontrol_test_" + randomBytes(8).toString("hex");
let server;
await control.connect();
try {
  await control.query(
    `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`,
  );
  const url = new URL(process.env.DATABASE_URL);
  url.pathname = "/" + database;
  const fixture = new pg.Client({ connectionString: url.toString() });
  await fixture.connect();
  try {
    await fixture.query(
      await readFile(new URL("../server/schema.sql", import.meta.url), "utf8"),
    );
    const mixture = (
      await fixture.query(
        "INSERT INTO mixtures(name,t_min,t_max) VALUES('Legacy mixture',20,80) RETURNING id",
      )
    ).rows[0];
    await fixture.query(
      "INSERT INTO measurements(date,sup,mixture_id,mixture_name,t_min,t_max,actual_min,actual_max) VALUES('2026-11-08','0000001',$1,'Legacy mixture',20,80,30,70),('2026-11-08','LEGACY-X',$1,'Legacy mixture',20,80,10,90),('2026-11-08','0000002',$1,'Legacy mixture',20,80,40,40),('2026-11-08','0000003',$1,'Legacy mixture',20,80,NULL,50),('2026-11-08','0000004',$1,'Legacy mixture',20,80,NULL,NULL)",
      [mixture.id],
    );
  } finally {
    await fixture.end();
  }
  const port = await new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close(() => resolve(address.port));
    });
  });
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    PORT: String(port),
    HOST: "127.0.0.1",
    COOKIE_SECURE: "false",
    TEST_API_URL: `http://127.0.0.1:${port}/api`,
  };
  let log = "";
  server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (data) => {
    log += data;
  });
  server.stderr.on("data", (data) => {
    log += data;
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) break;
    try {
      ready = (
        await fetch(env.TEST_API_URL + "/health", {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error("Тестовый API не запустился: " + log);
  const status = await new Promise((resolve, reject) => {
    const tests = spawn(
      process.execPath,
      ["--import", "tsx", "--test", "tests/integration.test.ts"],
      { env, windowsHide: true, stdio: "inherit" },
    );
    tests.on("error", reject);
    tests.on("exit", (code) => resolve(code ?? 1));
  });
  process.exitCode = status;
} finally {
  if (server && server.exitCode === null) {
    const ended = new Promise((resolve) => server.once("exit", resolve));
    server.kill("SIGTERM");
    await ended;
  }
  await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await control.end();
}
