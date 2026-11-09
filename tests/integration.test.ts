import { runMaintenanceTests } from "./maintenance.js";
import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import ExcelJS from "exceljs";
import { runWorkflowTests } from "./workflow.js";
import { runManagementImportTests } from "./management-import.js";
import { pool } from "../server/db.js";
const base = process.env.TEST_API_URL!;
if (
  !base ||
  !new URL(process.env.DATABASE_URL!).pathname.startsWith("/mixcontrol_test_")
)
  throw new Error(
    "Запускайте проверки через npm run test:integration в изолированной базе",
  );
const call = (route: string, method = "GET", body?: unknown, cookie = "") =>
  fetch(base + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const cookie = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
const password = "abcd";
test("Роли, миграция, совместная работа и сохранение функциональности", async (t) => {
  let adminCookie = "",
    employeeCookie = "",
    secondCookie = "",
    mixtureId = "";
  let admin: any, employee: any, second: any, record: any, root: any;
  let rootCookie = "";
  let nextSup = 1000000;
  const input = (overrides: Record<string, unknown> = {}) => ({
    date: "1900-01-01",
    sup: String(nextSup++),
    mixtureId,
    actual: 20,
    equipment: 40,
    ...overrides,
  });
  try {
    await t.test("Без сессии данные недоступны", async () => {
      assert.equal((await call("/records")).status, 401);
      assert.equal((await call("/mixtures")).status, 401);
      assert.equal((await call("/records", "POST", input())).status, 401);
      assert.equal(
        (await (await call("/auth/status")).json()).needsSetup,
        true,
      );
    });
    await t.test(
      "Первый администратор создаётся ровно один раз при гонке запросов",
      async () => {
        const results = await Promise.all(
          ["adminone", "admintwo"].map((login) =>
            call("/auth/setup", "POST", { login, name: login, password }),
          ),
        );
        assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
        const r = results.find((r) => r.status === 201)!;
        admin = await r.json();
        adminCookie = cookie(r);
        assert.equal(admin.role, "KEYUSER");
        assert.equal(admin.password_hash, undefined);
        assert.match(r.headers.get("set-cookie")!, /HttpOnly/);
        assert.match(r.headers.get("set-cookie")!, /SameSite=Strict/);
        const saved = (
          await pool.query("SELECT password_hash FROM users WHERE id=$1", [
            admin.id,
          ])
        ).rows[0];
        assert.match(saved.password_hash, /^scrypt\$/);
        assert.notEqual(saved.password_hash, password);
        const session = (
          await pool.query("SELECT token_hash FROM sessions WHERE user_id=$1", [
            admin.id,
          ])
        ).rows[0];
        assert.notEqual(session.token_hash, adminCookie.split("=")[1]);
        root = admin;
        rootCookie = adminCookie;
        const createdAdmin = await call(
          "/users",
          "POST",
          {
            login: "actualadmin",
            name: "Administrator",
            role: "ADMIN",
            password,
          },
          rootCookie,
        );
        assert.equal(createdAdmin.status, 201);
        admin = await createdAdmin.json();
        adminCookie = cookie(
          await call("/auth/login", "POST", { login: admin.login, password }),
        );
      },
    );
    await t.test(
      "Миграция сохраняет старые записи, нормативы и результаты без переписывания SUP",
      async () => {
        const rows = (
          await pool.query(
            "SELECT sup,t_min,t_max,status,created_by,actual,equipment,actual_min,actual_max,legacy_pending FROM measurements ORDER BY sup",
          )
        ).rows;
        assert.equal(rows.length, 5);
        const equal = rows.find((r: any) => r.sup === "0000002");
        const partial = rows.find((r: any) => r.sup === "0000003");
        const empty = rows.find((r: any) => r.sup === "0000004");
        assert.equal(equal.actual, 40);
        assert.equal(equal.status, null);
        assert.equal(equal.equipment, null);
        assert.equal(equal.legacy_pending, false);
        assert.equal(partial.actual, null);
        assert.equal(partial.actual_max, 50);
        assert.equal(partial.legacy_pending, true);
        assert.equal(partial.status, null);
        assert.equal(empty.legacy_pending, false);
        assert.equal(empty.status, null);
        rows.splice(1, 3);
        assert.equal(rows[0].sup, "0000001");
        assert.equal(rows[0].status, "OK");
        assert.equal(rows[0].created_by, root.id);
        assert.equal(rows[1].sup, "LEGACY-X");
        assert.equal(rows[1].status, "NOK");
        assert.equal(rows[1].created_by, null);
        assert.equal(rows[0].actual, null);
        assert.equal(rows[0].legacy_pending, true);
        assert.equal(rows[0].actual_min, 30);
        assert.equal(rows[0].actual_max, 70);
        assert.equal(rows[1].actual_min, 10);
        assert.equal(rows[1].actual_max, 90);
      },
    );
    await t.test(
      "Администратор создаёт сотрудников, логины уникальны",
      async () => {
        for (const login of ["employeeone", "employeetwo"]) {
          const r = await call(
            "/users",
            "POST",
            { login, name: login, password, role: "EMPLOYEE" },
            adminCookie,
          );
          assert.equal(r.status, 201);
          const u = await r.json();
          const session = await call("/auth/login", "POST", {
            login,
            password,
          });
          assert.equal(session.status, 200);
          if (login === "employeeone") {
            employee = u;
            employeeCookie = cookie(session);
          } else {
            second = u;
            secondCookie = cookie(session);
          }
        }
        assert.equal(
          (
            await call(
              "/users",
              "POST",
              {
                login: employee.login.toUpperCase(),
                name: "duplicate",
                password,
                role: "EMPLOYEE",
              },
              adminCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call("/auth/login", "POST", {
              login: employee.login,
              password: "wrong-password",
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "Управление справочником и пользователями закрыто для сотрудника",
      async () => {
        for (const route of ["/users", "/mixtures"])
          assert.equal(
            (
              await call(
                route,
                "POST",
                {
                  name: "forbidden",
                  tMin: 0,
                  tMax: 10,
                  login: "forbidden",
                  password,
                  role: "ADMIN",
                },
                employeeCookie,
              )
            ).status,
            403,
          );
        assert.equal(
          (await call("/users", "GET", undefined, employeeCookie)).status,
          403,
        );
        assert.equal(
          (
            await call(
              "/mixtures",
              "POST",
              { name: "test", tMin: 90, tMax: 20 },
              adminCookie,
            )
          ).status,
          400,
        );
        const r = await call(
          "/mixtures",
          "POST",
          { name: "Test mixture", tMin: 20, tMax: 80 },
          adminCookie,
        );
        assert.equal(r.status, 201);
        mixtureId = (await r.json()).id;
        assert.equal(
          (
            await call(
              "/mixtures/" + mixtureId,
              "PUT",
              { name: "hack", tMin: 0, tMax: 100 },
              employeeCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "/mixtures/" + mixtureId,
              "DELETE",
              undefined,
              employeeCookie,
            )
          ).status,
          403,
        );
        const list = await (
          await call("/mixtures/options", "GET", undefined, employeeCookie)
        ).json();
        const mix = list.find((m: any) => m.id === mixtureId);
        assert.equal(mix.tMin, null);
        assert.equal(mix.tMax, null);
      },
    );
    await t.test(
      "Автор назначается сервером; подмена нормативов и авторства игнорируется",
      async () => {
        const r = await call(
          "/records",
          "POST",
          input({ sup: "0000077", createdBy: admin.id, tMin: 0, tMax: 999 }),
          employeeCookie,
        );
        assert.equal(r.status, 201);
        record = await r.json();
        assert.equal(record.createdBy, employee.id);
        assert.equal(record.tMin, 20);
        assert.equal(record.tMax, 80);
        assert.equal(record.status, "OK");
        assert.equal(record.sup, "0000077");
        assert.equal(
          record.date,
          new Intl.DateTimeFormat("en-CA", {
            timeZone: "Europe/Moscow",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date()),
        );
        assert.equal(record.actual, 20);
      },
    );
    await t.test(
      "KEYUSER имеет полный доступ; ADMIN не управляет руководителями, единственный KEYUSER защищён",
      async () => {
        for (const actor of [adminCookie, rootCookie]) {
          assert.equal(
            (
              await call(
                "/users",
                "POST",
                {
                  login: "keyextra" + (actor === rootCookie ? "root" : "admin"),
                  name: "Extra",
                  password,
                  role: "KEYUSER",
                },
                actor,
              )
            ).status,
            actor === rootCookie ? 409 : 403,
          );
        }
        assert.equal(
          (
            await call(
              "/users/" + root.id,
              "PUT",
              { ...root, name: "Hack" },
              adminCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "/users/" + admin.id,
              "PUT",
              { ...admin, name: "Hack" },
              adminCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "/users/" + second.id + "/role",
              "PUT",
              { role: "KEYUSER", version: second.version },
              rootCookie,
            )
          ).status,
          409,
        );
        await assert.rejects(
          pool.query("UPDATE users SET role='KEYUSER' WHERE id=$1", [
            second.id,
          ]),
          (e: any) =>
            e.code === "23505" && e.constraint === "users_single_keyuser",
        );
        const promoted = await call(
          "/users/" + second.id + "/role",
          "PUT",
          { role: "ADMIN", version: second.version },
          rootCookie,
        );
        assert.equal(promoted.status, 200);
        second = await promoted.json();
        assert.equal(
          (await call("/records", "GET", undefined, secondCookie)).status,
          401,
        );
        const demoted = await call(
          "/users/" + second.id + "/role",
          "PUT",
          { role: "EMPLOYEE", version: second.version },
          rootCookie,
        );
        assert.equal(demoted.status, 200);
        second = await demoted.json();
        secondCookie = cookie(
          await call("/auth/login", "POST", { login: second.login, password }),
        );
        const updated = await call(
          "/records/" + record.id,
          "PUT",
          { ...record, actual: 85, equipment: 40 },
          rootCookie,
        );
        assert.equal(updated.status, 200);
        record = await updated.json();
        assert.equal(record.status, "NOK");
        const reset = await call(
          "/records/" + record.id,
          "PUT",
          { ...record, actual: 20, equipment: 40 },
          adminCookie,
        );
        assert.equal(reset.status, 200);
        record = await reset.json();
        for (const actor of [adminCookie, rootCookie, employeeCookie])
          assert.equal(
            (await call("/records", "POST", input(), actor)).status,
            201,
          );
        assert.equal(
          (
            await call(
              "/users",
              "POST",
              {
                login: "shortpassword",
                name: "Short",
                password: "abc",
                role: "EMPLOYEE",
              },
              rootCookie,
            )
          ).status,
          400,
        );
      },
    );
    await t.test(
      "SUP должен состоять ровно из 7 цифр на API и в PostgreSQL",
      async () => {
        for (const sup of [
          "123456",
          "12345678",
          "123A567",
          " 1234567",
          1234567,
        ])
          assert.equal(
            (await call("/records", "POST", input({ sup }), employeeCookie))
              .status,
            400,
          );
        assert.equal(
          (
            await (
              await call(
                "/records/check-sup?sup=0000077",
                "GET",
                undefined,
                secondCookie,
              )
            ).json()
          ).available,
          false,
        );
        await assert.rejects(
          () =>
            pool.query("UPDATE measurements SET sup='ABC1234' WHERE id=$1", [
              record.id,
            ]),
          (e: any) => e.code === "23514",
        );
      },
    );
    await t.test(
      "Перенос старой пары требует явного значения и сохраняет исходные данные",
      async () => {
        const list = await (
          await call("/records?search=0000001", "GET", undefined, adminCookie)
        ).json();
        let old = list.records[0];
        assert.equal(old.legacyPending, true);
        const metadata = await call(
          "/records/" + old.id,
          "PUT",
          old,
          adminCookie,
        );
        assert.equal(metadata.status, 200);
        old = await metadata.json();
        assert.equal(old.legacyPending, true);
        assert.equal(old.status, "OK");
        const transferred = await call(
          "/records/" + old.id,
          "PUT",
          { ...old, actual: 90 },
          adminCookie,
        );
        assert.equal(transferred.status, 200);
        old = await transferred.json();
        assert.equal(old.actual, 90);
        assert.equal(old.status, "NOK");
        assert.equal(old.legacyPending, false);
        assert.equal(old.actualMin, 30);
        assert.equal(old.actualMax, 70);
        const exportResponse = await call(
          "/records/export?search=0000001",
          "GET",
          undefined,
          adminCookie,
        );
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(
          Buffer.from(await exportResponse.arrayBuffer()) as any,
        );
        assert.equal(workbook.worksheets[0].columnCount, 8);
        assert.equal(
          workbook.getWorksheet("Исходные измерения")!.getCell("B2").value,
          30,
        );
        assert.equal(
          workbook.getWorksheet("Исходные измерения")!.getCell("C2").value,
          70,
        );
      },
    );
    await t.test(
      "Глобальная уникальность SUP выдерживает одновременное сохранение сотрудниками",
      async () => {
        const same = input();
        const rs = await Promise.all([
          call("/records", "POST", same, employeeCookie),
          call("/records", "POST", same, secondCookie),
        ]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409]);
        await assert.rejects(
          () =>
            pool.query("UPDATE measurements SET sup=$1 WHERE id=$2", [
              same.sup,
              record.id,
            ]),
          (e: any) => e.code === "23505",
        );
      },
    );
    await t.test(
      "Сотрудник видит общий журнал, но не изменяет чужие записи и не удаляет свои",
      async () => {
        const list = await (
          await call("/records", "GET", undefined, secondCookie)
        ).json();
        assert.ok(list.records.some((r: any) => r.id === record.id));
        assert.equal(
          (
            await call(
              "/records/" + record.id,
              "PUT",
              { ...record, actual: 60 },
              secondCookie,
            )
          ).status,
          403,
        );
        assert.equal(
          (
            await call(
              "/records/" + record.id + "?version=1",
              "DELETE",
              undefined,
              employeeCookie,
            )
          ).status,
          403,
        );
        const own = await call(
          "/records/" + record.id,
          "PUT",
          { ...record, actual: 85 },
          employeeCookie,
        );
        assert.equal(own.status, 403);
        const adminEdit = await call(
          "/records/" + record.id,
          "PUT",
          { ...record, actual: 80 },
          adminCookie,
        );
        assert.equal(adminEdit.status, 200);
        record = await adminEdit.json();
        assert.equal(record.createdBy, employee.id);
        assert.equal(record.status, "OK");
      },
    );
    await t.test(
      "Исторические нормы не меняются при обновлении смеси и фактических значений",
      async () => {
        assert.equal(
          (
            await call(
              "/mixtures/" + mixtureId,
              "PUT",
              { name: "Renamed", tMin: 30, tMax: 60 },
              adminCookie,
            )
          ).status,
          200,
        );
        const r = await call(
          "/records/" + record.id,
          "PUT",
          record,
          adminCookie,
        );
        assert.equal(r.status, 200);
        record = await r.json();
        assert.equal(record.tMin, 20);
        assert.equal(record.tMax, 80);
        assert.equal(record.mixtureName, "Test mixture");
        assert.equal(record.status, "OK");
        const fresh = await (
          await call("/records", "POST", input(), secondCookie)
        ).json();
        assert.equal(fresh.tMin, 30);
        assert.equal(fresh.status, "NOK");
      },
    );
    await t.test(
      "Гонка редактирования администратором не приводит к потере изменений",
      async () => {
        const rs = await Promise.all([
          call(
            "/records/" + record.id,
            "PUT",
            { ...record, actual: 70 },
            adminCookie,
          ),
          call(
            "/records/" + record.id,
            "PUT",
            { ...record, actual: 75 },
            adminCookie,
          ),
        ]);
        assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
        record = await rs.find((r) => r.status === 200)!.json();
      },
    );
    await t.test(
      "OK/NOK и незавершённые замеры рассчитываются PostgreSQL",
      async () => {
        for (const [actual, status] of [
          [30, "OK"],
          [60, "OK"],
          [29, "NOK"],
          [61, "NOK"],
          [null, null],
        ] as const) {
          const r = await call(
            "/records",
            "POST",
            input({ actual, equipment: 40 }),
            employeeCookie,
          );
          assert.equal(r.status, 201);
          assert.equal((await r.json()).status, status);
        }
        await assert.rejects(
          () =>
            pool.query("UPDATE mixtures SET t_min=999 WHERE id=$1", [
              mixtureId,
            ]),
          (e: any) => e.code === "23514",
        );
      },
    );
    await t.test(
      "T(обор): сохранение, запрет сотруднику, общий NOK и сортировка",
      async () => {
        for (const [actual, equipment, status] of [
          [40, 61, "NOK"],
          [29, 40, "NOK"],
          [30, 60, "OK"],
          [null, 61, "NOK"],
          [29, null, "NOK"],
          [40, null, null],
          [null, 40, null],
        ] as const) {
          const response = await call(
            "/records",
            "POST",
            input({ actual, equipment }),
            adminCookie,
          );
          assert.equal(response.status, 201);
          const row = await response.json();
          assert.equal(row.status, status);
          assert.equal(row.equipment, equipment);
        }
        assert.equal(
          (
            await call(
              "/records/" + record.id,
              "PUT",
              { ...record, equipment: 99 },
              employeeCookie,
            )
          ).status,
          403,
        );
        const updated = await call(
          "/records/" + record.id,
          "PUT",
          { ...record, equipment: 90 },
          adminCookie,
        );
        assert.equal(updated.status, 200);
        record = await updated.json();
        assert.equal(record.status, "NOK");
        assert.equal(
          (
            await call(
              "/records",
              "POST",
              input({ equipment: -274 }),
              adminCookie,
            )
          ).status,
          400,
        );
        await assert.rejects(
          pool.query("UPDATE measurements SET equipment=10001 WHERE id=$1", [
            record.id,
          ]),
          (e: any) => e.code === "23514",
        );
        const sorted = await (
          await call(
            "/records?sort=equipment&direction=desc",
            "GET",
            undefined,
            adminCookie,
          )
        ).json();
        assert.equal(sorted.records[0].equipment, 90);
      },
    );
    await t.test(
      "Сервер выдаёт максимум 15 строк; фильтры, сортировка и страницы согласованы",
      async () => {
        for (let i = 0; i < 17; i++)
          assert.equal(
            (
              await call(
                "/records",
                "POST",
                input({ actual: 40 }),
                secondCookie,
              )
            ).status,
            201,
          );
        const route =
          "/records?mixtureId=" + mixtureId + "&sort=sup&direction=asc";
        const a = await (
          await call(route, "GET", undefined, employeeCookie)
        ).json();
        const b = await (
          await call(route + "&page=2", "GET", undefined, employeeCookie)
        ).json();
        assert.equal(a.size, 15);
        assert.equal(a.records.length, 15);
        assert.ok(
          !b.records.some((r: any) =>
            a.records.some((v: any) => v.id === r.id),
          ),
        );
        assert.equal(a.total, b.total);
        assert.equal(a.total, a.ok + a.nok + a.pending);
        assert.equal(
          (await call(route + "&size=16", "GET", undefined, adminCookie))
            .status,
          400,
        );
        const pending = await (
          await call(
            route + "&status=pending",
            "GET",
            undefined,
            employeeCookie,
          )
        ).json();
        assert.equal(pending.total, 3);
        const date = await (
          await call(
            route + "&from=2026-11-10",
            "GET",
            undefined,
            employeeCookie,
          )
        ).json();
        assert.equal(date.total, 0);
      },
    );
    await t.test(
      "Уведомления об изменениях доступны двум сессиям общей базы",
      async () => {
        const abort = new AbortController();
        const streams = await Promise.all(
          [employeeCookie, secondCookie].map((Cookie) =>
            fetch(base + "/events", {
              headers: { Cookie },
              signal: abort.signal,
            }),
          ),
        );
        const readers = streams.map((s) => s.body!.getReader());
        for (const reader of readers) await reader.read();
        const receive = async (
          reader: ReadableStreamDefaultReader<Uint8Array>,
        ) => {
          let text = "";
          while (!text.includes("event: change")) {
            const part = await reader.read();
            if (part.done) throw new Error("Stream closed");
            text += new TextDecoder().decode(part.value);
          }
          return text;
        };
        try {
          const waiting = readers.map(receive);
          assert.equal(
            (await call("/records", "POST", input(), employeeCookie)).status,
            201,
          );
          const messages = await Promise.race([
            Promise.all(waiting),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () => reject(new Error("Нет уведомлений")),
                5000,
              );
              timer.unref();
            }),
          ]);
          for (const text of messages) assert.match(text, /measurements/);
        } finally {
          abort.abort();
          for (const reader of readers) await reader.cancel().catch(() => {});
        }
      },
    );
    await t.test(
      "Экспорт Excel включает все строки фильтра, независимо от пагинации",
      async () => {
        const r = await call(
          "/records/export?mixtureId=" + mixtureId + "&size=1",
          "GET",
          undefined,
          adminCookie,
        );
        assert.equal(r.status, 200);
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Buffer.from(await r.arrayBuffer()) as any);
        const count = Number(
          (
            await pool.query(
              "SELECT count(*) AS n FROM measurements WHERE mixture_id=$1",
              [mixtureId],
            )
          ).rows[0].n,
        );
        assert.equal(wb.worksheets[0].rowCount, count + 1);
        assert.equal(wb.worksheets[0].columnCount, 8);
        assert.equal(wb.worksheets[0].getCell("F1").value, "T(fact), °C");
        assert.equal(
          typeof wb.worksheets[0].getRow(2).getCell(4).value,
          "number",
        );
      },
    );
    await runWorkflowTests(t, {
      call,
      rootCookie,
      adminCookie,
      employeeCookie,
      admin,
      employee,
    });
    await runMaintenanceTests(t, {
      call,
      rootCookie,
      adminCookie,
      employeeCookie,
      admin,
      employee,
    });
    await runManagementImportTests(t, {
      call,
      cookie,
      root,
      rootCookie,
      admin,
      adminCookie,
      employee,
      employeeCookie,
      password,
    });
    await t.test(
      "Архив сохраняет историю, администратор управляет всеми записями",
      async () => {
        assert.equal(
          (
            await call(
              "/mixtures/" + mixtureId,
              "DELETE",
              undefined,
              adminCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(
              "/mixtures/" + mixtureId,
              "PUT",
              { name: "Archived", tMin: 30, tMax: 60, archived: true },
              adminCookie,
            )
          ).status,
          200,
        );
        assert.equal(
          (await call("/records", "POST", input(), employeeCookie)).status,
          400,
        );
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
      },
    );
    await t.test(
      "Сброс пароля и отключение сотрудника немедленно отзывают сессии",
      async () => {
        const newPassword = "Changed-" + randomBytes(12).toString("hex");
        const r = await call(
          "/users/" + second.id,
          "PUT",
          { ...second, password: newPassword },
          adminCookie,
        );
        assert.equal(r.status, 200);
        second = await r.json();
        assert.equal(
          (await call("/records", "GET", undefined, secondCookie)).status,
          401,
        );
        assert.equal(
          (await call("/auth/login", "POST", { login: second.login, password }))
            .status,
          401,
        );
        const login = await call("/auth/login", "POST", {
          login: second.login,
          password: newPassword,
        });
        assert.equal(login.status, 200);
        secondCookie = cookie(login);
        const updated = await call(
          "/users/" + second.id,
          "PUT",
          { ...second, active: false },
          adminCookie,
        );
        assert.equal(updated.status, 200);
        assert.equal(
          (await call("/records", "GET", undefined, secondCookie)).status,
          401,
        );
        assert.equal(
          (
            await call("/auth/login", "POST", {
              login: second.login,
              password: newPassword,
            })
          ).status,
          401,
        );
      },
    );
    await t.test(
      "Последний KEYUSER защищён; устаревшая версия пользователя отклоняется",
      async () => {
        assert.equal(
          (
            await call(
              "/users/" + root.id,
              "PUT",
              { ...root, active: false },
              rootCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (
            await call(
              "/users/" + root.id,
              "PUT",
              { ...root, role: "EMPLOYEE" },
              rootCookie,
            )
          ).status,
          409,
        );
        assert.equal(
          (await call("/users/" + second.id, "PUT", second, adminCookie))
            .status,
          409,
        );
      },
    );
    await t.test(
      "Сессии постоянны в базе, выход отзывает токен и защищён от чужого Origin",
      async () => {
        const cross = await fetch(base + "/auth/logout", {
          method: "POST",
          headers: { Cookie: employeeCookie, Origin: "https://other.example" },
        });
        assert.equal(cross.status, 403);
        assert.equal(
          (await call("/auth/me", "GET", undefined, employeeCookie)).status,
          200,
        );
        assert.equal(
          (await call("/auth/logout", "POST", {}, employeeCookie)).status,
          204,
        );
        assert.equal(
          (await call("/records", "GET", undefined, employeeCookie)).status,
          401,
        );
      },
    );
    await t.test(
      "Резервная копия восстанавливается только в пустую базу без потери старых измерений",
      async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "mixcontrol-backup-test-"),
        );
        const backup = join(directory, "data.json");
        const database =
          "mixcontrol_test_restore_" + randomBytes(6).toString("hex");
        const execute = promisify(execFile);
        const url = new URL(process.env.DATABASE_URL!);
        url.pathname = "/" + database;
        const env = { ...process.env, DATABASE_URL: url.toString() };
        let restored: pg.Client | undefined;
        try {
          await execute(
            process.execPath,
            ["scripts/database-snapshot.mjs", "export", backup],
            { windowsHide: true },
          );
          await pool.query(
            `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`,
          );
          await execute(
            process.execPath,
            ["--import", "tsx", "server/migrate.ts"],
            { env, windowsHide: true },
          );
          await execute(
            process.execPath,
            ["scripts/database-snapshot.mjs", "restore", backup],
            { env, windowsHide: true },
          );
          restored = new pg.Client({ connectionString: url.toString() });
          await restored.connect();
          const data = JSON.parse(await readFile(backup, "utf8"));
          for (const table of [
            "users",
            "mixtures",
            "measurements",
            "audit_log",
            "corrective_actions",
            "correction_events",
            "correction_comments",
            "daily_reports",
          ]) {
            const restoredRows: pg.QueryResultRow[] = (
              await restored.query(
                `SELECT *${["measurements", "corrective_actions", "daily_reports"].includes(table) ? ",to_char(date,'YYYY-MM-DD') AS date" : ""} FROM ${table} t ORDER BY ${table === "daily_reports" ? "t.date" : "t.id"}`,
              )
            ).rows;
            assert.deepEqual(
              JSON.parse(JSON.stringify(restoredRows)),
              data.tables[table],
            );
          }
          await assert.rejects(
            execute(
              process.execPath,
              ["scripts/database-snapshot.mjs", "restore", backup],
              { env, windowsHide: true },
            ),
          );
        } finally {
          await restored?.end();
          await pool.query(
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
          );
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "Снимок прежней схемы 004 совместим: данные сохранены, первый ADMIN получает роль KEYUSER",
      async () => {
        const directory = await mkdtemp(
          join(tmpdir(), "mixcontrol-legacy-backup-test-"),
        );
        const backup = join(directory, "legacy-v4.json");
        const database =
          "mixcontrol_test_legacy_restore_" + randomBytes(6).toString("hex");
        const execute = promisify(execFile),
          url = new URL(process.env.DATABASE_URL!);
        url.pathname = "/" + database;
        const env = { ...process.env, DATABASE_URL: url.toString() };
        let restored: pg.Client | undefined;
        try {
          await execute(
            process.execPath,
            ["scripts/database-snapshot.mjs", "export", backup],
            { windowsHide: true },
          );
          const data = JSON.parse(await readFile(backup, "utf8"));
          data.schemaVersion = 4;
          delete data.tables.audit_log;
          for (const u of data.tables.users) {
            // Schema 004 had mandatory credentials even for inactive historical identities.
            if (u.login == null) u.login = "legacy_" + u.id;
            if (u.password_hash == null)
              u.password_hash = "legacy-disabled-account";
            delete u.deleted_at;
            if (u.role === "KEYUSER") u.role = "ADMIN";
          }
          await writeFile(backup, JSON.stringify(data));
          await pool.query(
            `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`,
          );
          await execute(
            process.execPath,
            ["--import", "tsx", "server/migrate.ts"],
            { env, windowsHide: true },
          );
          await execute(
            process.execPath,
            ["scripts/database-snapshot.mjs", "restore", backup],
            { env, windowsHide: true },
          );
          restored = new pg.Client({ connectionString: url.toString() });
          await restored.connect();
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int AS n FROM measurements",
              )
            ).rows[0].n,
            data.tables.measurements.length,
          );
          assert.equal(
            (
              await restored.query("SELECT role FROM users WHERE id=$1", [
                root.id,
              ])
            ).rows[0].role,
            "KEYUSER",
          );
          assert.equal(
            (
              await restored.query(
                "SELECT count(*)::int AS n FROM audit_log WHERE action='security.bootstrap_keyuser'",
              )
            ).rows[0].n,
            1,
          );
        } finally {
          await restored?.end();
          await pool.query(
            `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
          );
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
    await t.test(
      "Защита от повторных неудачных попыток входа сохранена",
      async () => {
        let limited: Response | undefined;
        for (let i = 0; i < 40; i++) {
          const response = await call("/auth/login", "POST", {
            login: employee.login,
            password: "wrong",
          });
          if (response.status === 429) {
            limited = response;
            break;
          }
          assert.equal(response.status, 401);
        }
        assert.ok(limited);
        assert.ok(limited.headers.get("Retry-After"));
      },
    );
  } finally {
    await pool.end();
  }
});
