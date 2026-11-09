import { useEffect, useId, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
const display = (date: string) => date.split("-").reverse().join(".");
export function ReportHistory({
  dates,
  value,
  onChange,
}: {
  dates: string[];
  value: string;
  onChange: (date: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [month, setMonth] = useState("");
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const allowed = new Set(dates),
    months = [...new Set(dates.map((d) => d.slice(0, 7)))].sort();
  const current = month || value.slice(0, 7) || months.at(-1) || "";
  const [year, mon] = current.split("-").map(Number);
  const offset = current ? (new Date(year, mon - 1, 1).getDay() + 6) % 7 : 0;
  const count = current ? new Date(year, mon, 0).getDate() : 0;
  const shift = (delta: number) => {
    const d = new Date(year, mon - 1 + delta, 1);
    setMonth(d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0"));
  };
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return (
    <div
      className="report-history"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          setOpen(false);
          trigger.current?.focus();
        }
      }}
      onBlur={(e) => {
        if (
          e.relatedTarget &&
          !e.currentTarget.contains(e.relatedTarget as Node)
        )
          setOpen(false);
      }}
    >
      <span id={id + "-label"}>История</span>
      <button
        type="button"
        className="report-history-trigger"
        aria-labelledby={id + "-label"}
        aria-expanded={open}
        aria-controls={id + "-calendar"}
        aria-haspopup="dialog"
        ref={trigger}
        onClick={() => {
          if (!open)
            setMonth(
              allowed.has(value)
                ? value.slice(0, 7)
                : months.at(-1) || value.slice(0, 7),
            );
          setOpen((v) => !v);
        }}
      >
        <span>{value ? display(value) : "Выберите дату"}</span>
        <CalendarDays size={16} />
      </button>
      {open && (
        <div
          id={id + "-calendar"}
          className="report-history-calendar"
          role="dialog"
          aria-label="Календарь истории отчётов"
        >
          {months.length ? (
            <>
              <div className="report-history-month">
                <button
                  type="button"
                  aria-label="Предыдущий месяц истории"
                  disabled={current <= months[0]}
                  onClick={() => shift(-1)}
                >
                  <ChevronLeft size={17} />
                </button>
                <select
                  aria-label="Месяц истории"
                  value={current}
                  onChange={(e) => setMonth(e.target.value)}
                >
                  {[...new Set([...months, current])].sort().map((m) => (
                    <option key={m} value={m}>
                      {new Date(
                        Number(m.slice(0, 4)),
                        Number(m.slice(5)) - 1,
                        1,
                      ).toLocaleDateString("ru-RU", {
                        month: "long",
                        year: "numeric",
                      })}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  aria-label="Следующий месяц истории"
                  disabled={current >= months.at(-1)!}
                  onClick={() => shift(1)}
                >
                  <ChevronRight size={17} />
                </button>
              </div>
              <div className="report-history-days">
                {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((d) => (
                  <span key={d}>{d}</span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <span key={"empty" + i} />
                ))}
                {Array.from({ length: count }, (_, i) => {
                  const day = current + "-" + String(i + 1).padStart(2, "0");
                  return (
                    <button
                      key={day}
                      type="button"
                      disabled={!allowed.has(day)}
                      aria-label={"Отчёт за " + display(day)}
                      aria-pressed={day === value}
                      title={
                        allowed.has(day) ? "Открыть отчёт" : "Нет измерений"
                      }
                      onClick={() => {
                        onChange(day);
                        setOpen(false);
                        trigger.current?.focus();
                      }}
                    >
                      {i + 1}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <p>Нет дат с измерениями</p>
          )}
        </div>
      )}
    </div>
  );
}
