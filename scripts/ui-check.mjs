// Optional isolated browser QA; never points the app at the working database.
import "dotenv/config";
import pg from "pg";
import ExcelJS from "exceljs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
const control = new pg.Client({ connectionString: process.env.DATABASE_URL });
const database = "mixcontrol_test_ui_" + randomBytes(6).toString("hex");
const port = 3002;
const base = `http://127.0.0.1:${port}/api`;
await control.connect();
await control.query(
  `CREATE DATABASE "${database}" TEMPLATE template0 ENCODING 'UTF8'`,
);
const url = new URL(process.env.DATABASE_URL);
url.pathname = "/" + database;
const server = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: {
    ...process.env,
    DATABASE_URL: url.toString(),
    PORT: String(port),
    HOST: "127.0.0.1",
    COOKIE_SECURE: "false",
  },
  windowsHide: true,
  stdio: "inherit",
});
let stopped = false;
async function cleanup() {
  if (stopped) return;
  stopped = true;
  server.kill("SIGTERM");
  await new Promise((resolve) =>
    server.exitCode !== null ? resolve() : server.once("exit", resolve),
  );
  await control.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await control.end();
  process.exit();
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.stdin.on("data", (data) => {
  if (data.toString().trim() === "stop") void cleanup();
});
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    ready = (await fetch(base + "/health")).ok;
  } catch {}
  if (ready) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
  await cleanup();
  throw new Error("QA API не запустился");
}
const password = "Ui-check-" + randomBytes(10).toString("hex");
const setup = await fetch(base + "/auth/setup", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    login: "ui_keyuser",
    name: "Ключевой пользователь",
    password,
  }),
});
const cookie = setup.headers.get("set-cookie").split(";")[0];
const call = (route, body) =>
  fetch(base + route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
await call("/users", {
  login: "ui_employee",
  name: "Анна · Контроль качества",
  password,
  role: "EMPLOYEE",
});
await call("/users", {
  login: "ui_admin",
  name: "Администратор",
  password,
  role: "ADMIN",
});
const mixtures = [];
for (const [name, tMin, tMax] of [
  ["M1 — T11430", 100, 150],
  ["M2 — T11600", 90, 130],
  ["M3 — T11720", 110, 160],
])
  mixtures.push(
    (await (await call("/mixtures", { name, tMin, tMax })).json()).id,
  );
const login = await fetch(base + "/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ login: "ui_employee", password }),
});
const employeeCookie = login.headers.get("set-cookie").split(";")[0];
for (let i = 0; i < 18; i++)
  await fetch(base + "/records", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: i % 2 ? employeeCookie : cookie,
    },
    body: JSON.stringify({
      date: "2026-11-09",
      sup: String(9933451 + i),
      mixtureId: mixtures[i % 3],
      actual: i % 4 === 0 ? 165 : i % 5 === 0 ? null : 125,
      equipment: 120,
    }),
  });
const wb = new ExcelJS.Workbook(),
  sheet = wb.addWorksheet("Журнал");
sheet.addRow([
  "Дата",
  "SUP",
  "Смесь",
  "T min",
  "T max",
  "T(fact)",
  "T(обор)",
  "Итог",
]);
const yesterday = new Date(Date.now() - 86400000).toLocaleDateString("en-CA", {
  timeZone: "Europe/Moscow",
});
for (const [sup, actual, equipment] of [
  [9940001, 125, 123],
  [9940002, 155, 145],
  [9940003, 145, 155],
])
  sheet.addRow([
    yesterday,
    String(sup),
    "M1 — T11430",
    100,
    150,
    actual,
    equipment,
    "",
  ]);
const preview = await fetch(base + "/records/import/preview", {
  method: "POST",
  headers: {
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    Cookie: cookie,
  },
  body: Buffer.from(await wb.xlsx.writeBuffer()),
});
const previewData = await preview.json();
if (!preview.ok || previewData.errors?.length)
  throw new Error(JSON.stringify(previewData));
const confirmed = await call("/records/import/confirm", { id: previewData.id });
if (!confirmed.ok) throw new Error(await confirmed.text());
console.log(
  JSON.stringify({
    url: `http://localhost:${port}`,
    keyuser: "ui_keyuser",
    admin: "ui_admin",
    employee: "ui_employee",
    password,
    note: "Disposable synthetic QA accounts only. Working database unchanged. Type stop to clean up.",
  }),
);
setInterval(() => {}, 60000);
