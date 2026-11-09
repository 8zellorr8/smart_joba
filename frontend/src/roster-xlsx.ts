import readXlsxFile from "read-excel-file/universal";
import type { Sheet } from "read-excel-file/universal";

export function inspectRosterArchive(buffer: ArrayBuffer): void {
  const zip = new DataView(buffer);
  let end = -1;
  for (
    let at = buffer.byteLength - 22;
    at >= Math.max(0, buffer.byteLength - 65_557);
    at--
  ) {
    if (
      zip.getUint32(at, true) === 0x06054b50 &&
      at + 22 + zip.getUint16(at + 20, true) === buffer.byteLength
    ) {
      end = at;
      break;
    }
  }
  if (
    end < 0 ||
    zip.getUint16(end + 4, true) !== 0 ||
    zip.getUint16(end + 6, true) !== 0
  )
    throw new Error("archive");
  const count = zip.getUint16(end + 10, true);
  if (count !== zip.getUint16(end + 8, true) || count > 100)
    throw new Error("archive_limit");
  const directorySize = zip.getUint32(end + 12, true);
  let at = zip.getUint32(end + 16, true);
  if (at + directorySize > end) throw new Error("archive");
  let unpacked = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || zip.getUint32(at, true) !== 0x02014b50)
      throw new Error("archive");
    const packed = zip.getUint32(at + 20, true);
    const size = zip.getUint32(at + 24, true);
    unpacked += size;
    if (
      size > 2_000_000 ||
      unpacked > 5_000_000 ||
      size / Math.max(packed, 1) > 250
    )
      throw new Error("archive_limit");
    if (zip.getUint16(at + 8, true) & 1) throw new Error("archive");
    at +=
      46 +
      zip.getUint16(at + 28, true) +
      zip.getUint16(at + 30, true) +
      zip.getUint16(at + 32, true);
  }
  if (at !== zip.getUint32(end + 16, true) + directorySize)
    throw new Error("archive");
}

export function rosterTextFromSheets(sheets: Sheet[]): string {
  const populated = sheets.filter((sheet) =>
    sheet.data.some((row) =>
      row.some((cell) => cell != null && String(cell).trim()),
    ),
  );
  if (populated.length !== 1) throw new Error("sheets");
  const rows = populated[0].data.filter((row) =>
    row.some((cell) => cell != null && String(cell).trim()),
  );
  if (rows.length > 201) throw new Error("limit");
  return rows
    .map((row) => {
      if (row.slice(1).some((cell) => cell != null && String(cell).trim()))
        throw new Error("one_column");
      const name = row[0];
      if (typeof name !== "string" || !name.trim() || /[\r\n]/.test(name))
        throw new Error("cell");
      const trimmed = name.trim();
      if (trimmed.length > 160) throw new Error("name_long");
      return /[;,\t"]/.test(trimmed)
        ? `"${trimmed.replaceAll('"', '""')}"`
        : trimmed;
    })
    .join("\n");
}

export async function readRosterWorkbook(buffer: ArrayBuffer): Promise<string> {
  inspectRosterArchive(buffer);
  return rosterTextFromSheets(await readXlsxFile(buffer));
}
