import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { pool } from "./db.js";
import { audit, transaction, setAuditActor } from "./audit.js";
import { fail } from "./repository.js";
import {
  mixtureSchema,
  recordSchema,
  result,
  type User,
} from "../shared/domain.js";
import type {
  ImportKind,
  ImportPreview,
  ImportIssue,
} from "../shared/imports.js";
type Source = { row: number; values: Record<string, unknown>; error?: string };
const maxRows = 5000;
const normalize = (s: unknown) =>
  String(s ?? "")
    .trim()
    .toLocaleLowerCase("ru-RU");
const header = (s: unknown) =>
  normalize(s).replace(/°c|°с/g, "").replace(/[\s,]/g, "");
const headers: Record<string, string> = {
  дата: "date",
  sup: "sup",
  смесь: "name",
  названиесмеси: "name",
  название: "name",
  tmin: "tMin",
  tmax: "tMax",
  "t(fact)": "actual",
  "t(обор)": "equipment",
  итог: "status",
  статус: "archived",
  статусактивности: "archived",
};
function inspectZip(buffer: Buffer) {
  if (buffer.length > 5 * 1024 * 1024)
    fail(400, "Размер Excel не должен превышать 5 МБ");
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--)
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) fail(400, "Файл не является корректным .xlsx");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16),
    expanded = 0;
  if (count > 1000) fail(400, "Слишком сложная структура Excel");
  for (let i = 0; i < count; i++) {
    if (
      offset + 46 > buffer.length ||
      buffer.readUInt32LE(offset) !== 0x02014b50
    )
      fail(400, "Повреждена структура .xlsx");
    expanded += buffer.readUInt32LE(offset + 24);
    if (expanded > 30 * 1024 * 1024)
      fail(400, "Распакованный Excel превышает допустимый размер 30 МБ");
    offset +=
      46 +
      buffer.readUInt16LE(offset + 28) +
      buffer.readUInt16LE(offset + 30) +
      buffer.readUInt16LE(offset + 32);
  }
}
export async function readImport(
  buffer: Buffer,
  kind: ImportKind,
): Promise<Source[]> {
  inspectZip(buffer);
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(buffer as any);
  } catch {
    fail(
      400,
      "Не удалось прочитать .xlsx: файл повреждён или имеет другой формат",
    );
  }
  const sheet = book.worksheets[0];
  if (!sheet) fail(400, "В Excel нет листа данных");
  if (sheet.rowCount > maxRows + 1)
    fail(400, "За один импорт допускается не более 5000 строк");
  const map = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => {
    const key = headers[header(cell.value)];
    if (key) {
      if (map.has(key)) fail(400, "Повторяющийся столбец: " + cell.text);
      map.set(key, index);
    }
  });
  const required =
    kind === "records"
      ? ["date", "sup", "name", "tMin", "tMax", "actual", "status"]
      : ["name", "tMin", "tMax"];
  const missing = required.filter((k) => !map.has(k));
  if (missing.length)
    fail(
      400,
      "Не найдены обязательные столбцы: " +
        missing
          .map(
            (k) =>
              ({
                date: "Дата",
                sup: "SUP",
                name: "Смесь / Название смеси",
                tMin: "T min",
                tMax: "T max",
                actual: "T(fact)",
                status: "Итог",
              })[k],
          )
          .join(", "),
    );
  const rows: Source[] = [];
  for (let n = 2; n <= sheet.rowCount; n++) {
    const row = sheet.getRow(n);
    if (!row.hasValues) continue;
    const source: Source = { row: n, values: {} };
    for (const [key, index] of map) {
      if (key === "status") continue; // Never trust an imported OK/NOK.
      const value = row.getCell(index).value;
      if (value instanceof Date)
        source.values[key] = value.toISOString().slice(0, 10);
      else if (value !== null && typeof value === "object")
        source.error =
          "Формулы, ссылки и сложные значения в ячейках не поддерживаются";
      else source.values[key] = value ?? null;
    }
    if (Object.values(source.values).every((v) => v === null || v === ""))
      continue;
    rows.push(source);
  }
  if (!rows.length) fail(400, "В файле нет строк данных");
  return rows;
}
function number(value: unknown, nullable = false): number | null {
  if (value === null || value === undefined || value === "") {
    if (nullable) return null;
    throw new Error("Не заполнена обязательная температура");
  }
  if (typeof value === "string" && /^-?\d+(?:[.,]\d+)?$/.test(value.trim()))
    value = Number(value.trim().replace(",", "."));
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Температуры должны быть конечными числами");
  return value;
}
function date(value: unknown) {
  let s = String(value ?? "").trim();
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(s)) s = s.split(".").reverse().join("-");
  if (!z.iso.date().safeParse(s).success)
    throw new Error(
      "Некорректная дата; используйте ячейку даты, ГГГГ-ММ-ДД или ДД.ММ.ГГГГ",
    );
  return s;
}
function archived(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  const s = normalize(value);
  if (["в работе", "активна", "активен", "active", "true", "1"].includes(s))
    return false;
  if (["в архиве", "архив", "archived", "false", "0"].includes(s)) return true;
  throw new Error("Статус смеси: «В работе» или «В архиве»");
}
async function plan(
  c: PoolClient,
  kind: ImportKind,
  source: Source[],
  lock = false,
) {
  const mixtures = (
    await c.query(
      "SELECT * FROM mixtures ORDER BY id" + (lock ? " FOR UPDATE" : ""),
    )
  ).rows;
  const names = new Map<string, any[]>();
  for (const mix of mixtures) {
    const k = normalize(mix.name);
    names.set(k, [...(names.get(k) ?? []), mix]);
  }
  const sups = source.map((r) => String(r.values.sup ?? "").trim());
  const existing =
    kind === "records"
      ? (
          await c.query(
            "SELECT * FROM measurements WHERE sup=ANY($1::text[]) ORDER BY sup" +
              (lock ? " FOR UPDATE" : ""),
            [sups],
          )
        ).rows
      : [];
  const records = new Map(existing.map((r) => [r.sup, r]));
  const occurrences = new Map<string, number[]>();
  for (const row of source) {
    const key =
      kind === "records"
        ? String(row.values.sup ?? "").trim()
        : normalize(row.values.name);
    occurrences.set(key, [...(occurrences.get(key) ?? []), row.row]);
  }
  const errors: ImportIssue[] = [];
  const rows: any[] = [];
  for (const sourceRow of source) {
    const v = sourceRow.values;
    const sup = String(v.sup ?? "").trim(),
      name = String(v.name ?? "").trim(),
      old = records.get(sup);
    const issue = (message: string) =>
      errors.push({
        row: sourceRow.row,
        sup,
        mixtureExcel: name,
        mixtureDb: old?.mixture_name ?? "",
        message,
      });
    try {
      if (sourceRow.error) throw new Error(sourceRow.error);
      const duplicates = occurrences.get(
        kind === "records" ? sup : normalize(name),
      )!;
      if (duplicates.length > 1)
        throw new Error(
          (kind === "records" ? "Дублирующийся SUP" : "Повторяющаяся смесь") +
            " в импортируемом файле; строки " +
            duplicates.join(", "),
        );
      const norms = mixtureSchema.safeParse({
        name,
        tMin: number(v.tMin),
        tMax: number(v.tMax),
      });
      if (!norms.success)
        throw new Error(norms.error.issues.map((i) => i.message).join(". "));
      const matches = names.get(normalize(name)) ?? [];
      if (matches.length > 1)
        throw new Error(
          "В базе несколько смесей с таким названием. Уточните названия перед импортом",
        );
      const mix = matches[0];
      if (kind === "mixtures") {
        rows.push({
          row: sourceRow.row,
          name,
          tMin: norms.data.tMin,
          tMax: norms.data.tMax,
          archived: archived(v.archived) ?? mix?.archived ?? false,
          old: mix ?? null,
          operation: mix ? "Обновление" : "Добавление",
        });
      } else {
        if (!/^[0-9]{7}$/.test(sup))
          throw new Error(
            "SUP должен содержать ровно 7 цифр; ведущие нули храните в Excel как текст",
          );
        if (!name) throw new Error("Не указано название смеси");
        if (!mix)
          throw new Error("Смесь «" + name + "» не найдена в базе смесей");
        if (
          old &&
          (normalize(old.mixture_name) !== normalize(name) ||
            old.mixture_id !== mix.id)
        )
          throw new Error(
            "Для SUP " +
              sup +
              " уже зарегистрирована другая смесь. Запись не обновлена",
          );
        if (!old && mix.archived)
          throw new Error(
            "Смесь «" +
              name +
              "» находится в архиве и недоступна для новых записей",
          );
        const actual = number(v.actual, true),
          equipment = Object.hasOwn(v, "equipment")
            ? number(v.equipment, true)
            : (old?.equipment ?? null);
        const validated = recordSchema.safeParse({
          sup,
          mixtureId: mix.id,
          actual,
          equipment,
        });
        if (!validated.success)
          throw new Error(
            validated.error.issues.map((i) => i.message).join(". "),
          );
        let status = result(
          norms.data.tMin,
          norms.data.tMax,
          actual,
          equipment,
        );
        if (old?.legacy_pending && actual === null && status !== "NOK") {
          status =
            old.actual_min === null || old.actual_max === null
              ? null
              : old.actual_min >= norms.data.tMin &&
                  old.actual_max <= norms.data.tMax &&
                  old.actual_min <= old.actual_max
                ? "OK"
                : "NOK";
        }
        rows.push({
          row: sourceRow.row,
          sup,
          name,
          date: date(v.date),
          tMin: norms.data.tMin,
          tMax: norms.data.tMax,
          actual,
          equipment,
          status,
          mixture: mix,
          old: old ?? null,
          operation: old ? "Обновление" : "Добавление",
        });
      }
    } catch (e) {
      issue((e as Error).message);
    }
  }
  return {
    total: source.length,
    added: rows.filter((r) => !r.old).length,
    updated: rows.filter((r) => r.old).length,
    errorCount: errors.length,
    errors,
    rows,
  };
}
const fingerprint = (rows: unknown) =>
  createHash("sha256").update(JSON.stringify(rows)).digest("hex");
