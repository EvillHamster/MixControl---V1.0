import ExcelJS from "exceljs";
import { z } from "zod";
import { pool } from "./db.js";
import { transaction, assertActor } from "./audit.js";
import { fail } from "./repository.js";
import {
  correctionUpdateSchema,
  correctionStatuses,
  type Correction,
} from "../shared/workflow.js";
import type { User } from "../shared/domain.js";
const columns =
  'c.id,c.measurement_key AS "measurementKey",c.measurement_id AS "measurementId",to_char(c.date,\'YYYY-MM-DD\') AS date,c.sup,c.mixture_name AS "mixtureName",c.actual,c.equipment,c.delta,c.initial_data AS "initialData",c.source_deleted AS "sourceDeleted",c.status,c.responsible_id AS "responsibleId",(SELECT name||CASE WHEN deleted_at IS NOT NULL THEN \' (удалён)\' WHEN NOT active THEN \' (отключён)\' ELSE \'\' END FROM users WHERE id=c.responsible_id) AS "responsibleName",c.work_done AS "workDone",c.detected_at AS "detectedAt",c.completed_at AS "completedAt",c.updated_at AS "updatedAt",c.version';
function filters(input: Record<string, unknown>) {
  const q = z
    .object({
      view: z.enum(["active", "archive"]).default("active"),
      search: z.string().max(80).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
      status: z.enum(["NOT_STARTED", "IN_PROGRESS", "DONE"]).optional(),
      responsibleId: z.union([z.string().uuid(), z.literal("none")]).optional(),
    })
    .parse(input);
  if (q.from && q.to && q.from > q.to)
    fail(400, "Начальная дата не может быть позже конечной");
  const values: unknown[] = [],
    parts: string[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    parts.push(sql.replace("?", "$" + values.length));
  };
  parts.push(
    q.view === "archive"
      ? "c.status='DONE'"
      : "c.status IN ('NOT_STARTED','IN_PROGRESS')",
  );
  if (q.search) add("position(? in c.sup)>0", q.search.trim());
  if (q.from) add("c.date>=?::date", q.from);
  if (q.to) add("c.date<=?::date", q.to);
  if (q.status) add("c.status=?", q.status);
  if (q.responsibleId === "none") parts.push("c.responsible_id IS NULL");
  else if (q.responsibleId) add("c.responsible_id=?", q.responsibleId);
  return { where: parts.length ? " WHERE " + parts.join(" AND ") : "", values };
}
const pageNumber = (v: unknown) =>
  z.coerce.number().int().positive().max(1000000).default(1).parse(v);
