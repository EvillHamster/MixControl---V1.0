import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import type { User } from "../shared/domain";
import { api, ApiError } from "./api";
type Auth = {
  user: User;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<Auth | null>(null);
export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("Отсутствует сессия");
  return value;
}
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [setup, setSetup] = useState(false),
    [error, setError] = useState("");
  async function refresh() {
    try {
      setUser(await api<User>("/auth/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setUser(null);
        setSetup(
          (await api<{ needsSetup: boolean }>("/auth/status")).needsSetup,
        );
      } else throw e;
    }
  }
  async function init() {
    setLoading(true);
    setError("");
    try {
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void init();
    const expired = () => {
      setUser(null);
      setSetup(false);
    };
    window.addEventListener("mixcontrol:unauthorized", expired);
    return () => window.removeEventListener("mixcontrol:unauthorized", expired);
  }, []);
  async function logout() {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
    setSetup(false);
  }
  if (loading)
    return (
      <div className="auth-screen">
        <Loader2 className="spin" size={28} />
      </div>
    );
  if (error)
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <h1>Нет связи с сервером</h1>
          <p>{error}</p>
          <button className="button primary" onClick={init}>
            Повторить подключение
          </button>
        </div>
      </div>
    );
  if (!user)
    return (
      <LoginForm
        setup={setup}
        onLogin={(u) => {
          setUser(u);
          setSetup(false);
        }}
      />
    );
  return (
    <AuthContext.Provider value={{ user, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
function LoginForm({
  setup,
  onLogin,
}: {
  setup: boolean;
  onLogin: (user: User) => void;
}) {
  const [login, setLogin] = useState(""),
    [name, setName] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    try {
      onLogin(
        await api<User>(setup ? "/auth/setup" : "/auth/login", {
          method: "POST",
          body: JSON.stringify({ login, password, ...(setup ? { name } : {}) }),
        }),
      );
      setPassword("");
      setConfirm("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        {setup && (
          <label>
            Имя администратора
            <input
              required
              autoComplete="name"
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <label>
          Логин
          <input
            required
            autoComplete="username"
            minLength={3}
            maxLength={64}
            pattern="[A-Za-z0-9._\-]{3,64}"
            placeholder="Латинские буквы и цифры"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            autoFocus={!setup}
          />
        </label>
        <label>
          Пароль
          <input
            required
            type="password"
            autoComplete={setup ? "new-password" : "current-password"}
            minLength={4}
            maxLength={128}
            placeholder={setup ? "Не менее 4 символов" : "Введите пароль"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && (
          <label>
            Повторите пароль
            <input
              required
              type="password"
              autoComplete="new-password"
              minLength={4}
              maxLength={128}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full" disabled={busy}>
          {busy ? (
            <Loader2 className="spin" size={17} />
          ) : (
            <ArrowRight size={17} />
          )}{" "}
          {setup ? "Создать администратора" : "Войти"}
        </button>
      </form>
    </div>
  );
}
