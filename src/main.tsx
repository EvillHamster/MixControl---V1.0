import { MixturePicker } from "./MixturePicker";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  Database,
  BarChart3,
  Wrench,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleHelp,
  ClipboardList,
  Download,
  Upload,
  FolderArchive,
  LayoutDashboard,
  Loader2,
  LogOut,
  UsersRound,
  Pencil,
  Plus,
  Search,
  SlidersHorizontal,
  Thermometer,
  Trash2,
  X,
} from "lucide-react";
import {
  result,
  recordSchema,
  type Measurement,
  type Mixture,
} from "../shared/domain";
import "./styles.css";
import "./access.css";
import "./workflow.css";
import { api } from "./api";
import { AuthGate, useAuth } from "./auth";
import { Reports } from "./Reports";
import { Corrections } from "./Corrections";
import { Users } from "./Users";
import { ImportDialog } from "./ImportDialog";
import type { ImportKind } from "../shared/imports";
import { MixtureTable } from "./MixtureTable";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const number = (n: number | null) =>
  n === null
    ? "—"
    : new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(n);
type Data = {
  records: Measurement[];
  total: number;
  ok: number;
  nok: number;
  pending: number;
};
const emptyData: Data = { records: [], total: 0, ok: 0, nok: 0, pending: 0 };
function Badge({ status }: { status: string | null }) {
  return (
    <span className={`badge ${status ?? "pending"}`}>
      <span />
      {status ?? "Ожидает"}
    </span>
  );
}
function App() {
  const { user, logout, refresh } = useAuth();
  const canManage = user.role !== "EMPLOYEE";
  const [tab, setTab] = useState("journal"),
    [mixtures, setMixtures] = useState<Mixture[]>([]),
    [data, setData] = useState<Data>(emptyData),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [toast, setToast] = useState("");
  const [search, setSearch] = useState(""),
    [debounced, setDebounced] = useState(""),
    [mixFilter, setMixFilter] = useState(""),
    [status, setStatus] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [dateOpen, setDateOpen] = useState(false),
    [page, setPage] = useState(1),
    [sort, setSort] = useState("date"),
    [direction, setDirection] = useState("desc"),
    [revision, setRevision] = useState(0),
    [exporting, setExporting] = useState(false);
  const [recordModal, setRecordModal] = useState<
      Measurement | null | undefined
    >(undefined),
    [mixtureModal, setMixtureModal] = useState<Mixture | null | undefined>(
      undefined,
    ),
    [deletion, setDeletion] = useState<{
      type: "record" | "mixture";
      item: Measurement | Mixture;
    } | null>(null),
    [busy, setBusy] = useState(false),
    [modalError, setModalError] = useState(""),
    [help, setHelp] = useState(false);
  const [bulkDeletion, setBulkDeletion] = useState<{
    filters: Record<string, string>;
    count: number;
    fingerprint: string;
    description: string[];
  } | null>(null);
  const [correctionCount, setCorrectionCount] = useState<number | null>(null);
  useEffect(() => {
    if (!canManage) {
      setCorrectionCount(null);
      return;
    }
    const abort = new AbortController();
    api<{ active: number }>("/corrections/summary", { signal: abort.signal })
      .then((r) => setCorrectionCount(r.active))
      .catch((e) => {
        if (e.name !== "AbortError") setCorrectionCount(null);
      });
    return () => abort.abort();
  }, [revision, canManage]);
  const [importKind, setImportKind] = useState<ImportKind | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const params = new URLSearchParams({
    page: String(page),
    size: "15",
    sort,
    direction,
    ...(debounced ? { search: debounced } : {}),
    ...(mixFilter ? { mixtureId: mixFilter } : {}),
    ...(status ? { status } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }).toString();
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    Promise.all([
      api<Data>("/records?" + params),
      api<Mixture[]>(canManage ? "/mixtures" : "/mixtures/options"),
    ])
      .then(([r, m]) => {
        if (active) {
          setData(r);
          setMixtures(m);
          if (page > 1 && r.records.length === 0) setPage((p) => p - 1);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [params, revision, canManage]);
  useEffect(() => {
    const stream = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = (event: MessageEvent) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === "visible") setRevision((v) => v + 1);
        if (event.data === '"users"') void refresh().catch(() => {});
      }, 250);
    };
    const foreground = () => {
      if (document.visibilityState === "visible") {
        setRevision((v) => v + 1);
        void refresh().catch(() => {});
      }
    };
    stream.addEventListener("change", changed);
    stream.onerror = () => {
      setCorrectionCount(null);
      void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", foreground);
    return () => {
      stream.close();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(""), 4500);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const modalOpen =
    recordModal !== undefined ||
    mixtureModal !== undefined ||
    !!deletion ||
    !!bulkDeletion ||
    help;
  useEffect(() => {
    if (!modalOpen) return;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) closeModal();
      if (e.key === "Tab") {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"] button:not(:disabled),[role="dialog"] input,[role="dialog"] select,[role="dialog"] a',
          ),
        );
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", handler);
    };
  }, [modalOpen, busy]);
  function closeModal() {
    setRecordModal(undefined);
    setMixtureModal(undefined);
    setDeletion(null);
    setBulkDeletion(null);
    setHelp(false);
    setModalError("");
  }
  function saved(message: string) {
    closeModal();
    setRevision((v) => v + 1);
    setToast(message);
  }
  function filterChange(fn: () => void) {
    fn();
    setPage(1);
  }
  function changeSort(key: string) {
    setDirection(sort === key && direction === "asc" ? "desc" : "asc");
    setSort(key);
    setPage(1);
  }
  async function exportExcel(kind: ImportKind = "records") {
    setExporting(true);
    try {
      const r = await fetch("/api/" + kind + "/export?" + params);
      if (!r.ok) throw new Error((await r.json()).message);
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "MixControl_" + kind + "_" + today() + ".xlsx";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setToast("Файл Excel подготовлен");
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function previewBulkDeletion() {
    setBusy(true);
    setModalError("");
    const filters = Object.fromEntries(
      Object.entries({
        search: debounced,
        mixtureId: mixFilter,
        status,
        from,
        to,
      }).filter(([, v]) => v),
    );
    const description = [
      from ? "Дата с: " + from : "",
      to ? "Дата по: " + to : "",
      debounced ? "SUP содержит: " + debounced : "",
      mixFilter
        ? "Смесь: " +
          (mixtures.find((m) => m.id === mixFilter)?.name || mixFilter)
        : "",
      status
        ? "Результат: " + (status === "pending" ? "Ожидает данных" : status)
        : "",
    ].filter(Boolean);
    try {
      const preview = await api<{ count: number; fingerprint: string }>(
        "/records/delete-preview?" + new URLSearchParams(filters),
      );
      if (!preview.count) {
        setToast("Нет записей для удаления по выбранным фильтрам");
        return;
      }
      setBulkDeletion({ ...preview, filters, description });
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function deleteFilteredRecords() {
    if (!bulkDeletion) return;
    setBusy(true);
    setModalError("");
    try {
      const r = await api<{ deleted: number }>("/records/by-filter", {
        method: "DELETE",
        body: JSON.stringify({
          filters: bulkDeletion.filters,
          fingerprint: bulkDeletion.fingerprint,
        }),
      });
      setPage(1);
      saved("Удалено записей: " + number(r.deleted));
    } catch (e) {
      if ((e as { status?: number }).status === 409) {
        setBulkDeletion(null);
        setToast((e as Error).message);
      } else setModalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function archive(m: Mixture) {
    try {
      await api("/mixtures/" + m.id, {
        method: "PUT",
        body: JSON.stringify({ ...m, archived: !m.archived }),
      });
      setRevision((v) => v + 1);
      setToast(m.archived ? "Смесь восстановлена" : "Смесь архивирована");
    } catch (e) {
      setToast((e as Error).message);
    }
  }
  async function deleteItem() {
    if (!deletion) return;
    setBusy(true);
    setModalError("");
    try {
      await api(
        deletion.type === "record"
          ? `/records/${deletion.item.id}?version=${(deletion.item as Measurement).version}`
          : "/mixtures/" + deletion.item.id,
        { method: "DELETE" },
      );
      saved("Удалено");
    } catch (e) {
      setModalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pageTitle =
    tab === "journal"
      ? "Журнал контроля"
      : tab === "users"
        ? "Пользователи"
        : tab === "reports"
          ? "Ежедневные отчёты"
          : tab === "corrections"
            ? "Корректирующие действия"
            : "База смесей";
  const hasFilters = !!(search || mixFilter || status || from || to);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setTab("journal");
          }}
        >
          <span className="brand-icon">
            <Activity size={23} />
          </span>
          <span>
            mixcontrol<span className="brand-dot">.</span>
          </span>
        </a>
        <nav>
          <button
            className={tab === "journal" ? "active" : ""}
            onClick={() => setTab("journal")}
          >
            <LayoutDashboard size={19} />
            Журнал контроля
            <span className="nav-dot" />
          </button>
          {canManage && (
            <button
              className={tab === "mixtures" ? "active" : ""}
              onClick={() => setTab("mixtures")}
            >
              <Database size={19} />
              База смесей
            </button>
          )}
          <button
            className={tab === "reports" ? "active" : ""}
            onClick={() => setTab("reports")}
          >
            <BarChart3 size={19} />
            Ежедневные отчёты
          </button>
          {canManage && (
            <button
              className={tab === "corrections" ? "active" : ""}
              onClick={() => setTab("corrections")}
            >
              <Wrench size={19} />
              <span className="nav-caption">Корректирующие действия</span>
              {correctionCount !== null && correctionCount > 0 && (
                <span
                  className="nav-count"
                  aria-label={"Незавершённых корректировок: " + correctionCount}
                >
                  {correctionCount}
                </span>
              )}
            </button>
          )}
          {user.role !== "EMPLOYEE" && (
            <button
              className={tab === "users" ? "active" : ""}
              onClick={() => setTab("users")}
            >
              <UsersRound size={19} />
              Пользователи
            </button>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button className="help-link" onClick={() => setHelp(true)}>
            <CircleHelp size={18} />
            Как это работает
            <ArrowUpRight size={15} />
          </button>
          <div className="profile">
            <div className="profile-avatar">
              {user.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <strong>{user.name}</strong>
              <small>
                {user.role === "ADMIN"
                  ? "Администратор"
                  : user.role === "KEYUSER"
                    ? "KEYUSER"
                    : "Сотрудник"}
              </small>
            </div>
            <span className="online-dot" />
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="topbar-right">
            <span className="signed-in">
              {user.name} · {user.role}
            </span>
            <button
              title="Выйти из системы"
              className="logout-button"
              onClick={() => void logout().catch((e) => setToast(e.message))}
            >
              <LogOut size={17} />
            </button>
            <span className={`connection ${error ? "offline" : ""}`}>
              <i />
              {error ? "Нет соединения" : "Система контроля"}
            </span>
            <span className="topbar-divider" />
            <span className="header-date">
              {new Intl.DateTimeFormat("ru-RU", {
                day: "numeric",
                month: "long",
                year: "numeric",
              }).format(new Date())}
            </span>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                MIXCONTROL /{" "}
                {tab === "journal"
                  ? "TEMPERATURE LOG"
                  : tab === "users"
                    ? "TEAM & ACCESS"
                    : tab === "reports"
                      ? "DAILY REPORTS"
                      : tab === "corrections"
                        ? "CORRECTIVE ACTIONS"
                        : "MIXTURE LIBRARY"}
              </div>
              <h1>
                {pageTitle}
                <span className="heading-dot" />
              </h1>
              <p>
                {tab === "journal"
                  ? "Температурные показатели смесей. Вся история — в одном месте."
                  : tab === "users"
                    ? "Управление сотрудниками, ролями и доступом."
                    : tab === "reports"
                      ? "Статистика за день и история отклонений."
                      : tab === "corrections"
                        ? "Ответственные, выполненные работы и история изменений."
                        : "Справочник смесей и допустимые температурные диапазоны."}
              </p>
            </div>
            {(tab === "journal" || (tab === "mixtures" && canManage)) && (
              <button
                className="button primary"
                onClick={() =>
                  tab === "journal"
                    ? setRecordModal(null)
                    : setMixtureModal(null)
                }
              >
                <Plus size={18} />
                {tab === "journal" ? "Новая запись" : "Добавить смесь"}
              </button>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button onClick={() => setRevision((v) => v + 1)}>
                Повторить
              </button>
            </div>
          )}
          {tab === "journal" ? (
            <>
              <section
                className="stats-grid"
                aria-label="Сводка по выбранным данным"
              >
                {[
                  {
                    label: "Всего записей",
                    value: data.total,
                    icon: ClipboardList,
                    style: "total",
                    text: hasFilters ? "С учётом фильтров" : "За всё время",
                  },
                  {
                    label: "В пределах нормы",
                    value: data.ok,
                    icon: CheckCheck,
                    style: "good",
                    text: "Все условия соблюдены",
                  },
                  {
                    label: "Отклонения",
                    value: data.nok,
                    icon: Activity,
                    style: "bad",
                    text: "Требуют внимания",
                  },
                  {
                    label: "Ожидают данных",
                    value: data.pending,
                    icon: Thermometer,
                    style: "waiting",
                    text: "Измерения не завершены",
                  },
                ].map((s) => (
                  <article className={"stat " + s.style} key={s.style}>
                    <div className="stat-title">
                      {s.label}
                      <s.icon size={18} />
                    </div>
                    <div className="stat-value">
                      {loading ? "—" : number(s.value)}
                      <span>
                        {s.style === "good"
                          ? "OK"
                          : s.style === "bad"
                            ? "NOK"
                            : ""}
                      </span>
                    </div>
                    <div className="stat-description">
                      <i />
                      {s.text}
                    </div>
                  </article>
                ))}
              </section>
              <section className="table-panel">
                <div className="table-panel-heading">
                  <div>
                    <h2>
                      Записи измерений <span>{data.total}</span>
                    </h2>
                    <p>
                      Контролируйте фактические температуры и соответствие
                      нормам
                    </p>
                  </div>
                  {canManage && (
                    <div className="transfer-actions">
                      <button
                        className="button secondary"
                        onClick={() => setImportKind("records")}
                      >
                        <Upload size={16} />
                        Импорт
                      </button>
                      <button
                        className="button secondary export"
                        onClick={() => void exportExcel()}
                        disabled={exporting || loading || !!error}
                      >
                        {exporting ? (
                          <Loader2 className="spin" size={16} />
                        ) : (
                          <Download size={16} />
                        )}
                        Экспорт в Excel
                      </button>
                      <button
                        className="button secondary"
                        onClick={() => void previewBulkDeletion()}
                        disabled={
                          busy ||
                          loading ||
                          !!error ||
                          !hasFilters ||
                          !data.total ||
                          search !== debounced
                        }
                        title={
                          hasFilters
                            ? "Удалить все записи по выбранным фильтрам, со всех страниц"
                            : "Сначала выберите даты или другие фильтры"
                        }
                      >
                        <Trash2 size={16} />
                        Удалить по фильтрам
                      </button>
                    </div>
                  )}
                </div>
                <div className="filter-bar">
                  <label className="search">
                    <Search size={17} />
                    <input
                      placeholder="Поиск по SUP..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      aria-label="Поиск по SUP"
                    />
                    {search && (
                      <button
                        title="Очистить поиск"
                        onClick={() => setSearch("")}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                  <div className="filter-controls">
                    <div className="date-filter">
                      <button
                        className={
                          "filter-button " + (from || to ? "selected" : "")
                        }
                        onClick={() => setDateOpen(!dateOpen)}
                      >
                        <SlidersHorizontal size={15} />
                        {from || to ? "Период выбран" : "Все даты"}
                        <ChevronDown size={13} />
                      </button>
                      {dateOpen && (
                        <div className="date-popover">
                          <label>
                            С даты
                            <input
                              type="date"
                              value={from}
                              max={to || undefined}
                              onChange={(e) =>
                                filterChange(() => setFrom(e.target.value))
                              }
                            />
                          </label>
                          <label>
                            По дату
                            <input
                              type="date"
                              value={to}
                              min={from || undefined}
                              onChange={(e) =>
                                filterChange(() => setTo(e.target.value))
                              }
                            />
                          </label>
                          <button
                            className="button primary"
                            onClick={() => setDateOpen(false)}
                          >
                            Применить
                          </button>
                        </div>
                      )}
                    </div>
                    <MixturePicker
                      compact
                      label="Фильтр по смеси"
                      catalog={mixtures.map((m) => ({
                        id: m.id,
                        name: m.name + (m.archived ? " (архив)" : ""),
                      }))}
                      value={mixFilter}
                      onChange={(id) => filterChange(() => setMixFilter(id))}
                    />
                    <select
                      aria-label="Фильтр по результату"
                      value={status}
                      onChange={(e) =>
                        filterChange(() => setStatus(e.target.value))
                      }
                    >
                      <option value="">Все результаты</option>
                      <option value="OK">OK — в норме</option>
                      <option value="NOK">NOK — отклонение</option>
                      <option value="pending">Ожидает данных</option>
                    </select>
                    {hasFilters && (
                      <button
                        className="reset-filters"
                        title="Сбросить фильтры"
                        onClick={() => {
                          setSearch("");
                          setMixFilter("");
                          setStatus("");
                          setFrom("");
                          setTo("");
                          setPage(1);
                        }}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="table-scroll">
                  <table className="measurement-table">
                    <thead>
                      <tr>
                        {[
                          { key: "date", label: "Дата" },
                          { key: "sup", label: "SUP" },
                          { key: "mixtureName", label: "Смесь" },
                          { key: "tMin", label: "T min", unit: true },
                          { key: "tMax", label: "T max", unit: true },
                          { key: "actual", label: "T(fact)", unit: true },
                          { key: "equipment", label: "T(обор)", unit: true },
                          { key: "status", label: "Итог" },
                        ].map((h) => (
                          <th key={h.key}>
                            <button onClick={() => changeSort(h.key)}>
                              {h.label}
                              {h.unit && <span className="unit">°C</span>}
                              {sort === h.key ? (
                                direction === "asc" ? (
                                  <ArrowUp size={12} />
                                ) : (
                                  <ArrowDown size={12} />
                                )
                              ) : (
                                <ChevronsUpDown size={12} />
                              )}
                            </button>
                          </th>
                        ))}
                        <th className="actions-th" />
                      </tr>
                    </thead>
                    <tbody>
                      {!loading &&
                        data.records.map((r) => (
                          <tr
                            key={r.id}
                            className={r.status === "NOK" ? "row-nok" : ""}
                          >
                            <td className="date-cell">
                              {r.date.split("-").reverse().join(".")}
                            </td>
                            <td className="sup-cell">
                              <button
                                disabled={!canManage}
                                title={
                                  r.authorName
                                    ? `Автор: ${r.authorName}`
                                    : "Историческая запись"
                                }
                                onClick={() => canManage && setRecordModal(r)}
                              >
                                {r.sup}
                              </button>
                            </td>
                            <td>
                              <span className="mixture-cell">
                                {r.mixtureName}
                              </span>
                            </td>
                            <td className="norm">{number(r.tMin)}</td>
                            <td className="norm">{number(r.tMax)}</td>
                            <td
                              className={
                                r.status === "NOK" ? "temp-error" : "fact"
                              }
                              title={
                                r.legacyPending
                                  ? `Старые значения: ${number(r.actualMin)} / ${number(r.actualMax)} °C. Требуется согласование переноса.`
                                  : undefined
                              }
                            >
                              {r.legacyPending
                                ? "На переносе"
                                : number(r.actual)}
                            </td>
                            <td
                              className={
                                r.equipment !== null &&
                                (r.equipment < r.tMin || r.equipment > r.tMax)
                                  ? "temp-error"
                                  : "fact"
                              }
                            >
                              {number(r.equipment)}
                            </td>
                            <td>
                              <Badge status={r.status} />
                            </td>
                            <td>
                              <div className="row-actions">
                                {canManage && (
                                  <button
                                    title="Редактировать запись"
                                    onClick={() =>
                                      canManage && setRecordModal(r)
                                    }
                                  >
                                    <Pencil size={14} />
                                  </button>
                                )}
                                {canManage && (
                                  <button
                                    title="Удалить запись"
                                    onClick={() =>
                                      setDeletion({ type: "record", item: r })
                                    }
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {loading ? (
                  <div className="empty-state">
                    <Loader2 className="spin" size={27} />
                    <h3>Загружаем измерения</h3>
                  </div>
                ) : !data.records.length ? (
                  <div className="empty-state">
                    <span className="empty-icon">
                      <ClipboardList size={27} />
                    </span>
                    <h3>
                      {error
                        ? "Не удалось загрузить журнал"
                        : hasFilters
                          ? "Записи не найдены"
                          : "Начните с первого измерения"}
                    </h3>
                    <p>
                      {error
                        ? "Проверьте подключение и повторите запрос."
                        : hasFilters
                          ? "Попробуйте изменить параметры фильтра."
                          : "Добавьте смесь в справочник и создайте запись контроля."}
                    </p>
                    {!hasFilters &&
                      !error &&
                      (canManage || mixtures.some((m) => !m.archived)) && (
                        <button
                          className="button secondary"
                          onClick={() =>
                            mixtures.some((m) => !m.archived)
                              ? setRecordModal(null)
                              : setMixtureModal(null)
                          }
                        >
                          <Plus size={16} />
                          {mixtures.some((m) => !m.archived)
                            ? "Добавить запись"
                            : "Добавить первую смесь"}
                        </button>
                      )}
                  </div>
                ) : null}
                <div className="table-footer">
                  <span>
                    {data.total
                      ? `${(page - 1) * 15 + 1}–${Math.min(page * 15, data.total)} из ${data.total} записей`
                      : "0 записей"}
                  </span>
                  <div className="pagination">
                    <span>По 15 на странице</span>
                    <button
                      title="Предыдущая страница"
                      disabled={page === 1 || loading}
                      onClick={() => setPage((p) => p - 1)}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span className="page-number">{page}</span>
                    <button
                      title="Следующая страница"
                      disabled={page * 15 >= data.total || loading}
                      onClick={() => setPage((p) => p + 1)}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </section>
              <div className="journal-note">
                <span>
                  <span className="lock-dot" />
                  Нормативы сохраняются на момент создания записи
                </span>
                <span>Все температуры указаны в °C</span>
              </div>
            </>
          ) : tab === "reports" ? (
            <Reports revision={revision} />
          ) : tab === "corrections" && canManage ? (
            <Corrections
              revision={revision}
              onSaved={(message) => {
                setRevision((v) => v + 1);
                setToast(message);
              }}
            />
          ) : tab === "users" ? (
            <Users revision={revision} onSaved={saved} />
          ) : (
            <>
              <div className="transfer-actions mixture-transfers">
                <button
                  className="button secondary"
                  onClick={() => setImportKind("mixtures")}
                >
                  <Upload size={16} />
                  Импорт
                </button>
                <button
                  className="button secondary"
                  disabled={exporting}
                  onClick={() => void exportExcel("mixtures")}
                >
                  <Download size={16} />
                  Экспорт
                </button>
              </div>
              <MixtureTable
                mixtures={mixtures}
                onEdit={setMixtureModal}
                onArchive={archive}
                onDelete={(m) => setDeletion({ type: "mixture", item: m })}
              />
              <div className="library-note">
                <CircleHelp size={18} />
                <p>
                  Изменения нормативов применяются только к новым записям.
                  Исторические значения остаются прежними. Архивные смеси
                  доступны в истории, но не для новых измерений.
                </p>
              </div>
            </>
          )}
        </main>
      </div>
      {importKind && (
        <ImportDialog
          kind={importKind}
          onClose={() => setImportKind(null)}
          onSaved={(message) => {
            setImportKind(null);
            setPage(1);
            saved(message);
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
          <button title="Закрыть уведомление" onClick={() => setToast("")}>
            <X size={15} />
          </button>
        </div>
      )}
      {modalOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !busy) closeModal();
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
          >
            <button
              className="modal-close"
              title="Закрыть"
              disabled={busy}
              onClick={closeModal}
            >
              <X size={20} />
            </button>
            {recordModal !== undefined ? (
              <RecordForm
                record={recordModal}
                mixtures={mixtures}
                onSave={(message) => {
                  if (recordModal === null) {
                    setSearch("");
                    setDebounced("");
                    setMixFilter("");
                    setStatus("");
                    setFrom("");
                    setTo("");
                    setPage(1);
                    setSort("date");
                    setDirection("desc");
                  }
                  saved(message);
                }}
                onClose={closeModal}
                setBusy={setBusy}
              />
            ) : mixtureModal !== undefined ? (
              <MixtureForm
                mixture={mixtureModal}
                onSave={saved}
                onClose={closeModal}
                setBusy={setBusy}
              />
            ) : bulkDeletion ? (
              <>
                <span className="delete-symbol">
                  <Trash2 size={25} />
                </span>
                <h2 id="modal-title">Удалить записи по фильтрам?</h2>
                <p className="modal-subtitle">
                  Будет удалено записей:{" "}
                  <strong>{number(bulkDeletion.count)}</strong> — со всех
                  страниц, соответствующих указанным фильтрам.
                </p>
                <ul>
                  {bulkDeletion.description.map((text) => (
                    <li key={text}>{text}</li>
                  ))}
                </ul>
                <p className="modal-subtitle">
                  Связанные корректировки, включая архивные, тоже будут удалены.
                  Удаление необратимо. При необходимости сначала экспортируйте
                  данные в Excel.
                </p>
                {modalError && (
                  <div className="form-error" role="alert">
                    {modalError}
                  </div>
                )}
                <div className="modal-buttons">
                  <button
                    className="button secondary"
                    onClick={closeModal}
                    disabled={busy}
                  >
                    Отмена
                  </button>
                  <button
                    className="button danger"
                    onClick={() => void deleteFilteredRecords()}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="spin" size={16} />
                    ) : (
                      <Trash2 size={16} />
                    )}
                    Удалить {number(bulkDeletion.count)} записей
                  </button>
                </div>
              </>
            ) : deletion ? (
              <>
                <span className="delete-symbol">
                  <Trash2 size={25} />
                </span>
                <h2 id="modal-title">
                  Удалить {deletion.type === "record" ? "запись" : "смесь"}?
                </h2>
                <p className="modal-subtitle">
                  {deletion.type === "record"
                    ? `Запись SUP ${(deletion.item as Measurement).sup} будет удалена без возможности восстановления.`
                    : `Смесь «${(deletion.item as Mixture).name}» будет удалена. Если она используется в журнале, доступно только архивирование.`}
                </p>
                {modalError && (
                  <div className="form-error" role="alert">
                    {modalError}
                  </div>
                )}
                <div className="modal-buttons">
                  <button
                    className="button secondary"
                    onClick={closeModal}
                    disabled={busy}
                  >
                    Отмена
                  </button>
                  <button
                    className="button danger"
                    onClick={deleteItem}
                    disabled={busy}
                  >
                    {busy ? (
                      <Loader2 className="spin" size={16} />
                    ) : (
                      <Trash2 size={16} />
                    )}
                    Удалить
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="large-flask">
                  <Thermometer size={26} />
                </span>
                <h2 id="modal-title">Контроль температур</h2>
                <p className="modal-subtitle">
                  Добавьте смеси и нормативы в раздел «База смесей». Затем
                  создайте запись с уникальным SUP и введите фактические
                  температуры.
                </p>
                <div className="help-rules">
                  <Badge status="OK" />
                  <p>
                    T(fact) и T(обор) находятся в допустимом диапазоне T min — T
                    max.
                  </p>
                  <Badge status="NOK" />
                  <p>Хотя бы одна из температур вышла за допустимые пределы.</p>
                  <Badge status={null} />
                  <p>Одна или обе фактические температуры ещё не введены.</p>
                </div>
                <button className="button primary full" onClick={closeModal}>
                  Понятно
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
function RecordForm({
  record,
  mixtures,
  onSave,
  onClose,
  setBusy,
}: {
  record: Measurement | null;
  mixtures: Mixture[];
  onSave: (message: string) => void;
  onClose: () => void;
  setBusy: (v: boolean) => void;
}) {
  const [sup, setSup] = useState(record?.sup ?? ""),
    [mixtureId, setMixtureId] = useState(record?.mixtureId ?? ""),
    [fact, setFact] = useState(record?.actual?.toString() ?? ""),
    [equipmentText, setEquipmentText] = useState(
      record?.equipment?.toString() ?? "",
    ),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false),
    [supState, setSupState] = useState<
      "idle" | "checking" | "valid" | "duplicate" | "error"
    >("idle");
  const mix = mixtures.find((m) => m.id === mixtureId);
  const norm = record && record.mixtureId === mixtureId ? record : mix;
  const actual = fact === "" ? null : Number(fact);
  const equipment = equipmentText === "" ? null : Number(equipmentText);
  const { user } = useAuth();
  const canManage = user.role !== "EMPLOYEE";
  const foreignRecord = !!record && user.role === "EMPLOYEE";
  const lockFact = !!record && user.role === "EMPLOYEE";
  const status =
    canManage && norm && norm.tMin !== null && norm.tMax !== null
      ? result(norm.tMin, norm.tMax, actual, equipment)
      : null;
  useEffect(() => {
    if (!/^[0-9]{7}$/.test(sup)) {
      setSupState("idle");
      return;
    }
    const controller = new AbortController();
    setSupState("checking");
    const t = setTimeout(() => {
      api<{ available: boolean }>(
        `/records/check-sup?sup=${encodeURIComponent(sup.trim())}${record ? "&exclude=" + record.id : ""}`,
        { signal: controller.signal },
      )
        .then((v) => setSupState(v.available ? "valid" : "duplicate"))
        .catch((e) => {
          if (e.name !== "AbortError") setSupState("error");
        });
    }, 350);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [sup, record?.id]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);
    setBusy(true);
    try {
      if (
        Array.from(
          (
            e.currentTarget as HTMLFormElement
          ).querySelectorAll<HTMLInputElement>('input[type="number"]'),
        ).some((input) => input.validity.badInput)
      )
        throw new Error("Введите корректные числовые значения температур");
      const parsed = recordSchema.safeParse({
        sup,
        mixtureId,
        actual,
        equipment,
        version: record?.version,
      });
      if (!/^[0-9]{7}$/.test(sup))
        throw new Error("SUP должен содержать ровно 7 цифр");
      if (!mixtureId) throw new Error("Выберите смесь");
      if (!parsed.success) throw new Error(parsed.error.issues[0].message);
      const check = await api<{ available: boolean }>(
        `/records/check-sup?sup=${encodeURIComponent(sup.trim())}${record ? "&exclude=" + record.id : ""}`,
      );
      if (!check.available) {
        setSupState("duplicate");
        throw new Error(
          "SUP уже существует. Введите уникальный идентификатор.",
        );
      }
      const savedRecord = await api<Measurement>(
        record ? "/records/" + record.id : "/records",
        {
          method: record ? "PUT" : "POST",
          body: JSON.stringify({
            sup,
            mixtureId,
            actual,
            equipment,
            version: record?.version,
          }),
        },
      );
      onSave(
        `${record ? "Запись обновлена" : "Запись добавлена"} · ${savedRecord.status ?? "Ожидает данных"}`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }
  return (
    <form className="record-form" noValidate onSubmit={submit}>
      <div className="modal-icon">
        <ClipboardList size={22} />
      </div>
      <h2 id="modal-title">
        {record ? "Редактировать запись" : "Новое измерение"}
      </h2>
      <p className="modal-subtitle">
        {canManage
          ? "Нормативы подставятся после выбора смеси."
          : "Укажите SUP, смесь, T(fact) и T(обор)."}
      </p>
      <div className="form-grid">
        <label className="span-2">
          SUP <span className="required">*</span>
          <input
            autoFocus
            disabled={foreignRecord}
            required
            type="text"
            inputMode="numeric"
            pattern="[0-9]{7}"
            minLength={7}
            maxLength={7}
            value={sup}
            onChange={(e) => setSup(e.target.value)}
            placeholder="Например, 0123456"
            className={supState === "duplicate" ? "invalid" : ""}
          />
          <small className={"sup-feedback " + supState}>
            {supState === "checking"
              ? "Проверяем уникальность…"
              : supState === "duplicate"
                ? "Этот SUP уже существует"
                : supState === "valid"
                  ? "SUP доступен"
                  : supState === "error"
                    ? "Проверим SUP при сохранении"
                    : "Ровно 7 цифр, включая ведущие нули"}
          </small>
        </label>
        <label className="span-2">
          Смесь <span className="required">*</span>
          <select
            disabled={foreignRecord}
            required
            value={mixtureId}
            onChange={(e) => setMixtureId(e.target.value)}
          >
            <option value="">Выберите смесь</option>
            {mixtures
              .filter((m) => !m.archived || m.id === record?.mixtureId)
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.archived ? " (архив)" : ""}
                </option>
              ))}
          </select>
          {!mixtures.some((m) => !m.archived) && !record && (
            <small>Сначала добавьте смесь в раздел «База смесей».</small>
          )}
        </label>
      </div>
      {canManage && (
        <div className="norm-preview">
          <span>Допустимый диапазон</span>
          <strong>
            {norm
              ? `${number(norm.tMin)} — ${number(norm.tMax)} °C`
              : "Выберите смесь"}
          </strong>
          {record && record.mixtureId === mixtureId && (
            <small>Сохранённые нормативы записи</small>
          )}
        </div>
      )}
      {record?.legacyPending && (
        <div className="form-info">
          Старые значения: {number(record.actualMin)} /{" "}
          {number(record.actualMax)} °C. Они сохранены без изменений. Единое
          значение укажите после согласования переноса.
        </div>
      )}
      <div className="form-grid temperature-fields">
        <label>
          T(fact), °C
          <input
            type="number"
            min="-273.15"
            max="10000"
            step="any"
            disabled={lockFact}
            placeholder="Не введено"
            value={fact}
            onChange={(e) => setFact(e.target.value)}
          />
          {lockFact && (
            <small>
              Изменение сохранённой температуры доступно ADMIN и KEYUSER.
            </small>
          )}
        </label>
        <label>
          T(обор), °C
          <input
            type="number"
            min="-273.15"
            max="10000"
            step="any"
            disabled={lockFact}
            placeholder="Не введено"
            value={equipmentText}
            onChange={(e) => setEquipmentText(e.target.value)}
          />
        </label>
      </div>
      {canManage ? (
        <div className="result-preview">
          <div>
            <strong>Результат проверки</strong>
            <small>
              {status === "NOK"
                ? "Температура вне допустимого диапазона"
                : status === "OK"
                  ? "Все температурные условия соблюдены"
                  : "Введите обе температуры"}
            </small>
          </div>
          <Badge status={status} />
        </div>
      ) : (
        <div className="form-info">
          <CircleHelp size={17} />
          <span>
            Введите результаты измерения. Проверка OK/NOK будет выполнена
            сервером после сохранения.
          </span>
        </div>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-buttons">
        <button
          className="button secondary"
          type="button"
          disabled={saving}
          onClick={onClose}
        >
          Отмена
        </button>
        <button className="button primary" disabled={saving}>
          {saving ? (
            <Loader2 className="spin" size={16} />
          ) : (
            <Check size={16} />
          )}
          Сохранить запись
        </button>
      </div>
    </form>
  );
}
function MixtureForm({
  mixture,
  onSave,
  onClose,
  setBusy,
}: {
  mixture: Mixture | null;
  onSave: (s: string) => void;
  onClose: () => void;
  setBusy: (v: boolean) => void;
}) {
  const [name, setName] = useState(mixture?.name ?? ""),
    [min, setMin] = useState(mixture?.tMin?.toString() ?? ""),
    [max, setMax] = useState(mixture?.tMax?.toString() ?? ""),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (Number(min) > Number(max)) {
      setError("T min не может превышать T max");
      return;
    }
    setSaving(true);
    setBusy(true);
    try {
      await api(mixture ? "/mixtures/" + mixture.id : "/mixtures", {
        method: mixture ? "PUT" : "POST",
        body: JSON.stringify({
          name,
          tMin: Number(min),
          tMax: Number(max),
          archived: mixture?.archived ?? false,
        }),
      });
      onSave(mixture ? "Смесь обновлена" : "Смесь добавлена");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <h2 id="modal-title">
        {mixture ? "Редактировать смесь" : "Новая смесь"}
      </h2>
      <p className="modal-subtitle">
        Задайте название и допустимые температурные нормы.
      </p>
      <label>
        Название смеси <span className="required">*</span>
        <input
          autoFocus
          required
          maxLength={120}
          placeholder="Например, Смесь M-120"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="form-grid">
        <label>
          T min, °C
          <input
            required
            type="number"
            step="any"
            min="-273.15"
            max="10000"
            value={min}
            onChange={(e) => setMin(e.target.value)}
            placeholder="Минимум"
          />
        </label>
        <label>
          T max, °C
          <input
            required
            type="number"
            step="any"
            min="-273.15"
            max="10000"
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="Максимум"
          />
        </label>
      </div>
      <div className="form-info">
        <CircleHelp size={17} />
        <span>
          Существующие записи сохранят первоначальные нормативы и результаты
          проверок.
        </span>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-buttons">
        <button
          className="button secondary"
          type="button"
          onClick={onClose}
          disabled={saving}
        >
          Отмена
        </button>
        <button className="button primary" disabled={saving}>
          {saving ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <Check size={16} />
          )}
          Сохранить смесь
        </button>
      </div>
    </form>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
