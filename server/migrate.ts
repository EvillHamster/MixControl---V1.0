import { readFile } from "node:fs/promises";
import { pool } from "./db.js";
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(847201)");
    await c.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    await c.query(
      "INSERT INTO schema_migrations(version) VALUES(1) ON CONFLICT DO NOTHING",
    );
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=2"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/002-auth.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(2)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=3"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/003-single-temperature.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(3)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=4"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/004-equipment-keyuser.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(4)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=5"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL(
            "./migrations/005-management-import-audit.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(5)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=6"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/006-reports-corrections.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(6)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=7"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/007-correction-lifecycle.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(7)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=8"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL(
            "./migrations/008-correction-source-delete.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(8)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=9"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/009-analytics-cleanup.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(9)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=10"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL(
            "./migrations/010-delete-user-credentials.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(10)");
    }
    if (
      !(await c.query("SELECT 1 FROM schema_migrations WHERE version=11"))
        .rowCount
    ) {
      await c.query(
        await readFile(
          new URL("./migrations/011-remove-cpk.sql", import.meta.url),
          "utf8",
        ),
      );
      await c.query("INSERT INTO schema_migrations(version) VALUES(11)");
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
if (process.argv[1]?.endsWith("migrate.ts")) {
  migrate()
    .then(() => console.log("Схема базы данных обновлена"))
    .finally(() => pool.end());
}
