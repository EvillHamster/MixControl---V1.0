import { useEffect, useRef, useState } from "react";
import { Upload, Loader2, X } from "lucide-react";
import type { ImportKind, ImportPreview } from "../shared/imports";
import { api } from "./api";
export function ImportDialog({
  kind,
  onClose,
  onSaved,
}: {
  kind: ImportKind;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [preview, setPreview] = useState<ImportPreview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(1);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const focused = document.activeElement as HTMLElement,
      old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.querySelector("input")?.focus();
    return () => {
      document.body.style.overflow = old;
      focused?.focus();
    };
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
      if (e.key === "Tab") {
        const nodes = Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled)",
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
  async function upload(file?: File) {
    setPreview(null);
    setError("");
    setPage(1);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setError("Выберите файл Excel с расширением .xlsx");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Максимальный размер файла — 5 МБ");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch("/api/" + kind + "/import/preview", {
        method: "POST",
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
        body: file,
      });
      const body = await response.json();
      if (response.status === 401)
        window.dispatchEvent(new Event("mixcontrol:unauthorized"));
      if (!response.ok)
        throw new Error(body.message ?? "Не удалось проверить файл");
      setPreview(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview?.id || preview.errorCount) return;
    setBusy(true);
    setError("");
    try {
      const saved = await api<{ added: number; updated: number }>(
        "/" + kind + "/import/confirm",
        { method: "POST", body: JSON.stringify({ id: preview.id }) },
      );
      onSaved(
        "Импорт завершён: добавлено " +
          saved.added +
          ", обновлено " +
          saved.updated,
      );
    } catch (e) {
      setError((e as Error).message);
      setPreview((p) => (p ? { ...p, id: undefined } : p));
    } finally {
      setBusy(false);
    }
  }
  const errors = preview?.errors ?? [],
    rows = preview?.rows ?? [],
    items = errors.length ? errors : rows,
    count = Math.ceil(items.length / 15);
  return (
    <div className="modal-backdrop">
      <section
        ref={root}
        className="modal import-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        aria-busy={busy}
      >
        <button
          type="button"
          className="modal-close"
          title="Закрыть импорт"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
        <h2 id="import-title">
          Импорт {kind === "records" ? "журнала контроля" : "базы смесей"}
        </h2>
        <p className="modal-subtitle">
          Загрузите .xlsx, проверьте результат и подтвердите сохранение. До
          подтверждения данные не изменяются.
        </p>
        <label className="import-file">
          Файл Excel (до 5 МБ, до 5000 строк)
          <input
            type="file"
            accept=".xlsx"
            disabled={busy}
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </label>
        <p className="import-hint">
          {kind === "records"
            ? "Столбцы: Дата, SUP, Смесь, T min, T max, T(fact), Итог. T(обор) — дополнительный: при обновлении без него сохраняется прежняя температура. Итог рассчитывается по обеим температурам."
            : "Столбцы: Название смеси, T min, T max, Статус (необязательно: В работе / В архиве). Совпадение названий обновляет существующую смесь."}
        </p>
        {busy && (
          <div role="status" className="import-progress">
            <Loader2 size={18} className="spin" />
            Обработка файла…
          </div>
        )}
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        {preview && (
          <>
            <div className="import-counts">
              <span>
                Всего: <b>{preview.total}</b>
              </span>
              <span>
                Новых: <b>{preview.added}</b>
              </span>
              <span>
                Обновлений: <b>{preview.updated}</b>
              </span>
              <span>
                Ошибок: <b>{preview.errorCount}</b>
              </span>
            </div>
            {!!errors.length && (
              <p role="alert" className="form-error">
                Импорт запрещён. Исправьте указанные строки в Excel и загрузите
                файл повторно.
              </p>
            )}
            <div className="table-scroll import-preview">
              <table>
                <thead>
                  <tr>
                    <th>Строка</th>
                    {kind === "records" && <th>SUP</th>}
                    <th>Смесь из Excel</th>
                    {errors.length ? (
                      <>
                        <th>Смесь в БД</th>
                        <th>Причина</th>
                      </>
                    ) : (
                      <>
                        <th>Действие</th>
                        {kind === "records" && <th>Дата</th>}
                        <th>T min</th>
                        <th>T max</th>
                        {kind === "records" && (
                          <>
                            <th>T(fact)</th>
                            <th>T(обор)</th>
                            <th>Итог</th>
                          </>
                        )}
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {errors.length
                    ? errors.slice((page - 1) * 15, page * 15).map((r, i) => (
                        <tr key={i}>
                          <td>{r.row}</td>
                          {kind === "records" && <td>{r.sup || "—"}</td>}
                          <td>{r.mixtureExcel || "—"}</td>
                          <td>{r.mixtureDb || "—"}</td>
                          <td>{r.message}</td>
                        </tr>
                      ))
                    : rows.slice((page - 1) * 15, page * 15).map((r) => (
                        <tr key={r.row}>
                          <td>{r.row}</td>
                          {kind === "records" && <td>{r.sup}</td>}
                          <td>{r.name}</td>
                          <td>{r.operation}</td>
                          {kind === "records" && <td>{r.date}</td>}
                          <td>{r.tMin}</td>
                          <td>{r.tMax}</td>
                          {kind === "records" && (
                            <>
                              <td>{r.actual ?? "—"}</td>
                              <td>{r.equipment ?? "—"}</td>
                              <td>{r.status ?? "Ожидает"}</td>
                            </>
                          )}
                        </tr>
                      ))}
                </tbody>
              </table>
            </div>
            {count > 1 && (
              <div className="pagination import-pagination">
                <button
                  disabled={page === 1 || busy}
                  title="Предыдущие строки"
                  onClick={() => setPage(page - 1)}
                >
                  ‹
                </button>
                <span>
                  {page} / {count}
                </span>
                <button
                  disabled={page === count || busy}
                  title="Следующие строки"
                  onClick={() => setPage(page + 1)}
                >
                  ›
                </button>
              </div>
            )}
          </>
        )}
        <div className="modal-buttons">
          <button
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Отмена
          </button>
          <button
            className="button primary"
            disabled={busy || !preview?.id || !!preview.errorCount}
            onClick={() => void confirm()}
          >
            <Upload size={16} />
            Подтвердить импорт
          </button>
        </div>
      </section>
    </div>
  );
}
