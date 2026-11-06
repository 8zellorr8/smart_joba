import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "./dateTime";

describe("date and time display", () => {
  it("preserves calendar dates without timezone conversion", () => {
    expect(formatDate("2026-11-06")).toBe("06.11.2026");
  });
  it("uses the academic timezone across a date boundary", () => {
    expect(formatDateTime("2026-11-05T20:10:00Z", "Asia/Almaty")).toBe(
      "06.11.2026 · 01:10",
    );
  });
  it("shows midnight as 00:00 with padded day and month", () => {
    expect(formatDateTime("2026-01-02T00:00:00Z", "UTC")).toBe(
      "02.01.2026 · 00:00",
    );
  });
});
