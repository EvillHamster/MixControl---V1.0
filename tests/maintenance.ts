import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { pool } from "../server/db.js";
export async function runMaintenanceTests(t: any, ctx: any) {
  const { call, adminCookie, rootCookie, employeeCookie, employee } = ctx;
  const post = async (path: string, body: any) => {
    const r = await call(path, "POST", body, adminCookie);
    assert.equal(r.status, 201, await r.clone().text());
    return r.json();
  };
  await t.test(
    "ADMIN повышает EMPLOYEE до ADMIN и затем теряет право изменять, блокировать и удалять этот аккаунт",
    async () => {
      const user = await post("/users", {
        login: "role_promote",
        name: "Promotion",
        password: "abcd",
        role: "EMPLOYEE",
      });
      const r = await call(
        "/users/" + user.id + "/role",
        "PUT",
        { role: "ADMIN", version: user.version },
        adminCookie,
      );
      assert.equal(r.status, 200);
      const promoted = await r.json();
      assert.equal(
        (
          await call(
            "/users/" + user.id,
            "PUT",
            { ...promoted, active: false },
            adminCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/users/" + user.id + "?version=" + promoted.version,
            "DELETE",
            undefined,
            adminCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/users/" + user.id + "/role",
            "PUT",
            { role: "EMPLOYEE", version: promoted.version },
            adminCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/users/" + user.id + "/role",
            "PUT",
            { role: "EMPLOYEE", version: promoted.version },
            rootCookie,
          )
        ).status,
        200,
      );
    },
  );
  await t.test(
    "Миграция 009 очищает старые отсоединённые комментарии с аудитом и сохраняет живые данные",
    async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const before = (
          await c.query("SELECT count(*)::int AS n FROM measurements")
        ).rows[0].n;
        await c.query(
          "ALTER TABLE correction_comments ALTER COLUMN correction_id DROP NOT NULL; DROP INDEX IF EXISTS measurements_cpk_order_idx",
        );
        await c.query(
          "INSERT INTO correction_comments(correction_id,original_correction_id,author_id,author_name,author_login,text) VALUES(NULL,gen_random_uuid(),$1,'old','old','detached')",
          [employee.id],
        );
        await c.query(
          await readFile(
            new URL(
              "../server/migrations/009-analytics-cleanup.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM correction_comments WHERE correction_id IS NULL",
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM audit_log WHERE action='correction.related_cleanup'",
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (await c.query("SELECT count(*)::int AS n FROM measurements")).rows[0]
            .n,
          before,
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );

  await t.test(
    "Cpk удалён: API отсутствует, миграция убирает только его индекс и сохраняет измерения, отчёты, корректировки и аккаунты",
    async () => {
      assert.equal(
        (
          await call(
            "/analytics/cpk?mode=overview",
            "GET",
            undefined,
            employeeCookie,
          )
        ).status,
        404,
      );
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const snapshot = async () => {
          const data: Record<string, unknown> = {};
          for (const table of [
            "measurements",
            "daily_reports",
            "corrective_actions",
            "correction_events",
            "users",
            "audit_log",
          ])
            data[table] = (
              await c.query(
                "SELECT * FROM " +
                  table +
                  " ORDER BY " +
                  (table === "daily_reports" ? "date" : "id"),
              )
            ).rows;
          return data;
        };
        const before = await snapshot();
        await c.query(
          "CREATE INDEX IF NOT EXISTS measurements_cpk_order_idx ON measurements(mixture_id,date,created_at,id)",
        );
        await c.query(
          await readFile(
            new URL("../server/migrations/011-remove-cpk.sql", import.meta.url),
            "utf8",
          ),
        );
        assert.equal(
          (
            await c.query(
              "SELECT to_regclass('measurements_cpk_order_idx') AS name",
            )
          ).rows[0].name,
          null,
        );
        assert.deepEqual(await snapshot(), before);
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );
}
