export type ImportKind = "records" | "mixtures";
export interface ImportIssue {
  row: number;
  sup: string;
  mixtureExcel: string;
  mixtureDb: string;
  message: string;
}
export interface ImportPreview {
  id?: string;
  total: number;
  added: number;
  updated: number;
  errorCount: number;
  errors: ImportIssue[];
  rows: Array<{
    row: number;
    sup?: string;
    name: string;
    operation: string;
    date?: string;
    tMin: number;
    tMax: number;
    actual?: number | null;
    equipment?: number | null;
    status?: string | null;
  }>;
}
