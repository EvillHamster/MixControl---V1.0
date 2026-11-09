import { pool } from "./db.js";
import { audit, transaction, assertActor } from "./audit.js";
import { z } from "zod";
import {
  recordSchema,
  type Measurement,
  type Mixture,
  type User,
} from "../shared/domain.js";
export const uuid = (v: unknown) => z.string().uuid().parse(v);
export function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const recordColumns = `id,to_char(date,'YYYY-MM-DD') AS date,sup,mixture_id AS "mixtureId",mixture_name AS "mixtureName",t_min AS "tMin",t_max AS "tMax",actual,equipment,delta,legacy_pending AS "legacyPending",actual_min AS "actualMin",actual_max AS "actualMax",status,version,created_by AS "createdBy",(SELECT name FROM users WHERE users.id=measurements.created_by) AS "authorName"`;
function filters(query: Record<string, unknown>) {
  const q = z
    .object({
      search: z.string().max(80).optional(),
      mixtureId: z.string().uuid().optional(),
      status: z.enum(["OK", "NOK", "pending"]).optional(),
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
    })
    .parse(query);
  if (q.from && q.to && q.from > q.to)
    fail(400, "Начальная дата не может быть позже конечной");
  const values: unknown[] = [];
  const clauses: string[] = [];
  const add = (sql: string, v: unknown) => {
    values.push(v);
    clauses.push(sql.replace("?", `$${values.length}`));
  };
  if (q.search) add("position(? in sup)>0", q.search.trim().toUpperCase());
  if (q.mixtureId) add("mixture_id=?", q.mixtureId);
  if (q.status === "pending") clauses.push("status IS NULL");
  else if (q.status) add("status=?", q.status);
  if (q.from) add("date>=?::date", q.from);
  if (q.to) add("date<=?::date", q.to);
  return {
    selection: q,
    where: clauses.length ? " WHERE " + clauses.join(" AND ") : "",
    values,
  };
}
function deletionFilters(query: Record<string, unknown>) {
  const f = filters(query);
  if (
    !f.selection.from &&
    !f.selection.to &&
    !f.selection.mixtureId &&
    !f.selection.status &&
    !f.selection.search?.trim()
  )
    fail(400, "Выберите период дат или другой фильтр для удаления");
  return f;
}
async function deletionPreview(
  c: Pick<import("pg").PoolClient, "query">,
  f: ReturnType<typeof filters>,
) {
  const r = (
    await c.query(
      `SELECT count(*)::int AS count,md5(coalesce(string_agg(id::text||':'||version::text,',' ORDER BY id),'')) AS fingerprint FROM measurements${f.where}`,
      f.values,
    )
  ).rows[0];
  return r as { count: number; fingerprint: string };
}
const mixtureNameKey = (name: string) => name.trim().toLocaleLowerCase("ru-RU");
async function duplicateMixtureName(
  c: import("pg").PoolClient,
  name: string,
  exclude?: string,
) {
  const rows = (await c.query("SELECT id,name FROM mixtures")).rows;
  return rows.some(
    (m) => m.id !== exclude && mixtureNameKey(m.name) === mixtureNameKey(name),
  );
}
export const mixtureRepository = {
  async list(includeNorms = true) {
    return (
      await pool.query<Mixture>(
        `SELECT m.id,m.name,${includeNorms ? "m.t_min" : "NULL"} AS "tMin",${includeNorms ? "m.t_max" : "NULL"} AS "tMax",m.archived,${includeNorms ? "(SELECT count(*)::int FROM measurements r WHERE r.mixture_id=m.id)" : "0"} AS "recordCount" FROM mixtures m ORDER BY m.archived,m.name`,
      )
    ).rows;
  },
  async create(d: { name: string; tMin: number; tMax: number }, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await c.query("SELECT pg_advisory_xact_lock(847204)");
      if (await duplicateMixtureName(c, d.name))
        fail(409, "Смесь с таким названием уже существует");
      const row = (
        await c.query(
          "INSERT INTO mixtures(name,t_min,t_max) VALUES($1,$2,$3) RETURNING *",
          [d.name, d.tMin, d.tMax],
        )
      ).rows[0];
      await audit(c, actor, "mixture.create", "mixtures", row.id, null, row);
      return { id: row.id };
    });
  },
  async update(
    id: string,
    d: { name: string; tMin: number; tMax: number; archived?: boolean },
    actor: User,
  ) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await c.query("SELECT pg_advisory_xact_lock(847204)");
      const old = (
        await c.query("SELECT * FROM mixtures WHERE id=$1 FOR UPDATE", [id])
      ).rows[0];
      if (!old) fail(404, "Смесь не найдена");
      if (await duplicateMixtureName(c, d.name, id))
        fail(409, "Смесь с таким названием уже существует");
      const row = (
        await c.query(
          "UPDATE mixtures SET name=$1,t_min=$2,t_max=$3,archived=$4 WHERE id=$5 RETURNING *",
          [d.name, d.tMin, d.tMax, d.archived ?? false, id],
        )
      ).rows[0];
      await audit(c, actor, "mixture.update", "mixtures", id, old, row);
      return { id };
    });
  },
  async delete(id: string, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await c.query("SELECT pg_advisory_xact_lock(847204)");
      const row = (
        await c.query("DELETE FROM mixtures WHERE id=$1 RETURNING *", [id])
      ).rows[0];
      if (!row) fail(404, "Смесь не найдена");
      await audit(c, actor, "mixture.delete", "mixtures", id, row, null);
    });
  },
};
export const recordRepository = {
  async supAvailable(sup: string, exclude: string | null) {
    return !(
      await pool.query(
        "SELECT 1 FROM measurements WHERE sup=$1 AND ($2::uuid IS NULL OR id<>$2)",
        [sup.trim().toUpperCase(), exclude],
      )
    ).rowCount;
  },
  async list(query: Record<string, unknown>) {
    const { where, values } = filters(query);
    const page = z.coerce.number().int().min(1).default(1).parse(query.page),
      size = z.coerce
        .number()
        .int()
        .min(1)
        .max(15)
        .default(15)
        .parse(query.size);
    const sortMap: Record<string, string> = {
      date: "date",
      sup: "sup",
      mixtureName: "mixture_name",
      tMin: "t_min",
      tMax: "t_max",
      actual: "actual",
      equipment: "equipment",
      status: "status",
    };
    const sort = Object.hasOwn(sortMap, String(query.sort))
        ? sortMap[String(query.sort)]
        : "date",
      dir = query.direction === "asc" ? "ASC" : "DESC";
    const c = await pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const stats = await c.query(
        `SELECT count(*)::int AS total,count(*) FILTER(WHERE status='OK')::int AS ok,count(*) FILTER(WHERE status='NOK')::int AS nok,count(*) FILTER(WHERE status IS NULL)::int AS pending FROM measurements${where}`,
        values,
      );
      const rows = await c.query<Measurement>(
        `SELECT ${recordColumns} FROM measurements${where} ORDER BY ${sort} ${dir} NULLS LAST,created_at DESC,id LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, size, (page - 1) * size],
      );
      await c.query("COMMIT");
      return { records: rows.rows, ...stats.rows[0], page, size };
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
  async export(query: Record<string, unknown>) {
    const { where, values } = filters(query);
    const r = await pool.query<Measurement>(
      `SELECT ${recordColumns} FROM measurements${where} ORDER BY date DESC,created_at DESC LIMIT 100001`,
      values,
    );
    if (r.rows.length > 100000)
      fail(
        400,
        "Для экспорта выберите не более 100 000 записей с помощью фильтров",
      );
    return r.rows;
  },
  async previewDeletion(query: Record<string, unknown>, actor: User) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      return deletionPreview(c, deletionFilters(query));
    });
  },
  async deleteFiltered(
    query: Record<string, unknown>,
    fingerprint: string,
    actor: User,
  ) {
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await c.query("SELECT pg_advisory_xact_lock(847204)");
      await c.query("LOCK TABLE measurements IN SHARE ROW EXCLUSIVE MODE");
      const f = deletionFilters(query);
      const current = await deletionPreview(c, f);
      if (current.fingerprint !== fingerprint)
        fail(
          409,
          "Записи изменились после предпросмотра. Повторно проверьте количество и подтвердите удаление.",
        );
      if (!current.count)
        fail(400, "Нет записей для удаления по выбранным фильтрам");
      // A single statement, with one audit entry per source; database triggers remove linked tasks.
      await c.query(
        `WITH removed AS (DELETE FROM measurements${f.where} RETURNING *)
        INSERT INTO audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,details)
        SELECT $${f.values.length + 1}::uuid,$${f.values.length + 2},'record.delete','measurements',id::text,sup,to_jsonb(removed),$${f.values.length + 3}::jsonb FROM removed`,
        [
          ...f.values,
          actor.id,
          actor.login,
          JSON.stringify({ bulk: true, filters: f.selection }),
        ],
      );
      await audit(
        c,
        actor,
        "record.bulk_delete",
        "measurements",
        null,
        null,
        null,
        { count: current.count, filters: f.selection },
      );
      return { deleted: current.count };
    });
  },
  async save(
    recordId: string | null,
    d: z.infer<typeof recordSchema>,
    actor: User,
  ) {
    if (recordId && actor.role === "EMPLOYEE")
      fail(403, "EMPLOYEE не может редактировать сохранённые записи");
    if (recordId && !d.version) fail(400, "Не указана версия записи");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await assertActor(c, actor, !!recordId);
      await c.query("SELECT pg_advisory_xact_lock_shared(847204)");
      let previous;
      if (recordId) {
        previous = (
          await c.query("SELECT * FROM measurements WHERE id=$1 FOR UPDATE", [
            recordId,
          ])
        ).rows[0];
        if (!previous) fail(404, "Запись не найдена");
        if (actor.role === "EMPLOYEE")
          fail(403, "EMPLOYEE не может редактировать сохранённые записи");
        if (previous.version !== d.version)
          fail(409, "Запись изменена другим пользователем. Обновите страницу.");
      }
      let snapshot;
      if (previous?.mixture_id === d.mixtureId)
        snapshot = {
          name: previous.mixture_name,
          t_min: previous.t_min,
          t_max: previous.t_max,
        };
      else {
        snapshot = (
          await c.query(
            "SELECT * FROM mixtures WHERE id=$1 AND NOT archived FOR SHARE",
            [d.mixtureId],
          )
        ).rows[0];
        if (!snapshot) fail(400, "Выберите действующую смесь");
      }
      const args = [
        d.sup,
        d.mixtureId,
        snapshot.name,
        snapshot.t_min,
        snapshot.t_max,
        d.actual,
        d.equipment,
      ];
      const sql = recordId
        ? `UPDATE measurements SET sup=$1,mixture_id=$2,mixture_name=$3,t_min=$4,t_max=$5,actual=$6,equipment=$7,legacy_pending=CASE WHEN $6::double precision IS NOT NULL THEN false ELSE legacy_pending END,version=version+1,updated_at=now() WHERE id=$8 RETURNING ${recordColumns}`
        : `INSERT INTO measurements(sup,mixture_id,mixture_name,t_min,t_max,actual,equipment,created_by,date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(now() AT TIME ZONE 'Europe/Moscow')::date) RETURNING ${recordColumns}`;
      const r = await c.query<Measurement>(sql, [
        ...args,
        recordId ?? actor.id,
      ]);
      await audit(
        c,
        actor,
        recordId ? "record.update" : "record.create",
        "measurements",
        r.rows[0].id,
        previous ?? null,
        r.rows[0],
        {},
        d.sup,
      );
      await c.query("COMMIT");
      return r.rows[0];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  },
  async delete(id: string, version: number, actor: User) {
    if (actor.role === "EMPLOYEE")
      fail(403, "Недостаточно прав для удаления записи");
    return transaction(async (c) => {
      await assertActor(c, actor, true);
      await c.query("SELECT pg_advisory_xact_lock_shared(847204)");
      const old = (
        await c.query(
          "DELETE FROM measurements WHERE id=$1 AND version=$2 RETURNING *",
          [id, version],
        )
      ).rows[0];
      if (!old) fail(409, "Запись удалена или изменена. Обновите страницу.");
      await audit(
        c,
        actor,
        "record.delete",
        "measurements",
        id,
        old,
        null,
        {},
        old.sup,
      );
    });
  },
};
