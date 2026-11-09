import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Loader2,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  History,
  Check,
} from "lucide-react";
import {
  correctionStatuses,
  type Correction,
  type CorrectionDetail,
  type CorrectionEvent,
  type CorrectionStatus,
} from "../shared/workflow";
import { api } from "./api";
type Assignee = { id: string; name: string; role: string; assignable: boolean };
const n = (v: number | null) =>
  v === null ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
const date = (v: string) => v.split("-").reverse().join(".");
const time = (v: string) =>
  new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(new Date(v));
function Status({ value }: { value: CorrectionStatus }) {
  return (
    <span className={"correction-status " + value.toLowerCase()}>
      {correctionStatuses[value]}
    </span>
  );
}
export function Corrections({
  revision,
  onSaved,
}: {
  revision: number;
  onSaved: (message: string) => void;
}) {
  const [view, setView] = useState<"active" | "archive">("active");
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [status, setStatus] = useState(""),
    [responsible, setResponsible] = useState(""),
    [page, setPage] = useState(1),
    [data, setData] = useState<{ rows: Correction[]; total: number }>({
      rows: [],
      total: 0,
    }),
    [assignees, setAssignees] = useState<Assignee[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [exporting, setExporting] = useState(false),
    [selected, setSelected] = useState<{ id: string; history: boolean } | null>(
      null,
    ),
    [retry, setRetry] = useState(0);
  const closeModal = useCallback(() => setSelected(null), []);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);
  const params = new URLSearchParams({
    page: String(page),
    view,
    ...(debounced ? { search: debounced } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(status ? { status } : {}),
    ...(responsible ? { responsibleId: responsible } : {}),
  }).toString();
  useEffect(() => {
    const abort = new AbortController();
    setBusy(true);
    setError("");
    api<{ rows: Correction[]; total: number }>("/corrections?" + params, {
      signal: abort.signal,
    })
      .then((d) => {
        setData(d);
        if (page > 1 && !d.rows.length) setPage((p) => p - 1);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setBusy(false);
      });
    return () => abort.abort();
  }, [params, revision, retry]);
  useEffect(() => {
    const abort = new AbortController();
    api<Assignee[]>("/corrections/assignees", { signal: abort.signal })
      .then(setAssignees)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => abort.abort();
  }, [revision, retry]);
  const filter = (change: () => void) => {
    change();
    setPage(1);
  };
  async function download() {
    setExporting(true);
    try {
      const r = await fetch("/api/corrections/export?" + params);
      if (!r.ok) throw new Error((await r.json()).message);
      const url = URL.createObjectURL(await r.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = "MixControl_корректировки.xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onSaved("Экспорт корректировок подготовлен");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  return (
    <>
      <section className={"table-panel corrections-panel " + view}>
        <div className="table-panel-heading">
          <div>
            <h2>
              Корректировки <span>{data.total}</span>
            </h2>
            <p>
              ΔT &gt; 3 °C — требуется корректировка. Завершённые задачи
              находятся в архиве.
            </p>
          </div>
          <button
            className="button secondary"
            disabled={exporting || busy}
            onClick={() => void download()}
          >
            {exporting ? (
              <Loader2 size={16} className="spin" />
            ) : (
              <Download size={16} />
            )}
            Экспорт Excel
          </button>
        </div>
        <div
          className="correction-tabs"
          role="tablist"
          aria-label="Вкладки корректировок"
        >
          {(["active", "archive"] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={view === v}
              className={view === v ? "active" : ""}
              onClick={() => {
                setView(v);
                setStatus("");
                setPage(1);
                setData({ rows: [], total: 0 });
              }}
            >
              {v === "active" ? "Активные" : "Архив"}
            </button>
          ))}
        </div>
        <div className="correction-filters">
          <label className="search">
            <Search size={16} />
            <input
              aria-label="Поиск корректировки по SUP"
              placeholder="Поиск по SUP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            Дата с
            <input
              aria-label="Корректировки: дата с"
              type="date"
              value={from}
              onChange={(e) => filter(() => setFrom(e.target.value))}
            />
          </label>
          <label>
            Дата по
            <input
              aria-label="Корректировки: дата по"
              type="date"
              value={to}
              onChange={(e) => filter(() => setTo(e.target.value))}
            />
          </label>
          {view === "active" && (
            <label>
              Статус
              <select
                aria-label="Статус корректировки"
                value={status}
                onChange={(e) => filter(() => setStatus(e.target.value))}
              >
                <option value="">Все статусы</option>
                {Object.entries(correctionStatuses)
                  .filter(([v]) => v !== "DONE")
                  .map(([v, title]) => (
                    <option key={v} value={v}>
                      {title}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <label>
            Ответственный
            <select
              aria-label="Ответственный: фильтр"
              value={responsible}
              onChange={(e) => filter(() => setResponsible(e.target.value))}
            >
              <option value="">Все ответственные</option>
              <option value="none">Не назначен</option>
              {assignees.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="button secondary"
            title="Обновить корректировки"
            disabled={busy}
            onClick={() => setRetry((r) => r + 1)}
          >
            <RefreshCw size={16} />
          </button>
        </div>
        {error && (
          <div className="error-banner" role="alert">
            {error}
          </div>
        )}
        <div className="table-scroll">
          <table className="correction-table">
            <thead>
              <tr>
                <th>Дата</th>
                <th>SUP</th>
                <th>Смесь</th>
                <th>T(fact), °C</th>
                <th>T(обор), °C</th>
                <th>ΔT, °C</th>
                <th>Статус</th>
                <th>Ответственный</th>
                {view === "archive" && <th>Завершена</th>}
                <th>История</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr
                  key={r.id}
                  className="correction-row"
                  tabIndex={0}
                  aria-label={"Открыть корректировку " + r.sup}
                  onClick={() => setSelected({ id: r.id, history: false })}
                  onKeyDown={(e) => {
                    if (
                      e.target === e.currentTarget &&
                      (e.key === "Enter" || e.key === " ")
                    ) {
                      e.preventDefault();
                      setSelected({ id: r.id, history: false });
                    }
                  }}
                >
                  <td>{date(r.date)}</td>
                  <td>
                    <button
                      className="text-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelected({ id: r.id, history: false });
                      }}
                    >
                      {r.sup}
                    </button>
                  </td>
                  <td>{r.mixtureName}</td>
                  <td>{n(r.actual)}</td>
                  <td>{n(r.equipment)}</td>
                  <td
                    className={
                      r.delta !== null && r.delta > 3 ? "temp-error" : ""
                    }
                  >
                    {n(r.delta)}
                  </td>
                  <td>
                    <Status value={r.status} />
                  </td>
                  <td>{r.responsibleName ?? "Не назначен"}</td>
                  {view === "archive" && (
                    <td>{r.completedAt ? time(r.completedAt) : "—"}</td>
                  )}
                  <td>
                    <div className="row-actions">
                      <button
                        title={"История корректировки " + r.sup}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected({ id: r.id, history: true });
                        }}
                      >
                        <History size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {busy ? (
          <div className="compact-empty">
            <Loader2 size={22} className="spin" />
          </div>
        ) : (
          !data.rows.length && (
            <div className="compact-empty">Корректировки не найдены</div>
          )
        )}
        <div className="table-footer">
          <span>
            {data.total
              ? (page - 1) * 15 +
                1 +
                "–" +
                Math.min(page * 15, data.total) +
                " из " +
                data.total
              : "0"}{" "}
            корректировок
          </span>
          <div className="pagination">
            <button
              title="Предыдущая страница корректировок"
              disabled={busy || page === 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>{page}</span>
            <button
              title="Следующая страница корректировок"
              disabled={busy || page * 15 >= data.total}
              onClick={() => setPage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      </section>
      {selected && (
        <CorrectionCard
          id={selected.id}
          historyOnly={selected.history}
          revision={revision}
          assignees={assignees}
          onClose={closeModal}
          onSaved={(message) => {
            setRetry((r) => r + 1);
            onSaved(message);
          }}
        />
      )}
    </>
  );
}
function eventText(e: CorrectionEvent) {
  const a = e.after ?? {},
    b = e.before ?? {};
  const val = (r: Record<string, unknown>, key: string) =>
    r[key] === null || r[key] === undefined ? "—" : String(r[key]);
  if (e.kind === "detected")
    return (
      "Обнаружено расхождение: T(fact) " +
      val(a, "actual") +
      " °C, T(обор) " +
      val(a, "equipment") +
      " °C, ΔT " +
      val(a, "delta") +
      " °C."
    );
  if (e.kind === "measurement_changed")
    return (
      "Температуры: " +
      val(b, "actual") +
      " / " +
      val(b, "equipment") +
      " → " +
      val(a, "actual") +
      " / " +
      val(a, "equipment") +
      " °C. ΔT: " +
      val(b, "delta") +
      " → " +
      val(a, "delta") +
      " °C."
    );
  if (e.kind === "measurement_deleted")
    return "Исходная запись удалена. История корректировки сохранена.";

  const parts: string[] = [];
  if (b.status !== a.status)
    parts.push(
      "Статус: " +
        (correctionStatuses[b.status as CorrectionStatus] ?? "—") +
        " → " +
        (correctionStatuses[a.status as CorrectionStatus] ?? "—"),
    );
  if (b.responsible_id !== a.responsible_id)
    parts.push(
      "Ответственный: " +
        (b.responsible_name ?? "Не назначен") +
        " → " +
        (a.responsible_name ?? "Не назначен"),
    );
  if (b.work_done !== a.work_done)
    parts.push("Изменено описание выполненных действий");
  return parts.join(". ") || "Карточка сохранена.";
}
function CorrectionCard({
  id,
  historyOnly = false,
  revision,
  assignees,
  onClose,
  onSaved,
}: {
  id: string;
  historyOnly?: boolean;
  revision: number;
  assignees: Assignee[];
  onClose: () => void;
  onSaved: (s: string) => void;
}) {
  const [detail, setDetail] = useState<CorrectionDetail | null>(null),
    [status, setStatus] = useState<CorrectionStatus>("NOT_STARTED"),
    [responsible, setResponsible] = useState(""),
    [work, setWork] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  const root = useRef<HTMLElement>(null);
  const apply = (d: CorrectionDetail) => {
    setDetail(d);
    setStatus(d.correction.status);
    setResponsible(d.correction.responsibleId ?? "");
    setWork(d.correction.workDone);
  };
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    api<CorrectionDetail>(
      "/corrections/" + id + (historyOnly ? "/history" : ""),
      { signal: abort.signal },
    )
      .then(apply)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [id, retry, historyOnly]);
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (lastRevision.current === revision) return;
    lastRevision.current = revision;
    const abort = new AbortController();
    api<CorrectionDetail>(
      "/corrections/" + id + (historyOnly ? "/history" : ""),
      { signal: abort.signal },
    )
      .then((d) => {
        if (historyOnly) setDetail(d);
      })
      .catch((e) => {
        if (e.status === 404) onClose();
      });
    return () => abort.abort();
  }, [revision, id, historyOnly, onClose]);
  useEffect(() => {
    const old = document.body.style.overflow,
      focused = document.activeElement as HTMLElement;
    document.body.style.overflow = "hidden";
    root.current?.querySelector("button")?.focus();
    return () => {
      document.body.style.overflow = old;
      if (focused?.isConnected) focused.focus();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab") {
        const nodes = Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary",
          ) ?? [],
        );
        if (e.shiftKey && document.activeElement === nodes[0]) {
          e.preventDefault();
          nodes.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
          e.preventDefault();
          nodes[0]?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [busy, onClose]);
  const r = detail?.correction;
  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!r) return;
    setBusy(true);
    setError("");
    try {
      const d = await api<CorrectionDetail>("/corrections/" + id, {
        method: "PUT",
        body: JSON.stringify({
          status,
          responsibleId: responsible || null,
          workDone: work,
          version: r.version,
        }),
      });
      apply(d);
      onSaved("Корректировка сохранена");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function history(page: number) {
    setBusy(true);
    setError("");
    try {
      const next = await api<CorrectionDetail>(
        "/corrections/" + id + "/history?page=" + page,
      );
      setDetail((old) =>
        old
          ? {
              ...old,
              events: next.events,
              eventTotal: next.eventTotal,
              page: next.page,
            }
          : next,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <section
        ref={root}
        className={
          "modal correction-modal" +
          (historyOnly ? " correction-history-modal" : "")
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby="correction-title"
      >
        <button
          className="modal-close"
          title={historyOnly ? "Закрыть историю" : "Закрыть корректировку"}
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="correction-title">
          {historyOnly ? "История корректировки" : "Корректировка"}{" "}
          {r?.sup ?? ""}
        </h2>
        {loading && (
          <div className="compact-empty">
            <Loader2 className="spin" />
          </div>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}{" "}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => setRetry((v) => v + 1)}
            >
              Обновить карточку
            </button>
          </div>
        )}
        {r && detail && (
          <>
            <p className="modal-subtitle">
              {r.mixtureName} · {date(r.date)}
            </p>
            {!historyOnly && (
              <>
                <dl className="correction-summary">
                  <div>
                    <dt>T(fact)</dt>
                    <dd>{n(r.actual)} °C</dd>
                  </div>
                  <div>
                    <dt>T(обор)</dt>
                    <dd>{n(r.equipment)} °C</dd>
                  </div>
                  <div>
                    <dt>ΔT</dt>
                    <dd>{n(r.delta)} °C</dd>
                  </div>
                  <div>
                    <dt>Создана</dt>
                    <dd>{time(r.detectedAt)}</dd>
                  </div>
                </dl>
                <p className="workflow-note">
                  Первоначально: T(fact) {n(r.initialData.actual)} °C · T(обор){" "}
                  {n(r.initialData.equipment)} °C · ΔT {n(r.initialData.delta)}{" "}
                  °C.
                </p>
                {r.sourceDeleted && (
                  <p className="form-info">
                    Исходная запись удалена. История корректировки сохранена.
                  </p>
                )}
                <form className="correction-editor" onSubmit={save}>
                  <div className="form-grid">
                    <label>
                      <span className="correction-status-label">
                        Статус <Status value={status} />
                      </span>
                      <select
                        aria-label="Статус в карточке"
                        disabled={busy}
                        value={status}
                        onChange={(e) =>
                          setStatus(e.target.value as CorrectionStatus)
                        }
                      >
                        {Object.entries(correctionStatuses).map(([v, name]) => (
                          <option key={v} value={v}>
                            {name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Ответственный
                      <select
                        aria-label="Ответственный в карточке"
                        disabled={busy}
                        value={responsible}
                        onChange={(e) => setResponsible(e.target.value)}
                      >
                        <option value="">Не назначен</option>
                        {r.responsibleId &&
                          !assignees.some(
                            (p) => p.assignable && p.id === r.responsibleId,
                          ) && (
                            <option value={r.responsibleId}>
                              {r.responsibleName}
                            </option>
                          )}
                        {assignees
                          .filter((p) => p.assignable)
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    Что было сделано
                    <textarea
                      aria-label="Что было сделано"
                      maxLength={10000}
                      rows={4}
                      value={work}
                      disabled={busy}
                      placeholder="Опишите выполненные действия"
                      onChange={(e) => setWork(e.target.value)}
                    />
                  </label>
                  <div className="correction-save">
                    <span>
                      {r.completedAt
                        ? "Завершена " + time(r.completedAt)
                        : "Статус сохраняется после подтверждения"}
                    </span>
                    <button className="button primary" disabled={busy}>
                      {busy ? (
                        <Loader2 size={16} className="spin" />
                      ) : (
                        <Check size={16} />
                      )}
                      Сохранить
                    </button>
                  </div>
                </form>
              </>
            )}
            <section className="correction-history">
              <h3>
                История изменений <span>{detail.eventTotal}</span>
              </h3>
              {detail.events.map((e) => (
                <article key={e.id}>
                  <div>
                    <strong>{e.actorName}</strong>
                    <time>{time(e.createdAt)}</time>
                  </div>
                  <p>{eventText(e)}</p>
                  {e.kind === "updated" &&
                    e.before?.work_done !== e.after?.work_done && (
                      <details
                        className="description-diff"
                        onClick={(event) => {
                          if (
                            event.target instanceof Element &&
                            event.target.closest("summary")
                          )
                            return;
                          event.currentTarget.open = !event.currentTarget.open;
                        }}
                      >
                        <summary>
                          <ChevronRight size={15} aria-hidden="true" />
                          <span>Описание до и после</span>
                        </summary>
                        <p>До: {String(e.before?.work_done || "—")}</p>
                        <p>После: {String(e.after?.work_done || "—")}</p>
                      </details>
                    )}
                </article>
              ))}
            </section>
            {detail.eventTotal > 25 && (
              <div className="pagination history-pages">
                <button
                  title="Новые изменения"
                  disabled={busy || detail.page === 1}
                  onClick={() => void history(detail.page - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <span>
                  История: {detail.page} / {Math.ceil(detail.eventTotal / 25)}
                </span>
                <button
                  title="Старые изменения"
                  disabled={busy || detail.page * 25 >= detail.eventTotal}
                  onClick={() => void history(detail.page + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