export async function previewImport(
  buffer: Buffer,
  kind: ImportKind,
  actor: User,
): Promise<ImportPreview> {
  const source = await readImport(buffer, kind);
  return transaction(async (c) => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const preview = await plan(c, kind, source);
    let id: string | undefined;
    if (!preview.errorCount)
      id = (
        await c.query(
          "INSERT INTO import_jobs(actor_id,kind,payload) VALUES($1,$2,$3) RETURNING id",
          [
            actor.id,
            kind,
            JSON.stringify({ source, fingerprint: fingerprint(preview.rows) }),
          ],
        )
      ).rows[0].id;
    return {
      ...preview,
      id,
      rows: preview.rows.map(({ old, mixture, ...r }) => r),
    };
  });
}
export async function confirmImport(id: string, kind: ImportKind, actor: User) {
  return transaction(async (c) => {
    const current = (
      await c.query(
        "SELECT role FROM users WHERE id=$1 AND active AND deleted_at IS NULL FOR SHARE",
        [actor.id],
      )
    ).rows[0];
    if (!current || current.role === "EMPLOYEE")
      fail(403, "Импорт доступен только KEYUSER и ADMIN");
    await setAuditActor(c, actor);
    await c.query("SELECT pg_advisory_xact_lock(847204)");
    const job = (
      await c.query(
        "SELECT * FROM import_jobs WHERE id=$1 AND actor_id=$2 AND kind=$3 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE",
        [id, actor.id, kind],
      )
    ).rows[0];
    if (!job)
      fail(
        409,
        "Предпросмотр устарел, уже применён или недоступен. Загрузите файл повторно.",
      );
    const checked = await plan(c, kind, job.payload.source, true);
    if (
      checked.errorCount ||
      fingerprint(checked.rows) !== job.payload.fingerprint
    )
      fail(
        409,
        "После предпросмотра данные изменились. Загрузите Excel повторно и проверьте обновлённый результат.",
      );
    for (const r of checked.rows) {
      let saved;
      if (kind === "mixtures") {
        saved = r.old
          ? (
              await c.query(
                "UPDATE mixtures SET name=$1,t_min=$2,t_max=$3,archived=$4 WHERE id=$5 RETURNING *",
                [r.name, r.tMin, r.tMax, r.archived, r.old.id],
              )
            ).rows[0]
          : (
              await c.query(
                "INSERT INTO mixtures(name,t_min,t_max,archived) VALUES($1,$2,$3,$4) RETURNING *",
                [r.name, r.tMin, r.tMax, r.archived],
              )
            ).rows[0];
      } else {
        const args = [
          r.date,
          r.sup,
          r.mixture.id,
          r.name,
          r.tMin,
          r.tMax,
          r.actual,
          r.equipment,
        ];
        saved = r.old
          ? (
              await c.query(
                "UPDATE measurements SET date=$1,sup=$2,mixture_id=$3,mixture_name=$4,t_min=$5,t_max=$6,actual=$7,equipment=$8,legacy_pending=CASE WHEN $7::double precision IS NOT NULL THEN false ELSE legacy_pending END,version=version+1,updated_at=now() WHERE id=$9 RETURNING *",
                [...args, r.old.id],
              )
            ).rows[0]
          : (
              await c.query(
                "INSERT INTO measurements(date,sup,mixture_id,mixture_name,t_min,t_max,actual,equipment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
                [...args, actor.id],
              )
            ).rows[0];
      }
      await audit(
        c,
        actor,
        r.old ? "import.row.update" : "import.row.create",
        kind,
        saved.id,
        r.old,
        saved,
        { jobId: id, row: r.row },
        r.sup ?? null,
      );
    }
    await c.query("UPDATE import_jobs SET consumed_at=now() WHERE id=$1", [id]);
    await audit(c, actor, "import.confirm", kind, id, null, null, {
      added: checked.added,
      updated: checked.updated,
      total: checked.total,
    });
    return {
      added: checked.added,
      updated: checked.updated,
      total: checked.total,
    };
  });
}
export async function mixtureWorkbook() {
  const rows = (
    await pool.query(
      "SELECT name,t_min,t_max,archived FROM mixtures ORDER BY archived,name",
    )
  ).rows;
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("База смесей");
  sheet.columns = [
    { header: "Название смеси", key: "name", width: 35 },
    { header: "T min", key: "t_min", width: 15 },
    { header: "T max", key: "t_max", width: 15 },
    { header: "Статус", key: "status", width: 18 },
  ];
  for (const row of rows)
    sheet.addRow({ ...row, status: row.archived ? "В архиве" : "В работе" });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:D1";
  return book;
}
