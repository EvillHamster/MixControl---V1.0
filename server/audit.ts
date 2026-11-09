import type { PoolClient } from "pg";
import type { User } from "../shared/domain.js";
import { pool } from "./db.js";
export async function audit(
  c: Pick<PoolClient, "query">,
  actor: User | null,
  action: string,
  entity: string,
  id: string | null,
  before: unknown,
  after: unknown,
  details: unknown = {},
  sup: string | null = null,
) {
  await c.query(
    "INSERT INTO audit_log(actor_id,actor_login,action,entity,entity_id,sup,before_data,after_data,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      actor?.id ?? null,
      actor?.login ?? "system",
      action,
      entity,
      id,
      sup,
      JSON.stringify(before),
      JSON.stringify(after),
      JSON.stringify(details),
    ],
  );
}
export async function transaction<T>(work: (c: PoolClient) => Promise<T>) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const value = await work(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

export async function assertActor(
  c: Pick<PoolClient, "query">,
  actor: User,
  manager = false,
) {
  const user = (
    await c.query(
      "SELECT role FROM users WHERE id=$1 AND active AND deleted_at IS NULL FOR SHARE",
      [actor.id],
    )
  ).rows[0];
  if (!user || (manager && user.role === "EMPLOYEE"))
    throw Object.assign(new Error("Недостаточно прав. Обновите страницу."), {
      status: 403,
    });
  await setAuditActor(c, actor);
}

export async function setAuditActor(c: Pick<PoolClient, "query">, actor: User) {
  await c.query(
    "SELECT set_config('mixcontrol.actor_id',$1,true),set_config('mixcontrol.actor_login',$2,true),set_config('mixcontrol.actor_name',$3,true)",
    [actor.id, actor.login, actor.name],
  );
}
