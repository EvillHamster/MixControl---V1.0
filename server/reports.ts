import { z } from "zod";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { transaction, audit } from "./audit.js";
import { fail } from "./repository.js";
import type { ReportRow } from "../shared/workflow.js";
const clockSql =
  "SELECT to_char((now() AT TIME ZONE 'Europe/Moscow')::date,'YYYY-MM-DD') AS today,to_char((now() AT TIME ZONE 'Europe/Moscow')::date-1,'YYYY-MM-DD') AS yesterday";
function deviation(r: any) {
  const parts: string[] = [];
  for (const [key, title] of [
    ["actual", "T(fact)"],
    ["equipment", "T(обор)"],
  ]) {
    const n = r[key];
    if (n !== null && n < r.t_min)
      parts.push(
        title +
          " ниже на " +
          Number((r.t_min - n).toFixed(6)).toLocaleString("ru-RU") +
          " °C",
      );
    else if (n !== null && n > r.t_max)
      parts.push(
        title +
          " выше на " +
          Number((n - r.t_max).toFixed(6)).toLocaleString("ru-RU") +
          " °C",
      );
  }
  return (
    parts.join("; ") ||
    (r.legacy_pending
      ? "Историческая пара температур; требуется согласование переноса"
      : "Отклонение не определено")
  );
}
async function rebuild(c: PoolClient, date: string, tryLock = false) {
  const lock = (
    await c.query(
      "SELECT " +
        (tryLock ? "pg_try_advisory_xact_lock" : "pg_advisory_xact_lock") +
        "(847207,($1::date-'2000-01-01'::date)::int) AS locked",
      [date],
    )
  ).rows[0];
  if (tryLock && !lock.locked) return false;
  const old = (
    await c.query("SELECT * FROM daily_reports WHERE date=$1", [date])
  ).rows[0];
  if (
    old &&
    !(await c.query("SELECT 1 FROM report_dirty_days WHERE date=$1", [date]))
      .rowCount
  )
    return true;
  const stats = (
    await c.query(
      "SELECT count(*)::int AS total,count(*) FILTER(WHERE status='OK')::int AS ok,count(*) FILTER(WHERE status='NOK')::int AS nok,count(*) FILTER(WHERE status IS NULL)::int AS pending FROM measurements WHERE date=$1",
      [date],
    )
  ).rows[0];
  const nokPercent = stats.total
    ? Number(((stats.nok / stats.total) * 100).toFixed(2))
    : 0;
  const rows = (
    await c.query(
      "SELECT *,to_char(date,'YYYY-MM-DD') AS date FROM measurements WHERE date=$1 AND status='NOK' ORDER BY sup,id",
      [date],
    )
  ).rows.map(
    (r) =>
      ({
        id: r.id,
        date: r.date,
        sup: r.sup,
        mixtureName: r.mixture_name,
        tMin: r.t_min,
        tMax: r.t_max,
        actual: r.actual,
        equipment: r.equipment,
        deviation: deviation(r),
      }) satisfies ReportRow,
  );
  if (
    !old ||
    old.total !== stats.total ||
    old.ok !== stats.ok ||
    old.nok !== stats.nok ||
    old.pending !== stats.pending ||
    Number(old.nok_percent) !== nokPercent ||
    JSON.stringify(
      old.nok_rows.map((r: ReportRow) => [
        r.id,
        r.date,
        r.sup,
        r.mixtureName,
        r.tMin,
        r.tMax,
        r.actual,
        r.equipment,
        r.deviation,
      ]),
    ) !==
      JSON.stringify(
        rows.map((r: ReportRow) => [
          r.id,
          r.date,
          r.sup,
          r.mixtureName,
          r.tMin,
          r.tMax,
          r.actual,
          r.equipment,
          r.deviation,
        ]),
      )
  ) {
    const saved = (
      await c.query(
        "INSERT INTO daily_reports(date,total,ok,nok,pending,nok_percent,nok_rows) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(date) DO UPDATE SET total=EXCLUDED.total,ok=EXCLUDED.ok,nok=EXCLUDED.nok,pending=EXCLUDED.pending,nok_percent=EXCLUDED.nok_percent,nok_rows=EXCLUDED.nok_rows,version=daily_reports.version+1,updated_at=now() RETURNING *",
        [
          date,
          stats.total,
          stats.ok,
          stats.nok,
          stats.pending,
          nokPercent,
          JSON.stringify(rows),
        ],
      )
    ).rows[0];
    const summary = (r: any) =>
      r
        ? {
            date,
            total: r.total,
            ok: r.ok,
            nok: r.nok,
            pending: r.pending,
            nokPercent: Number(r.nok_percent),
            version: r.version,
          }
        : null;
    await audit(
      c,
      null,
      old ? "report.updated" : "report.generated",
      "daily_reports",
      date,
      summary(old),
      summary(saved),
    );
  }
  await c.query("DELETE FROM report_dirty_days WHERE date=$1", [date]);
  return true;
}
export async function runReportCycle(asOf?: string) {
  if (asOf) z.iso.date().parse(asOf);
  return transaction(async (c) => {
    const locked = (
      await c.query("SELECT pg_try_advisory_xact_lock(847206) AS locked")
    ).rows[0].locked;
    if (!locked) return;
    const today = asOf ?? (await c.query(clockSql)).rows[0].today;
    const range = (
      await c.query(
        "SELECT to_char($1::date-1,'YYYY-MM-DD') AS yesterday,to_char(LEAST(COALESCE(last_day,$1::date-2)+31,$1::date-1),'YYYY-MM-DD') AS finish,to_char(COALESCE(last_day,$1::date-2)+1,'YYYY-MM-DD') AS start FROM report_scheduler WHERE id=1",
        [today],
      )
    ).rows[0];
    const dates = (
      await c.query(
        "SELECT day FROM ((SELECT to_char(date,'YYYY-MM-DD') AS day FROM report_dirty_days WHERE date<$1::date ORDER BY date LIMIT 100) UNION (SELECT DISTINCT to_char(m.date,'YYYY-MM-DD') AS day FROM measurements m WHERE m.date<$1::date AND NOT EXISTS(SELECT 1 FROM daily_reports r WHERE r.date=m.date) ORDER BY day LIMIT 100) UNION SELECT to_char(d,'YYYY-MM-DD') FROM generate_series($2::date,$3::date,'1 day') d UNION SELECT $4::text) all_days ORDER BY day",
        [today, range.start, range.finish, range.yesterday],
      )
    ).rows;
    let skipped = false;
    for (const { day } of dates)
      if (!(await rebuild(c, day, true))) skipped = true;
    if (!skipped)
      await c.query(
        "UPDATE report_scheduler SET last_day=GREATEST(COALESCE(last_day,$1::date),$1::date) WHERE id=1",
        [range.finish],
      );
  });
}
export async function getDailyReport(query: Record<string, unknown>) {
  const input = z
    .object({
      date: z.iso.date().optional(),
      page: z.coerce.number().int().positive().max(1000000).default(1),
    })
    .parse(query);
  return transaction(async (c) => {
    // The shared workflow lock keeps a report and its source rows in one consistent state.
    await c.query("SELECT pg_advisory_xact_lock_shared(847204)");
    await c.query("SELECT pg_advisory_xact_lock(847206)");
    const { yesterday } = (await c.query(clockSql)).rows[0],
      date = input.date ?? yesterday;
    if (date > yesterday)
      fail(400, "Ежедневный отчёт доступен за завершённые календарные дни");
    await rebuild(c, date);
    const saved = (
      await c.query(
        "SELECT *,to_char(date,'YYYY-MM-DD') AS date FROM daily_reports WHERE date=$1",
        [date],
      )
    ).rows[0];
    const dates = (
      await c.query(
        "SELECT DISTINCT to_char(date,'YYYY-MM-DD') AS date FROM measurements WHERE date<=$1::date ORDER BY date DESC",
        [yesterday],
      )
    ).rows.map((r) => r.date);
    return {
      date,
      total: saved.total,
      ok: saved.ok,
      nok: saved.nok,
      pending: saved.pending,
      nokPercent: Number(saved.nok_percent),
      version: saved.version,
      generatedAt: saved.generated_at,
      updatedAt: saved.updated_at,
      rows: saved.nok_rows.slice((input.page - 1) * 15, input.page * 15),
      page: input.page,
      dates,
      maxDate: yesterday,
    };
  });
}
export function startReportScheduler() {
  let stopped = false,
    running: Promise<unknown> | undefined;
  const tick = () => {
    if (!stopped && !running)
      running = runReportCycle()
        .catch((e) =>
          console.error("Не удалось сформировать ежедневный отчёт:", e.message),
        )
        .finally(() => {
          running = undefined;
        });
  };
  tick();
  const timer = setInterval(tick, 60000);
  timer.unref();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  };
}
