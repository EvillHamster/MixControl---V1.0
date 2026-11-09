import { z } from "zod";
export type Status = "OK" | "NOK" | null;
export type Role = "ADMIN" | "KEYUSER" | "EMPLOYEE";
export interface User {
  id: string;
  login: string;
  name: string;
  role: Role;
  active: boolean;
  version: number;
}
export const supSchema = z
  .string()
  .regex(/^[0-9]{7}$/, "SUP должен содержать ровно 7 цифр");
export function result(
  min: number,
  max: number,
  actual: number | null,
  equipment: number | null,
): Status {
  if (
    [actual, equipment].some(
      (value) => value !== null && (value < min || value > max),
    )
  )
    return "NOK";
  return actual === null || equipment === null ? null : "OK";
}
const temperature = z
  .number()
  .finite()
  .min(-273.15, "Температура ниже абсолютного нуля")
  .max(10000, "Слишком высокая температура");
export const mixtureSchema = z
  .object({
    name: z.string().trim().min(1, "Введите название").max(120),
    tMin: temperature,
    tMax: temperature,
    archived: z.boolean().optional(),
  })
  .refine((v) => v.tMin <= v.tMax, {
    message: "T min не может превышать T max",
    path: ["tMax"],
  });
export const recordSchema = z.object({
  sup: supSchema,
  mixtureId: z.string().uuid(),
  actual: temperature.nullable(),
  equipment: temperature.nullable(),
  version: z.number().int().positive().optional(),
});
export interface Mixture {
  id: string;
  name: string;
  tMin: number | null;
  tMax: number | null;
  archived: boolean;
  recordCount: number;
}
export interface Measurement {
  id: string;
  date: string;
  sup: string;
  mixtureId: string;
  mixtureName: string;
  tMin: number;
  tMax: number;
  actual: number | null;
  equipment: number | null;
  delta: number | null;
  legacyPending: boolean;
  actualMin: number | null;
  actualMax: number | null;
  status: Status;
  version: number;
  createdBy: string | null;
  authorName: string | null;
}
