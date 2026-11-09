import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { pool } from "../server/db.js";
import { runReportCycle } from "../server/reports.js";
export async function runWorkflowTests(t: any, ctx: any) {
  const { call, rootCookie, adminCookie, employeeCookie, admin, employee } =
    ctx;
  const get = async (path: string, actor = adminCookie) => {
    const r = await call(path, "GET", undefined, actor);
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const post = async (
    path: string,
    data: any,
    actor = adminCookie,
    code = 201,
  ) => {
    const r = await call(path, "POST", data, actor);
    assert.equal(r.status, code, await r.clone().text());
    return r.json();
  };
  let mix: any, record: any, task: any;
  const create = async (
    sup: string,
    actual: number | null,
    equipment: number | null,
    actor = employeeCookie,
  ) => post("/records", { sup, mixtureId: mix.id, actual, equipment }, actor);
  const dbRecord = async (sup: string) =>
    (await pool.query("SELECT * FROM measurements WHERE sup=$1", [sup]))
      .rows[0];
  const taskFor = async (sup: string) => {
    const list = await get("/corrections?search=" + sup);
    assert.equal(list.total, 1);
    return list.rows[0];
  };
  const detail = () => get("/corrections/" + task.id);
  const edit = async (data: any) => {
    const current = await dbRecord(record.sup);
    const r = await call(
      "/records/" + current.id,
      "PUT",
      {
        sup: current.sup,
        mixtureId: mix.id,
        actual: current.actual,
        equipment: current.equipment,
        version: current.version,
        ...data,
      },
      adminCookie,
    );
    assert.equal(r.status, 200, await r.clone().text());
    record = await r.json();
    return record;
  };
  const update = async (data: any, actor = adminCookie) => {
    const current = (await detail()).correction;
    const r = await call(
      "/corrections/" + task.id,
      "PUT",
      {
        status: current.status,
        responsibleId: current.responsibleId,
        workDone: current.workDone,
        version: current.version,
        ...data,
      },
      actor,
    );
    assert.equal(r.status, 200, await r.clone().text());
    return r.json();
  };
  const importRows = async (rows: any[][]) => {
    const wb = new ExcelJS.Workbook(),
      s = wb.addWorksheet("Журнал");
    s.addRow([
      "Дата",
      "SUP",
      "Смесь",
      "T min",
      "T max",
      "T(fact)",
      "T(обор)",
      "Итог",
    ]);
    for (const row of rows)
      s.addRow([row[0], row[1], row[2], 0, 100, row[3], row[4], ""]);
    const p = await fetch(
      process.env.TEST_API_URL + "/records/import/preview",
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          Cookie: adminCookie,
        },
        body: Buffer.from(await wb.xlsx.writeBuffer()) as any,
      },
    );
    assert.equal(p.status, 200, await p.clone().text());
    const preview = await p.json();
    assert.deepEqual(preview.errors, []);
    return post(
      "/records/import/confirm",
      { id: preview.id },
      adminCookie,
      200,
    );
  };
  const dates = (
    await pool.query(
      "SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date-2,'YYYY-MM-DD') AS report,to_char((now() AT TIME ZONE 'Europe/Moscow')::date-3,'YYYY-MM-DD') AS other,to_char((now() AT TIME ZONE 'Europe/Moscow')::date-4,'YYYY-MM-DD') AS many,to_char((now() AT TIME ZONE 'Europe/Moscow')::date,'YYYY-MM-DD') AS today",
    )
  ).rows[0];
  await t.test(
    "ΔT независимо от OK/NOK: ровно 3 °C (включая десятичные значения) не создаёт задачу; >3 создаёт одну",
    async () => {
      mix = {
        ...(await post("/mixtures", {
          name: "Workflow mixture",
          tMin: 0,
          tMax: 100,
        })),
        name: "Workflow mixture",
      };
      const exact = await create("8600001", 33.2, 30.2);
      assert.equal(exact.delta, 3);
      assert.equal(exact.status, "OK");
      assert.equal((await get("/corrections?search=8600001")).total, 0);
      record = await create("8600002", 45, 50);
      assert.equal(record.delta, 5);
      assert.equal(record.status, "OK");
      task = await taskFor(record.sup);
      assert.equal(task.status, "NOT_STARTED");
      assert.equal(task.delta, 5);
      const d = await detail();
      assert.equal(d.events[0].actorLogin, employee.login);
      assert.equal(d.events[0].kind, "detected");
      assert.equal(d.correction.initialData.delta, 5);
      const equipmentNok = await create("8600003", 99, 101);
      assert.equal(equipmentNok.status, "NOK");
      assert.equal(equipmentNok.delta, 2);
      assert.equal((await get("/corrections?search=8600003")).total, 0);
    },
  );
  await t.test(
    "Корректировки защищены на сервере; сотрудник не видит список, карточку, ответственных и экспорт",
    async () => {
      for (const p of [
        "/corrections",
        "/corrections/assignees",
        "/corrections/export",
        "/corrections/" + task.id,
      ])
        assert.equal(
          (await call(p, "GET", undefined, employeeCookie)).status,
          403,
        );
      assert.equal(
        (await call("/corrections/" + task.id, "PUT", {}, employeeCookie))
          .status,
        403,
      );
      assert.equal(
        (
          await call(
            "/corrections/" + task.id + "/comments",
            "POST",
            { text: "forbidden" },
            employeeCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (await call("/corrections/import/preview", "POST", {}, adminCookie))
          .status,
        404,
      );
      assert.ok(
        (await get("/corrections/assignees")).every(
          (u: any) => u.role !== "EMPLOYEE",
        ),
      );
    },
  );
  await t.test(
    "Статусы, ответственный, выполненная работа и история сохраняются; конкурентное редактирование защищено",
    async () => {
      const d = await update({
        status: "IN_PROGRESS",
        responsibleId: admin.id,
        workDone: "Проверена калибровка",
      });
      assert.equal(d.correction.responsibleId, admin.id);
      assert.equal(d.correction.workDone, "Проверена калибровка");
      const event = d.events.find((e: any) => e.kind === "updated");
      assert.equal(event.after.responsible_name, admin.name);
      assert.equal(event.before.status, "NOT_STARTED");
      const input = {
        status: "IN_PROGRESS",
        responsibleId: admin.id,
        version: d.correction.version,
      };
      const results = await Promise.all(
        ["первый", "второй"].map((workDone) =>
          call(
            "/corrections/" + task.id,
            "PUT",
            { ...input, workDone },
            adminCookie,
          ),
        ),
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      const bad = await call(
        "/corrections/" + task.id,
        "PUT",
        {
          ...input,
          version: (await detail()).correction.version,
          responsibleId: employee.id,
          workDone: "bad",
        },
        adminCookie,
      );
      assert.equal(bad.status, 400);
      assert.equal(
        (
          await call(
            "/corrections/" + task.id + "/comments",
            "POST",
            { text: " " },
            adminCookie,
          )
        ).status,
        410,
      );
    },
  );

  await t.test(
    "Старые комментарии сохранены в PostgreSQL; создание новых отключено, API карточки их не возвращает",
    async () => {
      for (let i = 0; i < 2; i++)
        await pool.query(
          "INSERT INTO correction_comments(correction_id,original_correction_id,author_id,author_name,author_login,text) VALUES($1,$1,$2,$3,$4,$5)",
          [
            task.id,
            admin.id,
            admin.name,
            admin.login,
            "Исторический комментарий " + i,
          ],
        );
      for (const actor of [adminCookie, rootCookie])
        assert.equal(
          (
            await call(
              "/corrections/" + task.id + "/comments",
              "POST",
              { text: "Новый" },
              actor,
            )
          ).status,
          410,
        );
      const d = await detail();
      assert.equal(d.comments, undefined);
      assert.equal(d.commentTotal, undefined);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM correction_comments"))
          .rows[0].n,
        2,
      );
    },
  );

  await t.test(
    "Исправление до ΔT ≤3 удаляет активные и архивные задачи; повторное превышение создаёт чистую новую задачу",
    async () => {
      for (const status of ["NOT_STARTED", "IN_PROGRESS", "DONE"]) {
        const saved = await update({
          status,
          workDone: "Старая работа",
          responsibleId: admin.id,
        });
        const oldId = task.id;
        assert.equal(
          (await get("/corrections?view=archive&search=" + record.sup)).total,
          status === "DONE" ? 1 : 0,
        );
        assert.equal(
          (await get("/corrections?search=" + record.sup)).total,
          status === "DONE" ? 0 : 1,
        );
        if (status === "DONE") {
          assert.ok(saved.correction.completedAt);
          const reopened = await update({ status: "IN_PROGRESS" });
          assert.equal(reopened.correction.completedAt, null);
          assert.equal(
            (await get("/corrections?search=" + record.sup)).total,
            1,
          );
          assert.ok(
            reopened.events.some(
              (e: any) => e.kind === "updated" && e.before.status === "DONE",
            ),
          );
          await update({ status: "DONE" });
        }
        await edit({ actual: 50, equipment: 50 });
        assert.equal(
          (await call("/corrections/" + oldId, "GET", undefined, adminCookie))
            .status,
          404,
        );
        assert.equal(
          (
            await call(
              "/corrections/" + oldId + "/history",
              "GET",
              undefined,
              rootCookie,
            )
          ).status,
          404,
        );
        assert.equal(
          (await get("/corrections?view=archive&search=" + record.sup)).total,
          0,
        );
        assert.equal((await get("/corrections?search=" + record.sup)).total, 0);
        assert.ok(await dbRecord(record.sup));
        const a = (
          await pool.query(
            "SELECT * FROM audit_log WHERE action='correction.auto_deleted' AND entity_id=$1",
            [oldId],
          )
        ).rows[0];
        assert.equal(a.details.measurementId, record.id);
        assert.equal(a.actor_login, admin.login);
        assert.equal(a.sup, record.sup);
        assert.equal(a.after_data.delta, 0);
        assert.equal(a.before_data.status, status);
        assert.equal(
          (
            await pool.query("SELECT 1 FROM corrective_actions WHERE id=$1", [
              oldId,
            ])
          ).rowCount,
          0,
        );
        await edit({ actual: 45, equipment: 50 });
        task = await taskFor(record.sup);
        assert.notEqual(task.id, oldId);
        assert.equal(task.status, "NOT_STARTED");
        assert.equal(task.workDone, "");
        assert.equal(task.responsibleId, null);
        assert.equal(task.initialData.delta, 5);
      }
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM correction_comments WHERE correction_id IS NULL",
          )
        ).rows[0].n,
        0,
      );
      await update({ status: "IN_PROGRESS" });
    },
  );
  await t.test(
    "Импорт обновляет температуры и историю существующей корректировки без сброса комментариев и статуса",
    async () => {
      await importRows([[dates.report, record.sup, mix.name, 45, 55]]);
      const d = await detail();
      assert.equal(d.correction.delta, 10);
      assert.equal(d.correction.date, dates.report);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM correction_comments"))
          .rows[0].n,
        0,
      );
      assert.equal(d.correction.status, "IN_PROGRESS");
      assert.equal(d.correction.initialData.delta, 5);
      assert.ok(
        d.events.some(
          (e: any) =>
            e.kind === "measurement_changed" &&
            e.after.actual === 45 &&
            e.after.equipment === 55 &&
            e.actorLogin === admin.login,
        ),
      );
    },
  );
  await t.test(
    "Серверный ежедневный отчёт: обе температуры, NOK%, только NOK, доступ всем ролям, повторный запуск без дублей",
    async () => {
      await importRows([
        [dates.report, "8610001", mix.name, 50, 51],
        [dates.report, "8610002", mix.name, 101, 99],
        [dates.report, "8610003", mix.name, 99, 101],
        [dates.report, "8610004", mix.name, null, null],
      ]);
      await runReportCycle();
      const db = (
        await pool.query("SELECT * FROM daily_reports WHERE date=$1", [
          dates.report,
        ])
      ).rows[0];
      assert.ok(db);
      assert.equal(db.total, 5);
      assert.equal(db.ok, 2);
      assert.equal(db.nok, 2);
      assert.equal(db.pending, 1);
      assert.equal(Number(db.nok_percent), 40);
      for (const actor of [employeeCookie, adminCookie, rootCookie]) {
        const r = await get("/reports?date=" + dates.report, actor);
        assert.equal(r.total, 5);
        assert.ok(r.dates.includes(dates.report));
        assert.equal(r.nokPercent, 40);
        assert.equal(r.rows.length, 2);
        assert.ok(
          r.rows
            .find((v: any) => v.sup === "8610003")
            .deviation.includes("T(обор) выше на 1"),
        );
      }
      await runReportCycle();
      const after = await get("/reports?date=" + dates.report);
      assert.equal(after.version, db.version);
      assert.equal(
        (
          await call(
            "/reports?date=" + dates.today,
            "GET",
            undefined,
            employeeCookie,
          )
        ).status,
        400,
      );
      const empty = await get("/reports?date=1999-01-01");
      assert.equal(empty.total, 0);
      assert.equal(empty.nokPercent, 0);
    },
  );
  await t.test(
    "Исправление, перенос даты и удаление измерений обновляют сохранённые отчёты и журнал аудита",
    async () => {
      const before = await get("/reports?date=" + dates.report);
      const r = await dbRecord("8610002");
      const edited = await call(
        "/records/" + r.id,
        "PUT",
        {
          sup: r.sup,
          mixtureId: mix.id,
          actual: 99,
          equipment: 99,
          version: r.version,
        },
        adminCookie,
      );
      assert.equal(edited.status, 200);
      let after = await get("/reports?date=" + dates.report);
      assert.equal(after.nok, 1);
      assert.equal(after.nokPercent, 20);
      assert.ok(after.version > before.version);
      await importRows([[dates.other, "8610003", mix.name, 99, 101]]);
      after = await get("/reports?date=" + dates.report);
      assert.equal(after.total, 4);
      assert.equal(after.nok, 0);
      const moved = await get("/reports?date=" + dates.other);
      assert.equal(moved.total, 1);
      assert.equal(moved.nok, 1);
      assert.equal(moved.nokPercent, 100);
      const source = await dbRecord("8610003");
      assert.equal(
        (
          await call(
            "/records/" + source.id + "?version=" + source.version,
            "DELETE",
            undefined,
            rootCookie,
          )
        ).status,
        204,
      );
      const emptyReport = await get("/reports?date=" + dates.other);
      assert.equal(emptyReport.total, 0);
      assert.ok(!emptyReport.dates.includes(dates.other));
      assert.ok(emptyReport.dates.includes(dates.report));
      assert.ok(
        (
          await pool.query(
            "SELECT 1 FROM audit_log WHERE entity_id=$1 AND action='report.updated'",
            [dates.report],
          )
        ).rowCount,
      );
    },
  );
  await t.test(
    "Пагинация корректировок по 15, экспорт всех строк фильтра (11 столбцов), NOK-отчёт с пагинацией",
    async () => {
      const rows = Array.from({ length: 17 }, (_, i) => [
        dates.many,
        String(8620000 + i),
        mix.name,
        105,
        95,
      ]);
      await importRows(rows);
      const first = await get("/corrections?search=86200");
      const second = await get("/corrections?search=86200&page=2");
      assert.equal(first.total, 17);
      assert.equal(first.rows.length, 15);
      assert.equal(second.rows.length, 2);
      assert.equal(
        (await get("/corrections?search=86200&status=DONE")).total,
        0,
      );
      assert.equal(
        (await get("/corrections?search=86200&responsibleId=none")).total,
        17,
      );
      const exported = await call(
        "/corrections/export?search=86200&page=2",
        "GET",
        undefined,
        rootCookie,
      );
      assert.equal(exported.status, 200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await exported.arrayBuffer()) as any);
      const sheet = wb.worksheets[0];
      assert.equal(sheet.columnCount, 11);
      assert.equal(sheet.rowCount, 18);
      assert.equal(sheet.getRow(2).getCell(7).text, "Не в работе");
      const report = await get("/reports?date=" + dates.many);
      assert.equal(report.nok, 17);
      assert.equal(report.rows.length, 15);
      assert.equal(
        (await get("/reports?date=" + dates.many + "&page=2")).rows.length,
        2,
      );
      assert.equal(report.nokPercent, 100);
    },
  );
  await t.test(
    "Занятый день не блокирует фоновый обработчик; после освобождения отчёт обновляется без потери изменений",
    async () => {
      const lock = await pool.connect();
      try {
        await lock.query("BEGIN");
        await lock.query(
          "SELECT pg_advisory_xact_lock(847207,($1::date-'2000-01-01'::date)::int)",
          [dates.many],
        );
        await pool.query(
          "INSERT INTO report_dirty_days(date) VALUES($1) ON CONFLICT DO NOTHING",
          [dates.many],
        );
        await runReportCycle();
        assert.equal(
          (
            await pool.query("SELECT 1 FROM report_dirty_days WHERE date=$1", [
              dates.many,
            ])
          ).rowCount,
          1,
        );
        await lock.query("COMMIT");
        await runReportCycle();
        assert.equal(
          (
            await pool.query("SELECT 1 FROM report_dirty_days WHERE date=$1", [
              dates.many,
            ])
          ).rowCount,
          0,
        );
        assert.equal((await get("/reports?date=" + dates.many)).nok, 17);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
      }
    },
  );
  await t.test(
    "Удаление исходной записи удаляет корректировку из обеих вкладок и сохраняет технический аудит",
    async () => {
      record = await dbRecord(record.sup);
      assert.equal(
        (
          await call(
            "/records/" + record.id + "?version=" + record.version,
            "DELETE",
            undefined,
            adminCookie,
          )
        ).status,
        204,
      );
      assert.equal(
        (await call("/corrections/" + task.id, "GET", undefined, adminCookie))
          .status,
        404,
      );
      for (const view of ["active", "archive"])
        assert.equal(
          (await get("/corrections?view=" + view + "&search=" + record.sup))
            .total,
          0,
        );
      const audited = (
        await pool.query(
          "SELECT * FROM audit_log WHERE action='correction.source_deleted' AND entity_id=$1",
          [task.id],
        )
      ).rows;
      assert.equal(audited.length, 1);
      assert.equal(audited[0].details.measurementId, record.id);
      assert.equal(
        (await pool.query("SELECT count(*)::int AS n FROM correction_comments"))
          .rows[0].n,
        0,
      );
    },
  );

  await t.test(
    "Удаление источника: все статусы, UUID, массовое удаление, откат и защита PostgreSQL",
    async () => {
      const ids = [];
      for (const [i, status] of [
        "NOT_STARTED",
        "IN_PROGRESS",
        "DONE",
      ].entries()) {
        const r = await create(String(8650000 + i), 50, 60);
        ids.push(r.id);
        const c = (
          await pool.query(
            "SELECT id FROM corrective_actions WHERE measurement_key=$1",
            [r.id],
          )
        ).rows[0];
        await pool.query(
          "UPDATE corrective_actions SET status=$2 WHERE id=$1",
          [c.id, status],
        );
      }
      const survivor = await create("8650003", 50, 60);
      const before = (await get("/corrections/summary")).active;
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("DELETE FROM measurements WHERE id=ANY($1::uuid[])", [
          ids,
        ]);
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM corrective_actions WHERE measurement_key=ANY($1::uuid[])",
              [ids],
            )
          ).rowCount,
          0,
        );
        await c.query("ROLLBACK");
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM corrective_actions WHERE measurement_key=ANY($1::uuid[])",
              [ids],
            )
          ).rowCount,
          3,
        );
        await c.query("DELETE FROM measurements WHERE id=ANY($1::uuid[])", [
          ids,
        ]);
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM corrective_actions WHERE measurement_key=$1",
              [survivor.id],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM audit_log WHERE action='correction.source_deleted' AND details->>'measurementId'=ANY($1::text[])",
              [ids],
            )
          ).rowCount,
          3,
        );
        assert.equal((await get("/corrections/summary")).active, before - 2);
        await assert.rejects(
          c.query(
            "INSERT INTO corrective_actions(measurement_key,date,sup,mixture_name,initial_data) VALUES(gen_random_uuid(),current_date,'8650099','same','{}')",
          ),
          (e: any) => e.code === "23503",
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );
  await t.test(
    "Миграция очищает старые активные и архивные корректировки без источника",
    async () => {
      const ids = [];
      for (let i = 0; i < 3; i++)
        ids.push((await create(String(8650010 + i), 50, 60)).id);
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(
          "DROP TRIGGER delete_measurement_correction ON measurements; DROP FUNCTION delete_measurement_correction(); ALTER TABLE corrective_actions DROP CONSTRAINT corrective_actions_source_fkey",
        );
        await c.query(
          "UPDATE corrective_actions SET status='DONE' WHERE measurement_key=$1",
          [ids[1]],
        );
        await c.query("DELETE FROM measurements WHERE id=ANY($1::uuid[])", [
          ids.slice(0, 2),
        ]);
        await c.query(
          await readFile(
            new URL(
              "../server/migrations/008-correction-source-delete.sql",
              import.meta.url,
            ),
            "utf8",
          ),
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM corrective_actions WHERE measurement_key=ANY($1::uuid[])",
              [ids.slice(0, 2)],
            )
          ).rowCount,
          0,
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM corrective_actions WHERE measurement_key=$1",
              [ids[2]],
            )
          ).rowCount,
          1,
        );
        assert.equal(
          (
            await c.query(
              "SELECT 1 FROM audit_log WHERE action='correction.orphan_deleted' AND details->>'measurementId'=ANY($1::text[])",
              [ids.slice(0, 2)],
            )
          ).rowCount,
          2,
        );
      } finally {
        await c.query("ROLLBACK");
        c.release();
      }
    },
  );
  await t.test(
    "Архив: серверные страницы по 15, фильтры, экспорт всех строк и точный счётчик активных задач",
    async () => {
      await importRows(
        Array.from({ length: 19 }, (_, i) => [
          dates.many,
          String(8630000 + i),
          mix.name,
          50,
          60,
        ]),
      );
      const sources = (
        await pool.query(
          "SELECT id FROM corrective_actions WHERE sup LIKE '86300%' ORDER BY sup",
        )
      ).rows;
      for (const source of sources.slice(0, 17)) {
        const current = (await get("/corrections/" + source.id)).correction;
        assert.equal(
          (
            await call(
              "/corrections/" + source.id,
              "PUT",
              {
                status: "DONE",
                responsibleId: admin.id,
                workDone: "Завершено",
                version: current.version,
              },
              rootCookie,
            )
          ).status,
          200,
        );
      }
      const active = await get("/corrections?search=86300"),
        archive = await get(
          "/corrections?view=archive&search=86300&responsibleId=" + admin.id,
        ),
        page2 = await get("/corrections?view=archive&search=86300&page=2");
      assert.equal(active.total, 2);
      assert.equal(archive.total, 17);
      assert.equal(archive.rows.length, 15);
      assert.equal(page2.rows.length, 2);
      assert.ok(
        archive.rows.every(
          (r: any) =>
            r.status === "DONE" && r.completedAt && r.workDone === "Завершено",
        ),
      );
      assert.equal(
        (
          await get(
            "/corrections?view=archive&search=86300&from=" + dates.today,
          )
        ).total,
        0,
      );
      const summary = await get("/corrections/summary");
      assert.equal(
        summary.active,
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM corrective_actions WHERE status<>'DONE'",
          )
        ).rows[0].n,
      );
      assert.equal(
        (await call("/corrections/summary", "GET", undefined, employeeCookie))
          .status,
        403,
      );
      assert.equal(
        (
          await call(
            "/corrections/" + sources[0].id + "/history",
            "GET",
            undefined,
            employeeCookie,
          )
        ).status,
        403,
      );
      for (const [view, count] of [
        ["active", 2],
        ["archive", 17],
      ] as const) {
        const r = await call(
          "/corrections/export?view=" + view + "&search=86300&page=2",
          "GET",
          undefined,
          adminCookie,
        );
        assert.equal(r.status, 200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await r.arrayBuffer()) as any);
        assert.equal(wb.worksheets[0].rowCount, count + 1);
        assert.equal(wb.worksheets[0].columnCount, 11);
      }
      const current = (await get("/corrections/" + sources[0].id)).correction;
      const reopened = await call(
        "/corrections/" + sources[0].id,
        "PUT",
        {
          status: "IN_PROGRESS",
          responsibleId: admin.id,
          workDone: current.workDone,
          version: current.version,
        },
        adminCookie,
      );
      assert.equal(reopened.status, 200);
      assert.equal(
        (await get("/corrections/summary")).active,
        summary.active + 1,
      );
      assert.equal((await get("/corrections?search=86300")).total, 3);
      assert.equal(
        (await get("/corrections?view=archive&search=86300")).total,
        16,
      );
    },
  );
  await t.test(
    "Исправление через импорт удаляет задачу; критическая ошибка откатывает и температуру, и удаление",
    async () => {
      const source = await dbRecord("8630001"),
        action = (await get("/corrections?view=archive&search=8630001"))
          .rows[0];
      await pool.query(
        "CREATE FUNCTION test_correction_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.sup='8630001' THEN RAISE EXCEPTION 'Injected correction rollback'; END IF; RETURN NULL; END $$",
      );
      await pool.query(
        "CREATE TRIGGER zzz_correction_rollback AFTER UPDATE ON measurements FOR EACH ROW EXECUTE FUNCTION test_correction_rollback()",
      );
      try {
        const r = await call(
          "/records/" + source.id,
          "PUT",
          {
            sup: source.sup,
            mixtureId: mix.id,
            actual: 55,
            equipment: 55,
            version: source.version,
          },
          adminCookie,
        );
        assert.equal(r.status, 503);
        assert.equal((await dbRecord(source.sup)).actual, 50);
        assert.equal(
          (await get("/corrections/" + action.id)).correction.status,
          "DONE",
        );
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM audit_log WHERE action='correction.auto_deleted' AND entity_id=$1",
              [action.id],
            )
          ).rowCount,
          0,
        );
      } finally {
        await pool.query(
          "DROP TRIGGER zzz_correction_rollback ON measurements",
        );
        await pool.query("DROP FUNCTION test_correction_rollback()");
      }
      await importRows([[dates.many, source.sup, mix.name, 55, 58]]);
      assert.equal(
        (await call("/corrections/" + action.id, "GET", undefined, adminCookie))
          .status,
        404,
      );
      assert.equal((await dbRecord(source.sup)).delta, 3);
      const audit = (
        await pool.query(
          "SELECT * FROM audit_log WHERE action='correction.auto_deleted' AND entity_id=$1",
          [action.id],
        )
      ).rows[0];
      assert.equal(audit.actor_login, admin.login);
      assert.equal(audit.after_data.delta, 3);
      assert.equal(audit.before_data.delta, 10);
      const other = (await get("/corrections?view=archive&search=8630002"))
        .rows[0];
      assert.ok(other);
    },
  );
  await t.test(
    "Удаление корректировки синхронизируется между двумя клиентами, счётчик сразу читает подтверждённое состояние",
    async () => {
      const abort = new AbortController(),
        readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
      const timer = setTimeout(() => abort.abort(), 10000);
      try {
        for (const actor of [adminCookie, rootCookie]) {
          const r = await fetch(process.env.TEST_API_URL + "/events", {
            headers: { Cookie: actor },
            signal: abort.signal,
          });
          assert.equal(r.status, 200);
          readers.push(r.body!.getReader());
        }
        const wait = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
          (async () => {
            let data = "";
            for (;;) {
              const chunk = await reader.read();
              if (chunk.done) throw new Error("SSE закрыт");
              data += new TextDecoder().decode(chunk.value);
              if (data.includes('data: "corrections"')) return;
            }
          })();
        const pending = readers.map(wait);
        pending.forEach((p) => void p.catch(() => {}));
        const before = await get("/corrections/summary"),
          source = await dbRecord("8630018");
        await importRows([[dates.many, source.sup, mix.name, 55, 55]]);
        await Promise.all(pending);
        assert.equal(
          (await get("/corrections/summary")).active,
          before.active - 1,
        );
      } finally {
        clearTimeout(timer);
        abort.abort();
        for (const reader of readers) await reader.cancel().catch(() => {});
      }
    },
  );

  await t.test(
    "Архив можно фильтровать по удалённому ответственному, но назначить его новой задаче нельзя",
    async () => {
      const person = await post(
        "/users",
        {
          login: "workflow_retired",
          name: "Исторический ответственный",
          password: "abcd",
          role: "ADMIN",
        },
        rootCookie,
      );
      const item = (await get("/corrections?view=archive&search=8630002"))
        .rows[0];
      let current = (await get("/corrections/" + item.id)).correction;
      assert.equal(
        (
          await call(
            "/corrections/" + item.id,
            "PUT",
            {
              status: "DONE",
              responsibleId: person.id,
              workDone: current.workDone,
              version: current.version,
            },
            rootCookie,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            "/users/" + person.id + "?version=" + person.version,
            "DELETE",
            undefined,
            rootCookie,
          )
        ).status,
        204,
      );
      const assignee = (await get("/corrections/assignees")).find(
        (p: any) => p.id === person.id,
      );
      assert.equal(assignee.assignable, false);
      assert.ok(assignee.name.includes("удалён"));
      assert.equal(
        (await get("/corrections?view=archive&responsibleId=" + person.id))
          .total,
        1,
      );
      const other = (await get("/corrections?view=archive&search=8630003"))
        .rows[0];
      current = (await get("/corrections/" + other.id)).correction;
      assert.equal(
        (
          await call(
            "/corrections/" + other.id,
            "PUT",
            {
              status: "DONE",
              responsibleId: person.id,
              workDone: current.workDone,
              version: current.version,
            },
            rootCookie,
          )
        ).status,
        400,
      );
    },
  );
  const bulkFilters = {
    from: "2020-01-05",
    to: "2020-01-05",
    mixtureId: mix.id,
    status: "OK",
    search: "8651",
  };
  const previewBulk = () =>
    get("/records/delete-preview?" + new URLSearchParams(bulkFilters));
  await t.test(
    "Удаление по фильтрам: доступ только ADMIN/KEYUSER, обязательные фильтры и предпросмотр всех страниц",
    async () => {
      await importRows([
        ...Array.from({ length: 20 }, (_, i) => [
          "2020-01-05",
          String(8651000 + i),
          mix.name,
          50,
          60,
        ]),
        ["2020-01-05", "8651020", mix.name, 200, 60],
        ["2020-01-06", "8651021", mix.name, 50, 60],
      ]);
      await pool.query(
        "UPDATE corrective_actions SET status='DONE' WHERE sup IN ('8651000','8651001')",
      );
      for (const roleCookie of [adminCookie, rootCookie])
        assert.equal(
          (
            await call(
              "/records/delete-preview?" + new URLSearchParams(bulkFilters),
              "GET",
              undefined,
              roleCookie,
            )
          ).status,
          200,
        );
      assert.equal(
        (
          await call(
            "/records/delete-preview?" + new URLSearchParams(bulkFilters),
            "GET",
            undefined,
            employeeCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters: bulkFilters, fingerprint: "0".repeat(32) },
            employeeCookie,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call("/records/by-filter", "DELETE", {
            filters: bulkFilters,
            fingerprint: "0".repeat(32),
          })
        ).status,
        401,
      );
      for (const query of [
        "",
        "search=%20%20",
        "from=2020-02-30",
        "from=2020-01-06&to=2020-01-05",
      ])
        assert.equal(
          (
            await call(
              "/records/delete-preview?" + query,
              "GET",
              undefined,
              adminCookie,
            )
          ).status,
          400,
        );
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters: {}, fingerprint: "0".repeat(32) },
            adminCookie,
          )
        ).status,
        400,
      );
      assert.equal((await previewBulk()).count, 20);
      assert.equal(
        (await get("/records?" + new URLSearchParams(bulkFilters))).records
          .length,
        15,
      );
      assert.equal(
        (await pool.query("SELECT 1 FROM measurements WHERE sup LIKE '8651%'"))
          .rowCount,
        22,
      );
    },
  );
  await t.test(
    "Предпросмотр удаления устаревает после редактирования или добавления коллегой; ошибка БД откатывает удаление и аудит",
    async () => {
      const first = await previewBulk();
      await importRows([["2020-01-05", "8651000", mix.name, 51, 60]]);
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters: bulkFilters, fingerprint: first.fingerprint },
            adminCookie,
          )
        ).status,
        409,
      );
      const second = await previewBulk();
      await importRows([["2020-01-05", "8651022", mix.name, 50, 60]]);
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters: bulkFilters, fingerprint: second.fingerprint },
            adminCookie,
          )
        ).status,
        409,
      );
      const fresh = await previewBulk();
      await pool.query(
        "CREATE FUNCTION test_bulk_rollback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.sup='8651005' THEN RAISE EXCEPTION 'Injected bulk rollback'; END IF; RETURN NULL; END $$; CREATE TRIGGER zzz_bulk_rollback AFTER DELETE ON measurements FOR EACH ROW EXECUTE FUNCTION test_bulk_rollback()",
      );
      try {
        assert.equal(
          (
            await call(
              "/records/by-filter",
              "DELETE",
              { filters: bulkFilters, fingerprint: fresh.fingerprint },
              adminCookie,
            )
          ).status,
          503,
        );
        assert.deepEqual(await previewBulk(), fresh);
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM corrective_actions WHERE sup LIKE '8651%'",
            )
          ).rowCount,
          23,
        );
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM audit_log WHERE action IN ('record.delete','correction.source_deleted') AND sup LIKE '8651%'",
            )
          ).rowCount,
          0,
        );
      } finally {
        await pool.query(
          "DROP TRIGGER zzz_bulk_rollback ON measurements; DROP FUNCTION test_bulk_rollback()",
        );
      }
    },
  );
  await t.test(
    "Массовое удаление по датам и остальным фильтрам: связанные активные/архивные задачи, аудит и счётчик; соседние записи сохранены",
    async () => {
      const before = (await get("/corrections/summary")).active;
      const preview = await previewBulk();
      assert.equal(preview.count, 21);
      const r = await call(
        "/records/by-filter",
        "DELETE",
        { filters: bulkFilters, fingerprint: preview.fingerprint },
        adminCookie,
      );
      assert.equal(r.status, 200, await r.clone().text());
      assert.equal((await r.json()).deleted, 21);
      assert.equal((await previewBulk()).count, 0);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM measurements WHERE sup IN ('8651020','8651021')",
          )
        ).rowCount,
        2,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM corrective_actions WHERE sup LIKE '8651%'",
          )
        ).rowCount,
        2,
      );
      assert.equal((await get("/corrections/summary")).active, before - 19);
      for (const action of ["record.delete", "correction.source_deleted"])
        assert.equal(
          (
            await pool.query(
              "SELECT 1 FROM audit_log WHERE action=$1 AND sup LIKE $2",
              [action, "8651%"],
            )
          ).rowCount,
          21,
        );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM audit_log WHERE action='record.bulk_delete' AND details->>'count'='21'",
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters: bulkFilters, fingerprint: preview.fingerprint },
            adminCookie,
          )
        ).status,
        409,
      );
      const filters = { search: "8651020" };
      const p = await get(
        "/records/delete-preview?" + new URLSearchParams(filters),
        rootCookie,
      );
      assert.equal(
        (
          await call(
            "/records/by-filter",
            "DELETE",
            { filters, fingerprint: p.fingerprint },
            rootCookie,
          )
        ).status,
        200,
      );
      assert.ok(await dbRecord("8651021"));
    },
  );
}
