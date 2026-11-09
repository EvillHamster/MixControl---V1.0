import { ReportHistory } from "./ReportHistory";
import { useEffect, useState } from "react";
import { Loader2, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { DailyReport } from "../shared/workflow";
import { api } from "./api";
const n = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
export function Reports({ revision }: { revision: number }) {
  const [date, setDate] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<DailyReport | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError("");
    const params = new URLSearchParams({
      page: String(page),
      ...(date ? { date } : {}),
    });
    api<DailyReport>("/reports?" + params, { signal: abort.signal })
      .then((r) => {
        setData(r);
        if (page > 1 && !r.rows.length) setPage((p) => p - 1);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [date, page, revision, retry]);
  const choose = (v: string) => {
    setDate(v);
    setPage(1);
  };
  return (
    <section className="report-section" aria-busy={busy}>
      <div className="table-panel report-controls">
        <div className="table-panel-heading">
          <div>
            <h2>Ежедневный отчёт</h2>
            <p>За завершённый календарный день · московское время</p>
          </div>
          <div className="workflow-controls">
            <label>
              Дата
              <input
                type="date"
                aria-label="Дата отчёта"
                value={date || data?.date || ""}
                max={data?.maxDate}
                onChange={(e) => choose(e.target.value)}
              />
            </label>
            <ReportHistory
              dates={data?.dates ?? []}
              value={date || data?.date || ""}
              onChange={choose}
            />
            <button
              className="button secondary"
              title="Обновить отчёт"
              disabled={busy}
              onClick={() => setRetry((v) => v + 1)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-banner">
          {error}
        </div>
      )}
      {data && (
        <>
          <div className="stats-grid report-stats">
            {[
              ["Всего измерений", String(data.total), "total"],
              ["В пределах нормы", String(data.ok), "good"],
              ["Отклонения NOK", String(data.nok), "bad"],
              [
                "Доля NOK",
                data.nokPercent.toLocaleString("ru-RU", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }) + "%",
                "waiting",
              ],
            ].map(([label, value, kind]) => (
              <article className={"stat " + kind} key={label}>
                <div className="stat-title">{label}</div>
                <div className="stat-value">{value}</div>
              </article>
            ))}
          </div>
          <section className="table-panel">
            <div className="table-panel-heading">
              <div>
                <h2>
                  Измерения NOK <span>{data.nok}</span>
                </h2>
                <p>
                  Отклонение хотя бы одной температуры от сохранённых нормативов
                </p>
              </div>
              {busy && (
                <Loader2
                  size={20}
                  className="spin"
                  aria-label="Обновляем отчёт"
                />
              )}
            </div>
            <div className="table-scroll">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>SUP</th>
                    <th>Смесь</th>
                    <th>T min, °C</th>
                    <th>T max, °C</th>
                    <th>T(fact), °C</th>
                    <th>Отклонение</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.date.split("-").reverse().join(".")}</td>
                      <td>{r.sup}</td>
                      <td>{r.mixtureName}</td>
                      <td>{n(r.tMin)}</td>
                      <td>{n(r.tMax)}</td>
                      <td>{n(r.actual)}</td>
                      <td className="deviation">{r.deviation}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.rows.length && (
              <div className="compact-empty">
                {data.total
                  ? "За этот день отклонений NOK нет"
                  : "За этот день измерений нет"}
              </div>
            )}
            <div className="table-footer">
              <span>
                {data.nok
                  ? (page - 1) * 15 +
                    1 +
                    "–" +
                    Math.min(page * 15, data.nok) +
                    " из " +
                    data.nok
                  : "0"}{" "}
                записей NOK
              </span>
              <div className="pagination">
                <button
                  title="Предыдущая страница NOK"
                  disabled={busy || page === 1}
                  onClick={() => setPage(page - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <span>{page}</span>
                <button
                  title="Следующая страница NOK"
                  disabled={busy || page * 15 >= data.nok}
                  onClick={() => setPage(page + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </section>
          <p className="workflow-note">
            NOK / все измерения × 100. Ожидают данных: {data.pending}. Версия
            отчёта: {data.version}. Обновлён{" "}
            {new Intl.DateTimeFormat("ru-RU", {
              timeZone: "Europe/Moscow",
              dateStyle: "short",
              timeStyle: "medium",
            }).format(new Date(data.updatedAt))}
            .
          </p>
        </>
      )}
      {!data && busy && (
        <div className="empty-state">
          <Loader2 className="spin" />
          <p>Формируем отчёт</p>
        </div>
      )}
    </section>
  );
}
