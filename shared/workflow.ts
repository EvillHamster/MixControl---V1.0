import { z } from "zod";
export const correctionStatuses = {
  NOT_STARTED: "Не в работе",
  IN_PROGRESS: "В работе",
  DONE: "Готово",
} as const;
export type CorrectionStatus = keyof typeof correctionStatuses;
export const correctionUpdateSchema = z
  .object({
    status: z.enum(["NOT_STARTED", "IN_PROGRESS", "DONE"]),
    responsibleId: z.string().uuid().nullable(),
    workDone: z.string().max(10000, "Описание: не более 10 000 символов"),
    version: z.number().int().positive(),
  })
  .strict();
export interface Correction {
  id: string;
  measurementId: string | null;
  measurementKey: string;
  date: string;
  sup: string;
  mixtureName: string;
  actual: number | null;
  equipment: number | null;
  delta: number | null;
  initialData: {
    actual: number;
    equipment: number;
    delta: number;
    date: string;
    sup: string;
    mixtureName: string;
  };
  sourceDeleted: boolean;
  status: CorrectionStatus;
  responsibleId: string | null;
  responsibleName: string | null;
  workDone: string;
  detectedAt: string;
  completedAt: string | null;
  updatedAt: string;
  version: number;
}
export interface CorrectionEvent {
  id: string;
  kind: string;
  actorName: string;
  actorLogin: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}
export interface CorrectionDetail {
  correction: Correction;
  events: CorrectionEvent[];
  eventTotal: number;
  page: number;
}
export interface ReportRow {
  id: string;
  date: string;
  sup: string;
  mixtureName: string;
  tMin: number;
  tMax: number;
  actual: number | null;
  equipment: number | null;
  deviation: string;
}
export interface DailyReport {
  date: string;
  total: number;
  ok: number;
  nok: number;
  pending: number;
  nokPercent: number;
  version: number;
  generatedAt: string;
  updatedAt: string;
  rows: ReportRow[];
  page: number;
  dates: string[];
  maxDate: string;
}
