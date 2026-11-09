import { useEffect, useState } from "react";
import {
  Check,
  Trash2,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react";
import type { Role, User } from "../shared/domain";
import { useAuth } from "./auth";
import { canManageAccount } from "../shared/permissions";
import { api } from "./api";
export function Users({
  revision,
  onSaved,
}: {
  revision: number;
  onSaved: (message: string) => void;
}) {
  const { user: actor } = useAuth();
  const canManage = actor.role !== "EMPLOYEE";
  const [users, setUsers] = useState<User[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [editing, setEditing] = useState<User | null | undefined>();
  const [deleting, setDeleting] = useState<User | null>(null),
    [deletingBusy, setDeletingBusy] = useState(false),
    [deleteError, setDeleteError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<User[]>("/users", { signal: controller.signal })
      .then(setUsers)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (editing === undefined && !deleting) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !deletingBusy) {
        setEditing(undefined);
        setDeleting(null);
      }
      if (e.key === "Tab") {
        const elements = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="dialog"] button:not(:disabled),[role="dialog"] input,[role="dialog"] select',
          ),
        );
        const first = elements[0],
          last = elements[elements.length - 1];
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
    return () => document.removeEventListener("keydown", handler);
  }, [editing, deleting, deletingBusy]);
  return (
    <>
      <section className="table-panel">
        <div className="table-panel-heading">
          <div>
            <h2>
              Команда <span>{users.length}</span>
            </h2>
            <p>Персональные учётные записи и права доступа</p>
          </div>
          {canManage && (
            <button className="button primary" onClick={() => setEditing(null)}>
              <Plus size={17} />
              Добавить пользователя
            </button>
          )}
        </div>
        <div className="filter-bar">
          <label className="search">
            <Search size={17} />
            <input
              aria-label="Поиск пользователя"
              placeholder="Имя или логин"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Логин</th>
                <th>Роль</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users
                .filter((u) =>
                  `${u.name} ${u.login}`
                    .toLowerCase()
                    .includes(search.toLowerCase()),
                )
                .map((u) => (
                  <tr key={u.id}>
                    <td>
                      <span className="mixture-cell">
                        <UserRound size={16} />
                        {u.name}
                      </span>
                    </td>
                    <td>{u.login}</td>
                    <td>
                      {u.role === "ADMIN" ? (
                        <span className="role-label">
                          <ShieldCheck size={14} />
                          Администратор
                        </span>
                      ) : u.role === "KEYUSER" ? (
                        "KEYUSER"
                      ) : (
                        "Сотрудник"
                      )}
                    </td>
                    <td>
                      <span
                        className={"library-status " + (u.active ? "live" : "")}
                      >
                        {u.active ? "Активен" : "Отключён"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          disabled={!canManageAccount(actor, u)}
                          title={"Изменить пользователя " + u.login}
                          onClick={() => setEditing(u)}
                        >
                          <Pencil size={16} />
                        </button>
                        {canManageAccount(actor, u) && u.id !== actor.id && (
                          <button
                            title={"Удалить пользователя " + u.login}
                            onClick={() => {
                              setDeleteError("");
                              setDeleting(u);
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {loading && (
          <div className="empty-state">
            <Loader2 className="spin" />
          </div>
        )}
      </section>
      <div className="library-note">
        <ShieldCheck size={18} />
        <p>
          Сотрудник видит общий журнал и создаёт новые записи. Изменение
          сохранённых записей доступно ADMIN и KEYUSER. Отключение учётной
          записи завершает все её сессии; история измерений сохраняется.
        </p>
      </div>
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-user-title"
          >
            <h2 id="delete-user-title">Удалить пользователя?</h2>
            <p className="modal-subtitle">
              Учётная запись «{deleting.name}» ({deleting.login}) будет удалена
              из системы входа, логин освобождён, доступ и сессии завершены. Все
              связанные измерения и авторство сохранятся.
            </p>
            {deleteError && (
              <div role="alert" className="form-error">
                {deleteError}
              </div>
            )}
            <div className="modal-buttons">
              <button
                autoFocus
                className="button secondary"
                disabled={deletingBusy}
                onClick={() => setDeleting(null)}
              >
                Отмена
              </button>
              <button
                className="button danger"
                disabled={deletingBusy}
                onClick={async () => {
                  setDeletingBusy(true);
                  try {
                    await api(
                      "/users/" + deleting.id + "?version=" + deleting.version,
                      { method: "DELETE" },
                    );
                    setDeleting(null);
                    onSaved("Пользователь удалён");
                  } catch (e) {
                    setDeleteError((e as Error).message);
                  } finally {
                    setDeletingBusy(false);
                  }
                }}
              >
                {deletingBusy ? (
                  <Loader2 className="spin" size={16} />
                ) : (
                  <Trash2 size={16} />
                )}
                Удалить
              </button>
            </div>
          </section>
        </div>
      )}
      {editing !== undefined && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-title"
          >
            <UserForm
              user={editing}
              keyuserOccupied={users.some(
                (u) => u.role === "KEYUSER" && u.id !== editing?.id,
              )}
              onClose={() => setEditing(undefined)}
              onSaved={(message) => {
                setEditing(undefined);
                onSaved(message);
              }}
            />
          </section>
        </div>
      )}
    </>
  );
}
function UserForm({
  user,
  keyuserOccupied,
  onSaved,
  onClose,
}: {
  user: User | null;
  keyuserOccupied: boolean;
  onSaved: (s: string) => void;
  onClose: () => void;
}) {
  const { user: actor } = useAuth();
  const [login, setLogin] = useState(user?.login ?? ""),
    [name, setName] = useState(user?.name ?? ""),
    [role, setRole] = useState<Role>(user?.role ?? "EMPLOYEE"),
    [active, setActive] = useState(user?.active ?? true),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(user ? "/users/" + user.id : "/users", {
        method: user ? "PUT" : "POST",
        body: JSON.stringify(
          user
            ? {
                name,
                role,
                active,
                version: user.version,
                ...(password ? { password } : {}),
              }
            : { login, name, role, password },
        ),
      });
      onSaved(user ? "Пользователь обновлён" : "Пользователь добавлен");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <button
        type="button"
        className="modal-close"
        title="Закрыть"
        disabled={busy}
        onClick={onClose}
      >
        <X size={20} />
      </button>
      <span className="modal-icon">
        <UserRound size={22} />
      </span>
      <h2 id="user-title">
        {user ? "Редактировать пользователя" : "Новый пользователь"}
      </h2>
      <p className="modal-subtitle">
        {user
          ? "Роль и состояние учётной записи."
          : "Создайте персональный доступ для члена команды."}
      </p>
      <label>
        Имя
        <input
          autoFocus
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="form-grid">
        <label>
          Логин
          <input
            required
            disabled={!!user}
            autoComplete="off"
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9._\-]{3,64}"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
        </label>
        <label>
          Роль
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            <option value="EMPLOYEE">Сотрудник</option>
            {actor.role === "KEYUSER" && (
              <option value="KEYUSER" disabled={keyuserOccupied}>
                KEYUSER{keyuserOccupied ? " (уже назначен)" : ""}
              </option>
            )}
            <option value="ADMIN">Администратор</option>
          </select>
        </label>
      </div>
      {
        <label>
          {user ? "Новый пароль (необязательно)" : "Пароль"}
          <input
            type="password"
            autoComplete="new-password"
            required={!user}
            minLength={4}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={
              user
                ? "Оставьте пустым, чтобы сохранить пароль"
                : "Не менее 4 символов"
            }
          />
        </label>
      }
      {user && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          Учётная запись активна
        </label>
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
          onClick={onClose}
          disabled={busy}
        >
          Отмена
        </button>
        <button className="button primary" disabled={busy}>
          {busy ? <Loader2 className="spin" size={16} /> : <Check size={16} />}
          Сохранить
        </button>
      </div>
    </form>
  );
}
