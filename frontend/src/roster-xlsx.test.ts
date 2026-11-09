import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  inspectRosterArchive,
  readRosterWorkbook,
  rosterTextFromSheets,
} from "./roster-xlsx";

it("reads a synthetic workbook locally and keeps comma-containing names in one CSV cell", async () => {
  const bytes = readFileSync("src/test-fixtures/synthetic-roster.xlsx");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  expect(await readRosterWorkbook(buffer)).toBe(
    'Студенттің аты-жөні\nSYNTHETIC Student One\n"SYNTHETIC Student, Two"',
  );
  inspectRosterArchive(buffer);
  const oversized = buffer.slice(0);
  const zip = new DataView(oversized);
  for (let at = 0; at < oversized.byteLength - 46; at++) {
    if (zip.getUint32(at, true) === 0x02014b50) {
      zip.setUint32(at + 24, 5_000_001, true);
      break;
    }
  }
  expect(() => inspectRosterArchive(oversized)).toThrow("archive_limit");
});

it("rejects extra populated sheets, columns, nontext cells and oversized rosters", () => {
  const sheet = (data: (string | number | null)[][]) => [
    { sheet: "Roster", data },
  ];
  expect(() => rosterTextFromSheets(sheet([["A", "B"]]))).toThrow("one_column");
  expect(() => rosterTextFromSheets(sheet([[123]]))).toThrow("cell");
  expect(() => rosterTextFromSheets(sheet([["A\nB"]]))).toThrow("cell");
  expect(() =>
    rosterTextFromSheets([
      ...sheet([["SYNTHETIC A"]]),
      { sheet: "Other", data: [["SYNTHETIC B"]] },
    ]),
  ).toThrow("sheets");
  expect(() =>
    rosterTextFromSheets(
      sheet(Array.from({ length: 202 }, () => ["SYNTHETIC A"])),
    ),
  ).toThrow("limit");
});
