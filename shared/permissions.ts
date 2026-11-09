import type { User, Role } from "./domain";
export const isManager = (user: Pick<User, "role">) => user.role !== "EMPLOYEE";
export function canManageAccount(actor: User, target: User) {
  return (
    actor.role === "KEYUSER" ||
    (actor.role === "ADMIN" && target.role === "EMPLOYEE")
  );
}
export function assignableRoles(actor: Pick<User, "role">): Role[] {
  return actor.role === "KEYUSER"
    ? ["EMPLOYEE", "ADMIN", "KEYUSER"]
    : actor.role === "ADMIN"
      ? ["EMPLOYEE", "ADMIN"]
      : [];
}