export const correctionRepository = {
  async summary() {
    return (
      await pool.query(
        "SELECT count(*)::int AS active FROM corrective_actions WHERE status IN ('NOT_STARTED','IN_PROGRESS')",
      )
    ).rows[0];
  },
  async list(query: Record<string, unknown>) {
    const { where, values } = filters(query),
      page = pageNumber(query.page);
    return transaction(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const total = (
        await c.query(
          "SELECT count(*)::int AS n FROM corrective_actions c" + where,
          values,
        )
      ).rows[0].n;
      const rows = (
        await c.query<Correction>(
          "SELECT " +
            columns +
            " FROM corrective_actions c" +
            where +
            " ORDER BY c.date DESC,c.detected_at DESC,c.id LIMIT 15 OFFSET $" +
            (values.length + 1),
          [...values, (page - 1) * 15],
        )
      ).rows;
      return { rows, total, page, size: 15 };
    });
  },
  async assignees() {
    return (
      await pool.query(
        "SELECT u.id,u.name||CASE WHEN u.deleted_at IS NOT NULL THEN ' (удалён)' WHEN NOT u.active THEN ' (отключён)' ELSE '' END AS name,u.role,(u.active AND u.deleted_at IS NULL AND u.role IN ('ADMIN','KEYUSER')) AS assignable FROM users u WHERE (u.active AND u.deleted_at IS NULL AND u.role IN ('ADMIN','KEYUSER')) OR EXISTS(SELECT 1 FROM corrective_actions c WHERE c.responsible_id=u.id) ORDER BY u.name,u.id",
      )
    ).rows;
  },
  async detail(id: string, query: Record<string, unknown> = {}) {
    const page = pageNumber(query.page);
    return transaction(async (c) => {
      await c.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const correction = (
        await c.query(
          "SELECT " + columns + " FROM corrective_actions c WHERE c.id=$1",
          [id],
        )
      ).rows[0];
      if (!correction) fail(404, "Корректировка не найдена");
      const events = (
        await c.query(
          'SELECT id,kind,actor_name AS "actorName",actor_login AS "actorLogin",before_data AS before,after_data AS after,created_at AS "createdAt" FROM correction_events WHERE correction_id=$1 AND kind<>\'comment_added\' ORDER BY id DESC LIMIT 25 OFFSET $2',
          [id, (page - 1) * 25],
        )
      ).rows;
      const counts = (
        await c.query(
          "SELECT count(*)::int AS events FROM correction_events WHERE correction_id=$1 AND kind<>'comment_added'",
          [id],
        )
      ).rows[0];
      return { correction, events, eventTotal: counts.events, page };
    });
  },
  async update(id: string, body: unknown, actor: User) {
    const d = correctionUpdateSchema.parse(body);
    await transaction(async (c) => {
      await assertActor(c, actor, true);
      const old = (
        await c.query(
          "SELECT c.*,(SELECT name FROM users WHERE id=c.responsible_id) AS responsible_name FROM corrective_actions c WHERE c.id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (!old) fail(404, "Корректировка не найдена");
      if (old.version !== d.version)
        fail(
          409,
          "Корректировка изменена другим пользователем. Обновите карточку.",
        );
      if (d.responsibleId !== null && d.responsibleId !== old.responsible_id) {
        const person = (
          await c.query(
            "SELECT 1 FROM users WHERE id=$1 AND active AND deleted_at IS NULL AND role IN ('ADMIN','KEYUSER') FOR SHARE",
            [d.responsibleId],
          )
        ).rowCount;
        if (!person)
          fail(
            400,
            "Выберите активного ответственного с ролью ADMIN или KEYUSER",
          );
      }
      const saved = (
        await c.query(
          "UPDATE corrective_actions SET status=$1,responsible_id=$2,work_done=$3,completed_at=CASE WHEN $1='DONE' THEN COALESCE(completed_at,now()) ELSE NULL END,version=version+1,updated_at=now() WHERE id=$4 RETURNING *",
          [d.status, d.responsibleId, d.workDone, id],
        )
      ).rows[0];
      saved.responsible_name = saved.responsible_id
        ? (
            await c.query("SELECT name FROM users WHERE id=$1", [
              saved.responsible_id,
            ])
          ).rows[0]?.name
        : null;
      await c.query(
        "SELECT correction_event($1,'updated',$2::jsonb,$3::jsonb)",
        [id, JSON.stringify(old), JSON.stringify(saved)],
      );
    });
    return this.detail(id);
  },
  async workbook(query: Record<string, unknown>) {
    const { where, values } = filters(query);
    const rows = (
      await pool.query<Correction>(
        "SELECT " +
          columns +
          " FROM corrective_actions c" +
          where +
          " ORDER BY c.date DESC,c.detected_at DESC,c.id LIMIT 100001",
        values,
      )
    ).rows;
    if (rows.length > 100000)
      fail(
        400,
        "Для экспорта выберите не более 100 000 корректировок с помощью фильтров",
      );
    const book = new ExcelJS.Workbook(),
      sheet = book.addWorksheet("Корректирующие действия");
    sheet.columns = [
      { header: "Дата", key: "date", width: 15 },
      { header: "SUP", key: "sup", width: 15 },
      { header: "Смесь", key: "mixtureName", width: 30 },
      { header: "T(fact), °C", key: "actual", width: 17 },
      { header: "T(обор), °C", key: "equipment", width: 17 },
      { header: "ΔT, °C", key: "delta", width: 15 },
      { header: "Статус", key: "statusName", width: 20 },
      { header: "Ответственный", key: "responsibleName", width: 28 },
      { header: "Что было сделано", key: "workDone", width: 60 },
      { header: "Дата создания", key: "created", width: 24 },
      { header: "Дата завершения", key: "completed", width: 24 },
    ];
    const time = (d: string | null) =>
      d
        ? new Intl.DateTimeFormat("ru-RU", {
            timeZone: "Europe/Moscow",
            dateStyle: "short",
            timeStyle: "medium",
          }).format(new Date(d))
        : "";
    for (const row of rows)
      sheet.addRow({
        ...row,
        statusName: correctionStatuses[row.status],
        created: time(row.detectedAt),
        completed: time(row.completedAt),
      });
    sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF2459C4" },
    };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.autoFilter = "A1:K1";
    sheet.getColumn("workDone").alignment = { wrapText: true, vertical: "top" };
    return book;
  },
};
