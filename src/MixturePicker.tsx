import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";
import { matchesMixture } from "../shared/mixture-search";
import "./mixture-picker.css";
export function MixturePicker({
  catalog,
  value,
  onChange,
  label = "Смесь",
  compact = false,
  allowAll = true,
  disabled = false,
  required = false,
}: {
  catalog: { id: string; name: string }[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  compact?: boolean;
  allowAll?: boolean;
  disabled?: boolean;
  required?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [search, setSearch] = useState(""),
    [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const options = [
    ...(allowAll ? [{ id: "", name: "Все смеси" }] : []),
    ...catalog.filter((m) => matchesMixture(m.name, search)),
  ];
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    if (open)
      root.current
        ?.querySelector('[data-option-index="' + active + '"]')
        ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);
  const choose = (next: string) => {
    if (disabled) return;
    onChange(next);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className={"mixture-picker" + (compact ? " mixture-picker-compact" : "")}
      ref={root}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <span
        className={compact ? "mixture-picker-label" : undefined}
        id={id + "-label"}
      >
        {label}
        {required && <span className="required"> *</span>}
      </span>
      <button
        ref={trigger}
        className="mixture-picker-trigger"
        type="button"
        disabled={disabled}
        role="combobox"
        aria-required={required || undefined}
        aria-labelledby={id + "-label"}
        aria-expanded={open}
        aria-controls={id + "-list"}
        aria-haspopup="listbox"
        onClick={() => {
          setOpen((v) => !v);
          setSearch("");
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setSearch("");
            setActive(0);
          }
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <span>
          {catalog.find((m) => m.id === value)?.name ??
            (allowAll ? "Все смеси" : "Выберите смесь")}
        </span>
        <ChevronDown size={16} />
      </button>
      {open && !disabled && (
        <div className="mixture-picker-popup">
          <div className="mixture-picker-search">
            <Search size={15} />
            <input
              autoFocus
              aria-label="Поиск смеси по названию"
              placeholder="Название смеси…"
              value={search}
              aria-controls={id + "-list"}
              aria-activedescendant={
                options[active] ? id + "-option-" + active : undefined
              }
              onChange={(e) => {
                setSearch(e.target.value);
                setActive(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive((n) =>
                    Math.max(0, Math.min(n + 1, options.length - 1)),
                  );
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive((n) => Math.max(0, n - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  if (options[active]) choose(options[active].id);
                } else if (e.key === "Escape") {
                  e.stopPropagation();
                  setOpen(false);
                  trigger.current?.focus();
                }
              }}
            />
          </div>
          <div role="listbox" id={id + "-list"} aria-label="Каталог смесей">
            {options.map((m, i) => (
              <button
                type="button"
                role="option"
                id={id + "-option-" + i}
                data-option-index={i}
                className={active === i ? "focused" : ""}
                aria-selected={value === m.id}
                key={m.id}
                onClick={() => choose(m.id)}
              >
                {m.name}
              </button>
            ))}
            {options.length === (allowAll ? 1 : 0) && <p>Смеси не найдены</p>}
          </div>
        </div>
      )}
    </div>
  );
}
