import { expect, it, vi } from "vitest";
import { collectWeek } from "./pages";

it("collects every page before exposing a complete weekly result", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      events: [{ id: "a" }, { id: "b" }],
      total: 3,
      offset: 0,
      limit: 2,
      key: "r1",
    })
    .mockResolvedValueOnce({
      events: [{ id: "c" }],
      total: 3,
      offset: 2,
      limit: 2,
      key: "r1",
    });
  expect(await collectWeek(fetch, "r1", () => true)).toEqual([
    { id: "a" },
    { id: "b" },
    { id: "c" },
  ]);
  expect(fetch.mock.calls).toEqual([[0], [2]]);
});
it("rejects pages from a different revision instead of joining their lessons", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      events: [{ id: "a" }],
      total: 2,
      offset: 0,
      limit: 1,
      key: "r1",
    })
    .mockResolvedValueOnce({
      events: [{ id: "b" }],
      total: 2,
      offset: 1,
      limit: 1,
      key: "r2",
    });
  await expect(collectWeek(fetch, "r1", () => true)).rejects.toMatchObject({
    code: "EDITOR_STALE",
  });
});
it.each([
  { events: [], total: 2, offset: 0, limit: 1 },
  { events: [{ id: "a" }], total: 1, offset: 1, limit: 1 },
  { events: [], total: 0, offset: 0, limit: 0 },
  { events: [{ id: "a" }, { id: "a" }], total: 2, offset: 0, limit: 2 },
])("rejects a malformed/no-progress page without looping", async (page) => {
  const fetch = vi.fn().mockResolvedValue({ ...page, key: "r1" });
  await expect(collectWeek(fetch, "r1", () => true)).rejects.toMatchObject({
    code: "INVALID_WEEK_PAGE",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("drops a result after the requesting view is disposed", async () => {
  let active = true;
  const fetch = vi.fn().mockImplementation(async () => {
    active = false;
    return { events: [{ id: "a" }], total: 2, offset: 0, limit: 1, key: "r1" };
  });
  expect(await collectWeek(fetch, "r1", () => active)).toBeNull();
  expect(fetch).toHaveBeenCalledTimes(1);
});
