import ExcelJS from "exceljs";
import type { Measurement } from "../shared/domain.js";
export function measurementWorkbook(rows: Measurement[]) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MixControl";
  const sheet = workbook.addWorksheet("Контроль температур", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Дата", key: "date", width: 15 },
    { header: "SUP", key: "sup", width: 24 },
    { header: "Смесь", key: "mixtureName", width: 32 },
    ...["tMin", "tMax", "actual", "equipment"].map((key, i) => ({
      header: ["T min, °C", "T max, °C", "T(fact), °C", "T(обор), °C"][i],
      key,
      width: 19,
    })),
    { header: "Итог", key: "status", width: 16 },
  ];
  for (const row of rows) {
    const rr = sheet.addRow({
      ...row,
      actual: row.legacyPending ? "На переносе" : row.actual,
      status: row.status ?? "Ожидает",
    });
    for (let i = 4; i <= 7; i++) rr.getCell(i).numFmt = "0.00";
    rr.getCell(8).font = {
      color: {
        argb:
          row.status === "OK"
            ? "FF16734B"
            : row.status === "NOK"
              ? "FFCF4040"
              : "FF788078",
      },
    };
  }
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF174E40" },
  };
  sheet.autoFilter = "A1:H1";
  const legacyRows = rows.filter(
    (r) => r.actualMin !== null || r.actualMax !== null,
  );
  if (legacyRows.length) {
    const legacy = workbook.addWorksheet("Исходные измерения");
    legacy.columns = [
      { header: "SUP", key: "sup", width: 18 },
      { header: "Tmin (fact), °C — исходное", key: "actualMin", width: 30 },
      { header: "Tmax (fact), °C — исходное", key: "actualMax", width: 30 },
      { header: "Требуется перенос", key: "transfer", width: 25 },
    ];
    for (const row of legacyRows)
      legacy.addRow({ ...row, transfer: row.legacyPending ? "Да" : "Нет" });
  }
  return workbook;
}
