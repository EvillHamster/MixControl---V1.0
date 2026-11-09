import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function startLocalPostgres() {
  const databaseDir = path.resolve(".postgres");
  // The Windows tools use the OS code page for filesystem paths. Use a SQL_ASCII
  // maintenance cluster for Cyrillic paths; application data uses a UTF8 database.
  const pg = new EmbeddedPostgres({
    databaseDir,
    user: "mixcontrol",
    password: "mixcontrol",
    port: 5432,
    persistent: true,
    authMethod: "scram-sha-256",
    initdbFlags: [
      `--encoding=${process.platform === "win32" ? "SQL_ASCII" : "UTF8"}`,
      "--locale=C",
    ],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: (message) => {
      if (/ready to accept|shut down|FATAL|PANIC|ERROR/.test(String(message)))
        console.log(String(message).trim());
    },
  });
  if (!existsSync(path.join(databaseDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  try {
    const { rows } = await client.query(
      "SELECT 1 FROM pg_database WHERE datname='mixcontrol'",
    );
    if (!rows.length)
      await client.query(
        "CREATE DATABASE mixcontrol TEMPLATE template0 ENCODING 'UTF8'",
      );
  } finally {
    await client.end();
  }
  console.log(
    "PostgreSQL запущен: 127.0.0.1:5432 / mixcontrol. Данные: " + databaseDir,
  );
  return { stop: () => pg.stop(), databaseDir };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const local = await startLocalPostgres();
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    try {
      await local.stop();
      process.exit(0);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  setInterval(() => {}, 60000);
}
