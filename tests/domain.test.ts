import { matchesMixture } from "../shared/mixture-search";
import { test } from "node:test";
import assert from "node:assert/strict";
import { result, mixtureSchema, recordSchema } from "../shared/domain.js";
test("Граничные значения включены в допустимый диапазон", () => {
  assert.equal(result(20, 80, 20, 20), "OK");
  assert.equal(result(-50, -10, -10, -10), "OK");
  assert.equal(result(0, 0, 0, 0), "OK");
});
test("Температуры вне диапазона дают NOK", () => {
  assert.equal(result(20, 80, 19.99, 19.99), "NOK");
  assert.equal(result(20, 80, 80.01, 80.01), "NOK");
  assert.equal(result(20, 80, 81, 81), "NOK");
});
test("Отсутствующая температура сохраняет нейтральный статус", () => {
  assert.equal(result(20, 80, null, null), null);
});
test("Валидация нормативов отклоняет обратный диапазон, NaN и бесконечность", () => {
  for (const pair of [
    [30, 20],
    [NaN, 20],
    [0, Infinity],
    [-274, 20],
  ])
    assert.equal(
      mixtureSchema.safeParse({ name: "M1", tMin: pair[0], tMax: pair[1] })
        .success,
      false,
    );
  assert.equal(
    mixtureSchema.safeParse({ name: " ", tMin: 0, tMax: 1 }).success,
    false,
  );
});
const entry = {
  date: "2026-11-08",
  sup: "0123456",
  mixtureId: "e3bb0734-6098-4b44-a98b-dc60299e7fbc",
  actual: 40,
  equipment: 40,
};
test("SUP сохраняет ведущие нули", () => {
  assert.equal(recordSchema.parse(entry).sup, "0123456");
});
test("SUP допускает ровно семь ASCII-цифр без пробелов", () => {
  for (const sup of [
    "123456",
    "12345678",
    "123A567",
    " 1234567",
    "１２３４５６７",
    1234567,
  ])
    assert.equal(recordSchema.safeParse({ ...entry, sup }).success, false);
  assert.equal(
    recordSchema.safeParse({ ...entry, sup: "0000000" }).success,
    true,
  );
});
test("Дата задаётся сервером, пустой SUP запрещён", () => {
  assert.equal(
    Object.hasOwn(recordSchema.parse({ ...entry, date: "2026-02-30" }), "date"),
    false,
  );
  assert.equal(recordSchema.safeParse({ ...entry, sup: "  " }).success, false);
});

test("Отклонение любой температуры даёт NOK, даже при неполной второй", () => {
  assert.equal(result(20, 80, 40, 81), "NOK");
  assert.equal(result(20, 80, 19, 40), "NOK");
  assert.equal(result(20, 80, null, 81), "NOK");
  assert.equal(result(20, 80, 19, null), "NOK");
  assert.equal(result(20, 80, 40, null), null);
  assert.equal(result(20, 80, null, 40), null);
  assert.equal(result(20, 80, 20, 80), "OK");
  assert.equal(
    recordSchema.safeParse({ ...entry, equipment: -274 }).success,
    false,
  );
});

test("Поиск смесей ищет любую часть названия, игнорирует регистр и пробелы во всём каталоге", () => {
  for (const query of [
    "M1",
    "R00218",
    "00218",
    "218",
    " r00218 ",
    "M1 - R00218",
    "  m1  ",
  ])
    assert.equal(matchesMixture("M1-R00218", query), true, query);
  assert.equal(matchesMixture("M1 - R00218", "m1-r00218"), true);
  assert.equal(matchesMixture("M1-R00218", "2189"), false);
  const catalog = Array.from({ length: 301 }, (_, i) => ({
    name: i === 300 ? "M1-R00218" : "Mix-" + i,
  }));
  assert.equal(
    catalog
      .filter((m) => matchesMixture(m.name, "218"))
      .some((m) => m.name === "M1-R00218"),
    true,
  );
});
