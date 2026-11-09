// Portable application-data snapshot. Sessions are intentionally not copied.
import "dotenv/config";
import pg from "pg";
import { readFile, writeFile } from "node:fs/promises";
const [mode, file] = process.argv.slice(2);
if (!["export", "restore"].includes(mode) || !file)
  throw new Error(
    "Использование: node scripts/database-snapshot.mjs export|restore файл.json",
  );
const tables = ["users", "mixtures", "measurements"];
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(
    mode === "export"
      ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
      : "BEGIN",
  );
  const schemaVersion = Number(
    (
      await client.query(
        "SELECT max(version) AS version FROM schema_migrations",
      )
    ).rows[0].version,
  );
  if (schemaVersion >= 5) tables.push("audit_log");
  if (schemaVersion >= 6)
    tables.push(
      "corrective_actions",
      "correction_events",
      "correction_comments",
      "daily_reports",
    );
  if (mode === "export") {
    const data = {
      format: "mixcontrol-data-v1",
      schemaVersion,
      exportedAt: new Date().toISOString(),
      tables: {},
    };
    for (const table of tables)
      data.tables[table] = (
        await client.query(
          `SELECT *${["measurements", "corrective_actions", "daily_reports"].includes(table) ? ",to_char(date,'YYYY-MM-DD') AS date" : ""} FROM ${table} t ORDER BY ${table === "daily_reports" ? "t.date" : "t.id"}`,
        )
      ).rows;
    // Refuse overwriting an existing backup.
    await writeFile(file, JSON.stringify(data, null, 2), { flag: "wx" });
    console.log("Резервная копия данных сохранена:", file);
  } else {
    const data = JSON.parse(await readFile(file, "utf8"));
    if (
      data.format !== "mixcontrol-data-v1" ||
      !(
        data.schemaVersion === schemaVersion ||
        ([4, 5, 6, 7, 8, 9, 10].includes(data.schemaVersion) &&
          schemaVersion >= data.schemaVersion &&
          schemaVersion <= 11)
      )
    )
      throw new Error(
        "Версия копии не соответствует схеме. Сначала выполните npm run db:migrate.",
      );
    if (schemaVersion >= 6) {
      await client.query(
        "SELECT set_config('mixcontrol.restoring','true',true)",
      );
      if (data.schemaVersion < 6)
        for (const name of [
          "corrective_actions",
          "correction_events",
          "correction_comments",
          "daily_reports",
        ])
          data.tables[name] = [];
    }
    // Old deleted identities must not restore credentials or reserve logins.
    if (schemaVersion >= 10) {
      for (const row of data.tables.users)
        if (row.deleted_at) {
          row.login = null;
          row.password_hash = null;
          row.active = false;
        }
    }
    // Older snapshots may contain tasks retained after source deletion.
    const removedCorrections = [];
    if (schemaVersion >= 8 && data.schemaVersion < 8) {
      const sources = new Set(data.tables.measurements.map((row) => row.id));
      data.tables.corrective_actions = data.tables.corrective_actions.filter(
        (row) => {
          if (sources.has(row.measurement_key)) return true;
          removedCorrections.push(row);
          return false;
        },
      );
      const removedIds = new Set(removedCorrections.map((row) => row.id));
      data.tables.correction_events = data.tables.correction_events.filter(
        (row) => !removedIds.has(row.correction_id),
      );
      for (const row of data.tables.correction_comments) {
        if (data.schemaVersion < 7)
          row.original_correction_id = row.correction_id;
        if (removedIds.has(row.correction_id)) row.correction_id = null;
      }
    }
    let removedCommentCount = 0;
    if (schemaVersion >= 9) {
      const ids = new Set(data.tables.corrective_actions.map((row) => row.id));
      data.tables.correction_comments = data.tables.correction_comments.filter(
        (row) => {
          if (ids.has(row.correction_id)) return true;
          removedCommentCount++;
          return false;
        },
      );
    }
    // Prevent concurrent app writes; restore only into an empty database.
    await client.query(
      "LOCK TABLE " + tables.join(",") + " IN ACCESS EXCLUSIVE MODE",
    );
    for (const table of tables)
      if ((await client.query(`SELECT 1 FROM ${table} LIMIT 1`)).rowCount)
        throw new Error(
          "Восстановление разрешено только в пустую базу. Существующие данные не изменены.",
        );
    await client.query(
      "ALTER TABLE measurements DROP CONSTRAINT measurements_sup_seven_digits",
    );
    for (const table of tables) {
      const columns = (
        await client.query(
          "SELECT column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position",
          [table],
        )
      ).rows;
      const jsonColumns = new Set(
        columns
          .filter((c) => ["json", "jsonb"].includes(c.data_type))
          .map((c) => c.column_name),
      );
      const columnNames = columns.map((c) => c.column_name);
      if (table === "audit_log" && data.schemaVersion === 4)
        data.tables.audit_log = [];
      if (!Array.isArray(data.tables[table]))
        throw new Error("Повреждена копия таблицы " + table);
      for (const row of data.tables[table]) {
        if (
          table === "correction_comments" &&
          data.schemaVersion < 7 &&
          !row.original_correction_id
        )
          row.original_correction_id = row.correction_id;
        await client.query(
          `INSERT INTO ${table}(${columnNames.map((c) => `"${c}"`).join(",")}) VALUES(${columnNames.map((_, i) => "$" + (i + 1)).join(",")})`,
          columnNames.map((c) =>
            row[c] == null
              ? null
              : jsonColumns.has(c)
                ? JSON.stringify(row[c])
                : row[c],
          ),
        );
      }
    }
    await client.query(
      "ALTER TABLE measurements ADD CONSTRAINT measurements_sup_seven_digits CHECK(sup ~ '^[0-9]{7}$') NOT VALID",
    );
    if (
      !(
        await client.query(
          "SELECT 1 FROM measurements WHERE sup !~ '^[0-9]{7}$' LIMIT 1",
        )
      ).rowCount
    )
      await client.query(
        "ALTER TABLE measurements VALIDATE CONSTRAINT measurements_sup_seven_digits",
      );
    if (schemaVersion >= 5)
      await client.query(
        "WITH promoted AS (UPDATE users SET role='KEYUSER',version=version+1 WHERE id=(SELECT id FROM users WHERE role='ADMIN' AND active AND deleted_at IS NULL ORDER BY created_at,id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM users WHERE role='KEYUSER') RETURNING id,login) INSERT INTO audit_log(actor_login,action,entity,entity_id,after_data,details) SELECT 'system','security.bootstrap_keyuser','users',id::text,jsonb_build_object('id',id,'login',login,'role','KEYUSER'),jsonb_build_object('reason','Restore legacy snapshot') FROM promoted",
      );
    if (schemaVersion >= 5)
      await client.query(
        "SELECT setval(pg_get_serial_sequence('audit_log','id'),COALESCE((SELECT max(id) FROM audit_log),0)+1,false)",
      );
    if (schemaVersion >= 6) {
      if (data.schemaVersion < 6)
        await client.query(
          "SELECT sync_measurement_correction(m) FROM measurements m",
        );
      await client.query(
        "INSERT INTO report_dirty_days(date) SELECT DISTINCT date FROM measurements ON CONFLICT DO NOTHING",
      );
      for (const table of ["audit_log", "correction_events"])
        await client.query(
          "SELECT setval(pg_get_serial_sequence($1,'id'),COALESCE((SELECT max(id) FROM " +
            table +
            "),0)+1,false)",
          [table],
        );
    }
    for (const row of removedCorrections)
      await client.query(
        "INSERT INTO audit_log(actor_login,action,entity,entity_id,sup,before_data,details) VALUES('system','correction.orphan_deleted','corrective_actions',$1,$2,$3,$4)",
        [
          row.id,
          row.sup,
          JSON.stringify(row),
          JSON.stringify({
            reason: "Source measurement absent in restored snapshot",
            measurementId: row.measurement_key,
            correctionId: row.id,
          }),
        ],
      );
    if (removedCommentCount)
      await client.query(
        "INSERT INTO audit_log(actor_login,action,entity,details) VALUES('system','correction.related_cleanup','correction_comments',$1)",
        [
          JSON.stringify({
            reason: "Deleted corrective action in legacy snapshot",
            count: removedCommentCount,
          }),
        ],
      );
    console.log("Данные восстановлены. Войдите с прежним логином и паролем.");
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  await client.end();
}
