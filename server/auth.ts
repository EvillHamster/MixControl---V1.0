import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response, Request } from "express";
import { z } from "zod";
import { pool } from "./db.js";
import { audit, transaction } from "./audit.js";
import {
  assignableRoles,
  canManageAccount,
  isManager,
} from "../shared/permissions.js";
import { fail } from "./repository.js";
import type { User } from "../shared/domain.js";
const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
export const passwordSchema = z
  .string()
  .min(4, "Пароль должен содержать не менее 4 символов")
  .max(128, "Пароль слишком длинный");
const loginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9._-]{3,64}$/,
    "Логин: 3–64 латинских буквы, цифры, точка, дефис или подчёркивание",
  );
export const newUserSchema = z.object({
  login: loginSchema,
  name: z.string().trim().min(1, "Введите имя").max(120),
  password: passwordSchema,
  role: z.enum(["ADMIN", "KEYUSER", "EMPLOYEE"]),
});
export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(["ADMIN", "KEYUSER", "EMPLOYEE"]),
  active: z.boolean(),
  password: passwordSchema.optional(),
  version: z.number().int().positive(),
});
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = await derive(password, salt);
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
async function verifyPassword(password: string, stored: string) {
  const [, salt, hex] = stored.split("$");
  if (!salt || !hex) return false;
  const hash = await derive(password, salt);
  const expected = Buffer.from(hex, "hex");
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
const cookieName = "mixcontrol_session";
const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
const columns = "id,login,name,role,active,version";
function cookieToken(req: Request) {
  const token = (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookieName + "="))
    ?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export const currentUser = (res: Response) => res.locals.user as User;
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = cookieToken(req);
  if (!token) fail(401, "Войдите в систему");
  const r = await pool.query<User>(
    `SELECT u.id,u.login,u.name,u.role,u.active,u.version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active AND u.deleted_at IS NULL`,
    [hashToken(token)],
  );
  if (!r.rows[0]) fail(401, "Сессия завершена. Войдите снова.");
  res.locals.user = r.rows[0];
  next();
};
export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (!isManager(currentUser(res)))
    fail(403, "Действие доступно ADMIN и KEYUSER");
  next();
};
export const requireUserManager: RequestHandler = (_req, res, next) => {
  if (currentUser(res).role === "EMPLOYEE")
    fail(403, "Недостаточно прав для управления ролями");
  next();
};
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.COOKIE_SECURE === "true",
  path: "/",
};
async function createSession(res: Response, user: User) {
  const token = randomBytes(32).toString("hex");
  await transaction(async (c) => {
    const current = await c.query(
      "SELECT id FROM users WHERE id=$1 AND active AND deleted_at IS NULL AND version=$2 FOR SHARE",
      [user.id, user.version],
    );
    if (!current.rowCount)
      fail(401, "Учётная запись изменена или удалена. Войдите снова.");
    await c.query(
      "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
      [hashToken(token), user.id],
    );
  });
  res.cookie(cookieName, token, {
    ...cookieOptions,
    maxAge: 12 * 60 * 60 * 1000,
  });
  return user;
}
export const authService = {
  async status() {
    return {
      needsSetup: !(await pool.query("SELECT 1 FROM users LIMIT 1")).rowCount,
    };
  },
  async setup(body: unknown, res: Response) {
    const d = newUserSchema.omit({ role: true }).parse(body);
    const passwordHash = await hashPassword(d.password);
    const c = await pool.connect();
    let user: User;
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(847202)");
      if ((await c.query("SELECT 1 FROM users LIMIT 1")).rowCount)
        fail(409, "Первоначальная настройка уже выполнена");
      user = (
        await c.query<User>(
          `INSERT INTO users(login,name,password_hash,role) VALUES($1,$2,$3,'KEYUSER') RETURNING ${columns}`,
          [d.login, d.name, passwordHash],
        )
      ).rows[0];
      await c.query(
        "UPDATE measurements SET created_by=$1 WHERE created_by IS NULL AND sup ~ '^[0-9]{7}$'",
        [user.id],
      );
      await audit(c, user, "user.create", "users", user.id, null, user);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    return createSession(res, user);
  },
  async login(body: unknown, res: Response) {
    const d = z
      .object({ login: loginSchema, password: passwordSchema })
      .parse(body);
    const r = await pool.query(
      `SELECT ${columns},password_hash,deleted_at FROM users WHERE login=$1 AND deleted_at IS NULL`,
      [d.login],
    );
    const u = r.rows[0];
    const dummy = "scrypt$00000000000000000000000000000000$" + "0".repeat(128);
    const valid = await verifyPassword(d.password, u?.password_hash ?? dummy);
    if (!u || !u.active || u.deleted_at || !valid)
      fail(401, "Неверный логин или пароль");
    const { password_hash: _, deleted_at: _deleted, ...user } = u;
    return createSession(res, user);
  },
  async logout(req: Request, res: Response) {
    const token = cookieToken(req);
    if (token)
      await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
        hashToken(token),
      ]);
    res.clearCookie(cookieName, cookieOptions);
  },
  async listUsers() {
    return (
      await pool.query<User>(
        `SELECT ${columns} FROM users WHERE deleted_at IS NULL ORDER BY active DESC,name,id`,
      )
    ).rows;
  },
  async assignRole(id: string, body: unknown, actor: User) {
    const d = z
      .object({
        role: z.enum(["EMPLOYEE", "ADMIN", "KEYUSER"]),
        version: z.number().int().positive(),
      })
      .strict()
      .parse(body);
    return changeUser(id, d, actor, true);
  },
  async createUser(body: unknown, actor: User) {
    const d = newUserSchema.parse(body);
    const passwordHash = await hashPassword(d.password);
    return transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(847202)");
      const manager = await managerInTransaction(c, actor);
      if (!assignableRoles(manager).includes(d.role))
        fail(403, "Назначать роль KEYUSER может только KEYUSER");
      const user = (
        await c.query<User>(
          `INSERT INTO users(login,name,password_hash,role) VALUES($1,$2,$3,$4) RETURNING ${columns}`,
          [d.login, d.name, passwordHash, d.role],
        )
      ).rows[0];
      await audit(c, manager, "user.create", "users", user.id, null, user);
      return user;
    });
  },
  async updateUser(id: string, body: unknown, actor: User) {
    return changeUser(id, updateUserSchema.parse(body), actor, false);
  },
  async deleteUser(id: string, version: number, actor: User) {
    return transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(847202)");
      const manager = await managerInTransaction(c, actor);
      const target = (
        await c.query<User>(
          `SELECT ${columns} FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
          [id],
        )
      ).rows[0];
      if (!target) fail(404, "Пользователь не найден");
      if (id === manager.id)
        fail(403, "Нельзя удалить собственную активную учётную запись");
      if (!canManageAccount(manager, target))
        fail(403, "ADMIN может управлять только аккаунтами EMPLOYEE");
      if (target.version !== version)
        fail(409, "Пользователь изменён. Обновите список.");
      await protectKeyuser(c, target, "EMPLOYEE", false);
      const deleted = (
        await c.query(
          `UPDATE users SET login=NULL,password_hash=NULL,active=false,deleted_at=now(),version=version+1 WHERE id=$1 RETURNING ${columns},deleted_at`,
          [id],
        )
      ).rows[0];
      await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
      await c.query("DELETE FROM import_jobs WHERE actor_id=$1", [id]);
      await audit(c, manager, "user.delete", "users", id, target, deleted);
    });
  },
};
async function managerInTransaction(c: import("pg").PoolClient, actor: User) {
  const manager = (
    await c.query<User>(
      `SELECT ${columns} FROM users WHERE id=$1 AND active AND deleted_at IS NULL FOR SHARE`,
      [actor.id],
    )
  ).rows[0];
  if (!manager || !isManager(manager))
    fail(403, "Недостаточно прав для управления пользователями");
  return manager;
}
async function protectKeyuser(
  c: import("pg").PoolClient,
  target: User,
  role: string,
  active: boolean,
) {
  if (
    target.role === "KEYUSER" &&
    target.active &&
    (role !== "KEYUSER" || !active)
  ) {
    const count = (
      await c.query(
        "SELECT count(*)::int AS n FROM users WHERE role='KEYUSER' AND active AND deleted_at IS NULL",
      )
    ).rows[0].n;
    if (count <= 1)
      fail(
        409,
        "Нельзя удалить, отключить или понизить последнего активного KEYUSER",
      );
  }
}
async function changeUser(
  id: string,
  d: {
    role: User["role"];
    version: number;
    name?: string;
    active?: boolean;
    password?: string;
  },
  actor: User,
  roleOnly: boolean,
) {
  const passwordHash = d.password ? await hashPassword(d.password) : null;
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(847202)");
    const manager = await managerInTransaction(c, actor);
    const target = (
      await c.query<User>(
        `SELECT ${columns} FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
        [id],
      )
    ).rows[0];
    if (!target) fail(404, "Пользователь не найден");
    if (!canManageAccount(manager, target))
      fail(403, "ADMIN может управлять только аккаунтами EMPLOYEE");
    if (!assignableRoles(manager).includes(d.role))
      fail(403, "Назначать роль KEYUSER может только KEYUSER");
    if (target.version !== d.version)
      fail(409, "Пользователь изменён. Обновите список.");
    const active = roleOnly ? target.active : d.active!;
    await protectKeyuser(c, target, d.role, active);
    const updated = (
      await c.query<User>(
        `UPDATE users SET name=$1,role=$2,active=$3,password_hash=COALESCE($4,password_hash),version=version+1 WHERE id=$5 RETURNING ${columns}`,
        [roleOnly ? target.name : d.name, d.role, active, passwordHash, id],
      )
    ).rows[0];
    if (passwordHash || !active || d.role !== target.role)
      await c.query("DELETE FROM sessions WHERE user_id=$1", [id]);
    await audit(c, manager, "user.update", "users", id, target, updated, {
      passwordChanged: !!passwordHash,
    });
    return updated;
  });
}
