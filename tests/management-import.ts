import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL!;
export async function runManagementImportTests(t: any, ctx: any) {
  const {
    call,
    cookie,
    root,
    rootCookie,
    admin,
    adminCookie,
    employee,
    employeeCookie,
    password,
  } = ctx;
  await t.test(
    "Миграция 010 очищает ранее удалённые аккаунты и сессии, освобождает логины без потери исторических ID",
    async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "ALTER TABLE users DROP CONSTRAINT users_credentials_lifecycle",
        );
        await c.query(
          "UPDATE users SET login='archived_'||id::text,password_hash='old-test-hash' WHERE deleted_at IS NOT NULL",
        );
        await c.query(
          "ALTER TABLE users ALTER COLUMN login SET NOT NULL; ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL",
        );
        const old = (
          await c.query(
            "INSERT INTO users(login,name,password_hash,role,active,deleted_at) VALUES('legacy_deleted_login','Прежний сотрудник','old-secret-hash','EMPLOYEE',false,now()) RETURNING id",
          )
        ).rows[0];
        await c.query(
          "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(repeat('a',64),$1,now()+interval '1 hour')",
          [old.id],
        );
        await c.query(
          "INSERT INTO import_jobs(actor_id,kind,payload) VALUES($1,'records','{}')",
          [old.id],
        );
        const activeBefore = (
          await c.query(
            "SELECT id,login,password_hash,role FROM users WHERE deleted_at IS NULL ORDER BY id",
          )
        ).rows;
        await c.query(
          await readFile(
            new URL(
              "../server/migrations/010-delete-user-credentials.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        const historical = (
          await c.query(
            "SELECT id,login,password_hash,active FROM users WHERE id=$1",
            [old.id],
          )
        ).rows[0];
        assert.deepEqual(historical, {
          id: old.id,
          login: null,
          password_hash: null,
          active: false,
        });
        assert.equal(
          (await c.query("SELECT 1 FROM sessions WHERE user_id=$1", [old.id]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await c.query("SELECT 1 FROM import_jobs WHERE actor_id=$1", [
              old.id,
            ])
          ).rowCount,
          0,
        );
        assert.deepEqual(
          (
            await c.query(
              "SELECT id,login,password_hash,role FROM users WHERE deleted_at IS NULL ORDER BY id",
            )
          ).rows,
          activeBefore,
        );
        const fresh = (
          await c.query(
            "INSERT INTO users(login,name,password_hash,role) VALUES('legacy_deleted_login','Новый сотрудник','new-test-hash','EMPLOYEE') RETURNING id",
          )
        ).rows[0];
        assert.notEqual(fresh.id, old.id);
        assert.equal(
          (await c.query("SELECT 1 FROM users WHERE id=$1", [old.id])).rowCount,
          1,
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );
  const workbook = async (headers: any[], rows: any[][]) => {
    const wb = new ExcelJS.Workbook(),
      sheet = wb.addWorksheet("Данные");
    sheet.addRow(headers);
    for (const row of rows) sheet.addRow(row);
    return Buffer.from(await wb.xlsx.writeBuffer());
  };
  const journalHeaders = [
    "Дата",
    "SUP",
    "Смесь",
    "T min",
    "T max",
    "T(fact)",
    "T(обор)",
    "Итог",
  ];
  const mixHeaders = ["Название смеси", "T min", "T max", "Статус"];
  const preview = async (kind: string, buffer: Buffer, actor = adminCookie) => {
    return fetch(base + "/" + kind + "/import/preview", {
      method: "POST",
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Cookie: actor,
      },
      body: buffer as any,
    });
  };
  const confirm = (kind: string, id: string, actor = adminCookie) =>
    call("/" + kind + "/import/confirm", "POST", { id }, actor);
  const dbRecord = async (sup: string) =>
    (await pool.query("SELECT * FROM measurements WHERE sup=$1", [sup]))
      .rows[0];
  let mixId = "",
    importId = "",
    oldId = "",
    otherId = "";
  await t.test(
    "EMPLOYEE: закрыты справочник, управление, импорт/экспорт и изменение даже собственных реквизитов",
    async () => {
      for (const route of [
        "/mixtures",
        "/users",
        "/records/export",
        "/mixtures/export",
      ])
        assert.equal(
          (await call(route, "GET", undefined, employeeCookie)).status,
          403,
        );
      for (const kind of ["mixtures", "records"]) {
        assert.equal(
          (await preview(kind, Buffer.from("bad"), employeeCookie)).status,
          403,
        );
        assert.equal(
          (await confirm(kind, root.id, employeeCookie)).status,
          403,
        );
      }
      const own = await call(
        "/records",
        "POST",
        {
          sup: "8000001",
          mixtureId: (
            await pool.query(
              "SELECT id FROM mixtures WHERE NOT archived LIMIT 1",
            )
          ).rows[0].id,
          actual: 40,
          equipment: 40,
        },
        employeeCookie,
      );
      assert.equal(own.status, 201);
      const row = await own.json();
      assert.equal(
        (
          await call(
            "/records/" + row.id,
            "PUT",
            { ...row, sup: "8000099" },
            employeeCookie,
          )
        ).status,
        403,
      );
      assert.equal((await dbRecord("8000001")).id, row.id);
      assert.equal(await dbRecord("8000099"), undefined);
      assert.equal(
        (
          await call(
            "/users/" + admin.id + "?version=" + admin.version,
            "DELETE",
            undefined,
            employeeCookie,
          )
        ).status,
        403,
      );
    },
  );
  await t.test(
    "Смеси: предпросмотр, подтверждение, upsert без дубликатов и экспорт .xlsx",
    async () => {
      let r = await preview(
        "mixtures",
        await workbook(mixHeaders, [
          ["Import A", 10, 50, "В работе"],
          ["Import B", 0, 100, "В работе"],
        ]),
        rootCookie,
      );
      assert.equal(r.status, 200);
      const p = await r.json();
      assert.equal(p.added, 2);
      assert.equal(p.errorCount, 0);
      assert.equal(
        (await pool.query("SELECT 1 FROM mixtures WHERE name='Import A'"))
          .rowCount,
        0,
      );
      assert.equal((await confirm("mixtures", p.id, rootCookie)).status, 200);
      assert.equal((await confirm("mixtures", p.id, rootCookie)).status, 409);
      mixId = (
        await pool.query("SELECT id FROM mixtures WHERE name='Import A'")
      ).rows[0].id;
      const saved = await call(
        "/records",
        "POST",
        { sup: "8100001", mixtureId: mixId, actual: 30, equipment: 30 },
        employeeCookie,
      );
      assert.equal(saved.status, 201);
      oldId = (await saved.json()).id;
      r = await preview(
        "mixtures",
        await workbook(mixHeaders, [[" import a ", 20, 60, "В работе"]]),
      );
      const update = await r.json();
      assert.equal(update.updated, 1);
      assert.equal((await confirm("mixtures", update.id)).status, 200);
      const mixes = (
        await pool.query("SELECT * FROM mixtures WHERE id=$1", [mixId])
      ).rows;
      assert.equal(mixes[0].id, mixId);
      assert.equal(mixes[0].t_min, 20);
      assert.equal((await dbRecord("8100001")).t_min, 10);
      assert.equal((await dbRecord("8100001")).status, "OK");
      const exported = await call(
        "/mixtures/export",
        "GET",
        undefined,
        adminCookie,
      );
      assert.equal(exported.status, 200);
      const bytes = Buffer.from(await exported.arrayBuffer()),
        wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes as any);
      assert.equal(wb.worksheets[0].getCell("A1").value, "Название смеси");
      r = await preview("mixtures", bytes);
      const roundtrip = await r.json();
      assert.equal(roundtrip.errorCount, 0);
      assert.equal(roundtrip.added, 0);
      assert.equal((await confirm("mixtures", roundtrip.id)).status, 200);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM mixtures WHERE lower(trim(name))='import a'",
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await t.test(
    "Смеси: ошибки строк и диапазонов блокируют всю загрузку; дубликаты названий отклоняются",
    async () => {
      const r = await preview(
        "mixtures",
        await workbook(mixHeaders, [
          ["Not inserted", 0, 40, "В работе"],
          ["Bad range", 80, 20, "В работе"],
          ["dup", 0, 10, ""],
          [" DUP ", 0, 10, ""],
        ]),
      );
      assert.equal(r.status, 200);
      const p = await r.json();
      assert.equal(p.total, 4);
      assert.equal(p.errorCount, 3);
      assert.equal(p.id, undefined);
      assert.deepEqual(
        p.errors.map((e: any) => e.row),
        [3, 4, 5],
      );
      assert.equal(
        (await pool.query("SELECT 1 FROM mixtures WHERE name='Not inserted'"))
          .rowCount,
        0,
      );
      assert.equal(
        (
          await call(
            "/mixtures",
            "POST",
            { name: "IMPORT A", tMin: 0, tMax: 1 },
            adminCookie,
          )
        ).status,
        409,
      );
    },
  );
  await t.test(
    "Журнал: новые и существующие SUP, неизменный ID, новые даты, обе температуры и пересчёт результата",
    async () => {
      const buf = await workbook(journalHeaders, [
        ["2026-10-01", "8100001", "import a", 10, 50, 30, 70, "OK"],
        ["02.10.2026", "8100002", "import a", 20, 60, 40, 40, "NOK"],
      ]);
      const r = await preview("records", buf);
      assert.equal(r.status, 200);
      const p = await r.json();
      assert.equal(p.errorCount, 0);
      assert.equal(p.added, 1);
      assert.equal(p.updated, 1);
      assert.deepEqual(
        p.rows.map((r: any) => r.status),
        ["NOK", "OK"],
      );
      assert.equal(await dbRecord("8100002"), undefined);
      assert.equal((await confirm("records", p.id, rootCookie)).status, 409); // actor-bound
      assert.equal((await confirm("records", p.id)).status, 200);
      const old = await dbRecord("8100001"),
        fresh = await dbRecord("8100002");
      assert.equal(old.id, oldId);
      assert.equal(old.status, "NOK");
      assert.equal(old.equipment, 70);
      assert.equal(
        (
          await pool.query(
            "SELECT to_char(date,'YYYY-MM-DD') AS date FROM measurements WHERE id=$1",
            [oldId],
          )
        ).rows[0].date,
        "2026-10-01",
      );
      assert.equal(fresh.status, "OK");
      assert.equal(fresh.created_by, admin.id);
      importId = fresh.id;
      assert.equal((await confirm("records", p.id)).status, 409);
    },
  );
  await t.test(
    "Без T(обор) импорт сохраняет прежнее значение; для новой записи остаётся нейтральный статус",
    async () => {
      const headers = journalHeaders.filter((h) => h !== "T(обор)");
      const r = await preview(
        "records",
        await workbook(headers, [
          ["2026-10-03", "8100002", "import a", 20, 60, 30, "NOK"],
          ["2026-10-03", "8100003", "Import B", 0, 100, 40, "OK"],
        ]),
      );
      const p = await r.json();
      assert.equal(p.errorCount, 0);
      assert.equal(p.rows[0].equipment, 40);
      assert.equal(p.rows[1].status, null);
      assert.equal((await confirm("records", p.id)).status, 200);
      assert.equal((await dbRecord("8100002")).id, importId);
      assert.equal((await dbRecord("8100002")).equipment, 40);
      assert.equal((await dbRecord("8100003")).status, null);
      otherId = (await dbRecord("8100003")).id;
    },
  );
  await t.test(
    "SUP + смесь: подробные ошибки несовпадения, отсутствующей смеси и повторов в Excel; никаких частичных изменений",
    async () => {
      const before = JSON.stringify(
        (await pool.query("SELECT * FROM measurements ORDER BY id")).rows,
      );
      const r = await preview(
        "records",
        await workbook(journalHeaders, [
          ["2026-10-01", "8100001", "Import B", 0, 100, 20, 30, "OK"],
          ["2026-10-01", "8100099", "Missing mix", 0, 100, 20, 30, "OK"],
          ["2026-10-01", "8100098", "Import B", 0, 100, 20, 30, "OK"],
          ["2026-10-01", "8100098", "Import B", 0, 100, 20, 30, "OK"],
          ["2026-10-01", "8100097", "Import B", 0, 100, 20, 30, "OK"],
        ]),
      );
      assert.equal(r.status, 200);
      const p = await r.json();
      assert.equal(p.errorCount, 4);
      assert.equal(p.id, undefined);
      assert.equal(p.added, 1);
      assert.equal(p.errors[0].row, 2);
      assert.equal(p.errors[0].sup, "8100001");
      assert.equal(p.errors[0].mixtureExcel, "Import B");
      assert.equal(p.errors[0].mixtureDb, "import a");
      assert.match(p.errors[0].message, /другая смесь/);
      assert.equal(p.errors[1].row, 3);
      assert.match(p.errors[1].message, /Missing mix/);
      assert.match(p.errors[2].message, /4, 5/);
      assert.match(p.errors[3].message, /4, 5/);
      assert.equal(
        JSON.stringify(
          (await pool.query("SELECT * FROM measurements ORDER BY id")).rows,
        ),
        before,
      );
    },
  );
  await t.test(
    "Форматы Excel: повреждённый файл, заголовки, даты, SUP, числа, формулы, диапазоны и пустой файл",
    async () => {
      assert.equal(
        (await preview("records", Buffer.from("invalid"))).status,
        400,
      );
      assert.equal(
        (await preview("records", await workbook(["SUP"], [["1234567"]])))
          .status,
        400,
      );
      assert.equal(
        (await preview("records", await workbook(journalHeaders, []))).status,
        400,
      );
      const r = await preview(
        "records",
        await workbook(journalHeaders, [
          ["31.02.2026", "8200001", "Import B", 0, 100, 10, 10, "OK"],
          ["2026-10-01", "123456", "Import B", 0, 100, 10, 10, "OK"],
          ["2026-10-01", "8200003", "Import B", 0, 100, "NaN", 10, "OK"],
          ["2026-10-01", "8200004", "Import B", 100, 0, 10, 10, "OK"],
          [
            "2026-10-01",
            "8200005",
            "Import B",
            0,
            100,
            { formula: "1+2", result: 3 },
            10,
            "OK",
          ],
        ]),
      );
      const p = await r.json();
      assert.equal(p.errorCount, 5);
      assert.equal(p.id, undefined);
      assert.deepEqual(
        p.errors.map((e: any) => e.row),
        [2, 3, 4, 5, 6],
      );
    },
  );
  await t.test(
    "Изменение после предпросмотра откатывает весь импорт; просроченный предпросмотр недоступен",
    async () => {
      const r = await preview(
        "records",
        await workbook(journalHeaders, [
          ["2026-10-01", "8100002", "import a", 20, 60, 35, 40, "OK"],
          ["2026-10-01", "8300001", "Import B", 0, 100, 10, 20, "OK"],
        ]),
      );
      const p = await r.json();
      assert.equal(p.errorCount, 0);
      await pool.query(
        "UPDATE measurements SET actual=31,version=version+1 WHERE id=$1",
        [importId],
      );
      assert.equal((await confirm("records", p.id)).status, 409);
      assert.equal((await dbRecord("8100002")).actual, 31);
      assert.equal(await dbRecord("8300001"), undefined);
      const expired = await (
        await preview(
          "mixtures",
          await workbook(mixHeaders, [["Expiring", 0, 100, "В работе"]]),
        )
      ).json();
      await pool.query(
        "UPDATE import_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",
        [expired.id],
      );
      assert.equal((await confirm("mixtures", expired.id)).status, 409);
      assert.equal(
        (await pool.query("SELECT 1 FROM mixtures WHERE name='Expiring'"))
          .rowCount,
        0,
      );
      assert.equal((await dbRecord("8100003")).id, otherId);
    },
  );
  await t.test(
    "Импорт сохраняет исходные неоднозначные пары старых температур без автоматического переноса",
    async () => {
      const legacyBefore = await dbRecord("0000003");
      const p = await (
        await preview(
          "records",
          await workbook(journalHeaders, [
            [
              "2026-11-08",
              "0000003",
              "Legacy mixture",
              20,
              80,
              null,
              null,
              "NOK",
            ],
          ]),
        )
      ).json();
      assert.equal(p.errorCount, 0);
      assert.equal((await confirm("records", p.id)).status, 200);
      const legacy = await dbRecord("0000003");
      assert.equal(legacy.actual_min, legacyBefore.actual_min);
      assert.equal(legacy.actual_max, legacyBefore.actual_max);
      assert.equal(legacy.legacy_pending, true);
      assert.equal(legacy.id, legacyBefore.id);
    },
  );
  await t.test(
    "Удаление аккаунтов: KEYUSER удаляет ADMIN; ADMIN удаляет EMPLOYEE; история и авторство сохранены",
    async () => {
      for (const role of ["ADMIN", "EMPLOYEE"]) {
        const actor = role === "ADMIN" ? rootCookie : adminCookie;
        const r = await call(
          "/users",
          "POST",
          {
            login: "remove_" + role.toLowerCase(),
            name: "Удаляемый " + role,
            password,
            role,
          },
          rootCookie,
        );
        assert.equal(r.status, 201);
        const u = await r.json();
        const session = await call("/auth/login", "POST", {
          login: u.login,
          password,
        });
        assert.equal(session.status, 200);
        const sessionCookie = cookie(session);
        await pool.query(
          "INSERT INTO import_jobs(actor_id,kind,payload) VALUES($1,'records','{}')",
          [u.id],
        );
        const created = await call(
          "/records",
          "POST",
          {
            sup: role === "ADMIN" ? "8400001" : "8400002",
            mixtureId: mixId,
            actual: 30,
            equipment: 30,
          },
          sessionCookie,
        );
        assert.equal(created.status, 201);
        const record = await created.json();
        if (role === "ADMIN")
          assert.equal(
            (
              await call(
                "/users/" + u.id + "?version=" + u.version,
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
              "/users/" + u.id + "?version=" + u.version,
              "DELETE",
              undefined,
              actor,
            )
          ).status,
          204,
        );
        assert.equal(
          (await call("/records", "GET", undefined, sessionCookie)).status,
          401,
        );
        assert.equal(
          (await call("/auth/login", "POST", { login: u.login, password }))
            .status,
          401,
        );
        const users = await (
          await call("/users", "GET", undefined, rootCookie)
        ).json();
        assert.ok(!users.some((r: any) => r.id === u.id));
        assert.equal((await dbRecord(record.sup)).created_by, u.id);
        const historical = (
          await pool.query("SELECT * FROM users WHERE id=$1", [u.id])
        ).rows[0];
        assert.equal(historical.login, null);
        assert.equal(historical.password_hash, null);
        assert.equal(
          (await pool.query("SELECT 1 FROM sessions WHERE user_id=$1", [u.id]))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query("SELECT 1 FROM import_jobs WHERE actor_id=$1", [
              u.id,
            ])
          ).rowCount,
          0,
        );
        const replacementResponse = await call(
          "/users",
          "POST",
          {
            login: u.login,
            name: "Новый сотрудник",
            password: "New-pass-44",
            role: "EMPLOYEE",
          },
          rootCookie,
        );
        assert.equal(replacementResponse.status, 201);
        const replacement = await replacementResponse.json();
        assert.notEqual(replacement.id, u.id);
        assert.equal(replacement.role, "EMPLOYEE");
        assert.equal(
          (await call("/auth/login", "POST", { login: u.login, password }))
            .status,
          401,
        );
        const freshLogin = await call("/auth/login", "POST", {
          login: u.login,
          password: "New-pass-44",
        });
        assert.equal(freshLogin.status, 200);
        assert.equal((await freshLogin.json()).id, replacement.id);
        assert.equal(
          (await call("/auth/me", "GET", undefined, sessionCookie)).status,
          401,
        );
        assert.equal((await dbRecord(record.sup)).created_by, u.id);
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM audit_log WHERE actor_id=$1 AND entity_id=$2",
              [u.id, record.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM audit_log WHERE actor_id=$1 AND entity_id=$2",
              [replacement.id, record.id],
            )
          ).rowCount,
          0,
        );
        const duplicate = await call(
          "/users",
          "POST",
          {
            login: u.login,
            name: "Дубликат",
            password: "4567",
            role: "EMPLOYEE",
          },
          rootCookie,
        );
        assert.equal(duplicate.status, 409);
        assert.match((await duplicate.json()).message, /логин/);
      }
      assert.equal(
        (
          await call(
            "/users/" + root.id + "?version=" + root.version,
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
            "/users/" + root.id + "?version=" + root.version,
            "DELETE",
            undefined,
            rootCookie,
          )
        ).status,
        403,
      );
      for (const changes of [{ role: "EMPLOYEE" }, { active: false }])
        assert.equal(
          (
            await call(
              "/users/" + root.id,
              "PUT",
              { ...root, ...changes },
              rootCookie,
            )
          ).status,
          409,
        );
    },
  );
  await t.test(
    "Критическая ошибка PostgreSQL откатывает все строки и аудит; повторные подтверждения не создают дубликаты",
    async () => {
      const bytes = await workbook(journalHeaders, [
        ["2026-10-01", "8500001", "Import B", 0, 100, 20, 30, "OK"],
        ["2026-10-01", "8500002", "Import B", 0, 100, 20, 30, "OK"],
      ]);
      const p = await (await preview("records", bytes)).json();
      await pool.query(
        "CREATE FUNCTION test_import_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sup='8500002' THEN RAISE EXCEPTION 'injected test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_import_failure BEFORE INSERT ON measurements FOR EACH ROW EXECUTE FUNCTION test_import_failure()",
      );
      try {
        assert.equal((await confirm("records", p.id)).status, 503);
        assert.equal(await dbRecord("8500001"), undefined);
        assert.equal(await dbRecord("8500002"), undefined);
        assert.equal(
          (await pool.query("SELECT 1 FROM audit_log WHERE sup='8500001'"))
            .rowCount,
          0,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT consumed_at FROM import_jobs WHERE id=$1",
              [p.id],
            )
          ).rows[0].consumed_at,
          null,
        );
      } finally {
        await pool.query(
          "DROP TRIGGER test_import_failure ON measurements; DROP FUNCTION test_import_failure()",
        );
      }
      const second = await (await preview("records", bytes)).json();
      const rs = await Promise.all([
        confirm("records", p.id),
        confirm("records", second.id),
      ]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM measurements WHERE sup IN ('8500001','8500002')",
          )
        ).rows[0].n,
        2,
      );
    },
  );
  await t.test(
    "Русские названия смесей: регистр и пробелы не создают дубликаты",
    async () => {
      const a = await call(
        "/mixtures",
        "POST",
        { name: "Смесь Импорт", tMin: 0, tMax: 100 },
        adminCookie,
      );
      assert.equal(a.status, 201);
      assert.equal(
        (
          await call(
            "/mixtures",
            "POST",
            { name: "  СМЕСЬ ИМПОРТ  ", tMin: 0, tMax: 100 },
            rootCookie,
          )
        ).status,
        409,
      );
      const b = await call(
        "/mixtures",
        "POST",
        { name: "Другая смесь", tMin: 0, tMax: 100 },
        rootCookie,
      );
      assert.equal(b.status, 201);
      const id = (await b.json()).id;
      assert.equal(
        (
          await call(
            "/mixtures/" + id,
            "PUT",
            { name: "смесь импорт", tMin: 0, tMax: 100 },
            adminCookie,
          )
        ).status,
        409,
      );
      const p = await (
        await preview(
          "mixtures",
          await workbook(mixHeaders, [["СМЕСЬ ИМПОРТ", 10, 80, "В работе"]]),
        )
      ).json();
      assert.equal(p.errorCount, 0);
      assert.equal(p.added, 0);
      assert.equal(p.updated, 1);
      assert.equal((await confirm("mixtures", p.id)).status, 200);
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM mixtures WHERE id=$1",
            [(await a.json()).id],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await t.test(
    "Аудит содержит SUP, исполнителя, старые/новые температуры и итог импорта без паролей",
    async () => {
      const audits = (await pool.query("SELECT * FROM audit_log ORDER BY id"))
        .rows;
      const imported = audits.find(
        (r: any) => r.sup === "8100001" && r.action === "import.row.update",
      );
      assert.equal(imported.actor_id, admin.id);
      assert.equal(imported.before_data.actual, 30);
      assert.equal(imported.after_data.equipment, 70);
      assert.ok(imported.created_at);
      const summary = audits.find(
        (r: any) =>
          r.action === "import.confirm" &&
          r.entity === "records" &&
          r.details.updated === 1 &&
          r.details.added === 1,
      );
      assert.ok(summary);
      const edits = audits.filter((r: any) => r.action === "record.update");
      assert.ok(edits.length);
      assert.ok(
        edits.some(
          (r: any) =>
            r.actor_id === root.id &&
            r.before_data.actual === 20 &&
            r.after_data.actual === 85,
        ),
      );
      const deleted = audits.find((r: any) => r.action === "user.delete");
      assert.ok(deleted);
      assert.equal(deleted.after_data.version, deleted.before_data.version + 1);
      assert.ok(deleted.after_data.deleted_at);
      assert.ok(!JSON.stringify(audits).includes("password_hash"));
      assert.ok(!JSON.stringify(audits).includes("scrypt$"));
    },
  );
}
