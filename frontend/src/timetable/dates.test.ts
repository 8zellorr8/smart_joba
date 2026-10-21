import { expect, it } from "vitest";
import { addDays, dayLabel, lessonLanes, weekStart } from "./dates";

it.each([
  ["2026-10-22", "2026-10-19"],
  ["2026-10-25", "2026-10-19"],
  ["2026-10-26", "2026-10-26"],
  ["2027-01-01", "2026-12-28"],
])(
  "finds the Monday containing %s across civil week/year boundaries",
  (date, monday) => {
    expect(weekStart(date)).toBe(monday);
  },
);
it("uses Kazakh date labels even without browser kk ICU data", () => {
  expect(dayLabel("2026-10-22", true)).toBe("Бейсенбі, 22 қазан");
  expect(dayLabel("2026-10-25", true)).toBe("Жексенбі, 25 қазан");
});
it("moves civil dates without a timezone/DST shift", () => {
  expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
  expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
});
it("keeps overlapping events in separate lanes and reuses a lane at a touching boundary", () => {
  const input = [
    { id: "a", start: "09:00", end: "10:30" },
    { id: "b", start: "09:30", end: "11:00" },
    { id: "c", start: "10:30", end: "12:00" },
    { id: "d", start: "12:00", end: "13:30" },
  ];
  const layout = lessonLanes(input);
  expect(layout.map(({ event }) => event.id)).toEqual(["a", "b", "c", "d"]);
  expect(layout[0].lane).not.toBe(layout[1].lane);
  expect(layout[1].lane).not.toBe(layout[2].lane);
  expect(layout[0].lane).toBe(layout[2].lane);
  expect(layout.slice(0, 3).every((item) => item.lanes === 2)).toBe(true);
  expect(layout[3].lanes).toBe(1);
  expect(input[0]).not.toHaveProperty("lane");
});
