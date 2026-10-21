import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WeekPanel } from "./WeekPanel";
import { editorApi } from "../editor-api";
import type { EditorData, ScheduleDraft } from "../editor-api";
import { publicationApi } from "../publication-api";
import type { PublishedView, ReaderEvent } from "../publication-api";
import { ApiError } from "../api";
import { wb } from "../locales/workbench.kk";

vi.mock("../publication-api", () => ({ publicationApi: { get: vi.fn() } }));
vi.mock("../editor-api", () => ({ editorApi: { get: vi.fn() } }));
const lesson = (id = "lesson", date = "2026-10-22"): ReaderEvent => ({
  id,
  date,
  start: "09:00",
  end: "10:30",
  subject: "Қазақ тілі",
  group: "Топ А",
  teacher: "Оқытушы А",
  room: "101",
});
const published = (): PublishedView => ({
  publication_id: "pub",
  version_id: "version",
  version_number: 5,
  revision: 1,
  published_at: "2026-10-21T12:00:00Z",
  name: "Кесте",
  context_id: "context",
  academic_year: "2026-2027",
  data_kind: "college",
  semester: 1,
  scope_name: "Тест",
  timezone: "Asia/Almaty",
  is_current: true,
  groups: ["Топ А"],
  event_count: 1,
  external_verified: false,
  events: [lesson()],
  total: 1,
  offset: 0,
  limit: 100,
  resources: {
    group: [{ id: "group-a", name: "Топ А" }],
    teacher: [{ id: "teacher-a", name: "Оқытушы А" }],
    room: [{ id: "room-101", name: "101" }],
  },
});
const draft = (status = "draft") =>
  ({
    id: "draft",
    context_id: "context",
    revision: 1,
    status,
    data_kind: "college",
    dependencies: { context_revision: 1, calendars: {}, rooms: {} },
    occurrences: [
      { ...lesson(), series_id: "series", cancelled: false, pinned: false },
    ],
    total: 1,
    offset: 0,
    limit: 100,
  }) as ScheduleDraft;
const data = {
  calendars: [],
  assignments: [],
  rooms: [],
  contexts: [],
  drafts: [],
} as EditorData;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publicationApi.get).mockResolvedValue(published());
  vi.mocked(editorApi.get).mockResolvedValue(draft());
});
const setup = (props = {}) =>
  render(
    <WeekPanel
      source={{ kind: "publication", value: published() }}
      initialDate="2026-10-22"
      onExpired={vi.fn()}
      {...props}
    />,
  );

it("requests the complete containing week and opens readable lesson details", async () => {
  setup();
  const button = await screen.findByRole("button", {
    name: /22 қазан.*Қазақ тілі/,
  });
  expect(publicationApi.get).toHaveBeenCalledWith("pub", {
    start: "2026-10-19",
    end: "2026-10-25",
    view: "group",
    resource_id: "",
    offset: 0,
  });
  await userEvent.click(button);
  const details = screen.getByRole("complementary", { name: wb.details });
  expect(within(details).getByText("Оқытушы А")).toBeVisible();
  expect(within(details).getByText("101")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: wb.edit }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    within(details).getByRole("button", { name: wb.close }),
  );
  expect(screen.getByText(wb.selectLesson)).toBeVisible();
  expect(button).toHaveFocus();
});
it("never exposes publication editing even if a caller passes canEdit", async () => {
  const edit = vi.fn();
  setup({ canEdit: true, onEdit: edit });
  await userEvent.click(
    await screen.findByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
  );
  expect(
    screen.queryByRole("button", { name: wb.edit }),
  ).not.toBeInTheDocument();
  expect(edit).not.toHaveBeenCalled();
});
it.each(["published", "approved", "submitted", "rejected", "archived"])(
  "keeps a %s draft read-only",
  async (status) => {
    const value = draft(status);
    vi.mocked(editorApi.get).mockResolvedValue(value);
    setup({ source: { kind: "draft", value, data }, canEdit: true });
    await userEvent.click(
      await screen.findByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
    );
    expect(
      screen.queryByRole("button", { name: wb.edit }),
    ).not.toBeInTheDocument();
  },
);
it("opens the existing draft edit action for exactly the selected occurrence", async () => {
  const value = draft();
  const edit = vi.fn();
  setup({
    source: { kind: "draft", value, data },
    canEdit: true,
    onEdit: edit,
  });
  await userEvent.click(
    await screen.findByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
  );
  await userEvent.click(screen.getByRole("button", { name: wb.edit }));
  expect(edit).toHaveBeenCalledWith(value.occurrences[0]);
});
it("passes actual resource IDs to the server instead of filtering private records locally", async () => {
  setup();
  await screen.findByRole("button", { name: /22 қазан.*Қазақ тілі/ });
  await userEvent.selectOptions(
    screen.getByLabelText("Аптаның ресурсы"),
    "group-a",
  );
  await waitFor(() =>
    expect(publicationApi.get).toHaveBeenLastCalledWith(
      "pub",
      expect.objectContaining({ resource_id: "group-a" }),
    ),
  );
});
it("does not expose partial pages when a later page fails", async () => {
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce({ ...published(), total: 2, limit: 1 })
    .mockRejectedValueOnce(new ApiError(0, "network_error"));
  setup();
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(wb.noWeekLessons)).not.toBeInTheDocument();
});
it("ignores the late result of a disposed publication", async () => {
  let resolve!: (value: PublishedView) => void;
  vi.mocked(publicationApi.get).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const next = {
    ...published(),
    publication_id: "new-pub",
    events: [{ ...lesson("new", "2026-10-29"), subject: "Информатика" }],
  };
  vi.mocked(publicationApi.get).mockResolvedValue(next);
  const rendered = setup();
  await waitFor(() => expect(publicationApi.get).toHaveBeenCalledTimes(1));
  // A source change disposes the in-flight request.
  const changed = published();
  changed.publication_id = "new-pub";
  rendered.rerender(
    <WeekPanel
      key="new-pub"
      source={{ kind: "publication", value: changed }}
      initialDate="2026-10-29"
      onExpired={vi.fn()}
    />,
  );
  await screen.findByRole("button", { name: /29 қазан.*Информатика/ });
  await act(async () => resolve(published()));
  expect(
    within(rendered.container).queryByRole("button", { name: /22 қазан/ }),
  ).not.toBeInTheDocument();
});
it("marks a changed draft revision stale and never enables its old edit action", async () => {
  const stale = vi.fn();
  vi.mocked(editorApi.get).mockResolvedValue({ ...draft(), revision: 2 });
  setup({
    source: { kind: "draft", value: draft(), data },
    canEdit: true,
    onStale: stale,
  });
  expect(await screen.findByRole("alert")).toHaveTextContent(wb.stale);
  expect(stale).toHaveBeenCalledOnce();
  expect(
    screen.queryByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
  ).not.toBeInTheDocument();
});
it("clears selected lessons after an access denial", async () => {
  const denied = vi.fn();
  setup({ onDenied: denied });
  await screen.findByRole("button", { name: /22 қазан.*Қазақ тілі/ });
  vi.mocked(publicationApi.get).mockRejectedValue(
    new ApiError(403, "ACCESS_DENIED"),
  );
  fireEvent.change(screen.getByLabelText(wb.date), {
    target: { value: "2026-10-29" },
  });
  await screen.findByRole("alert");
  expect(denied).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("Аптаның ресурсы")).not.toBeInTheDocument();
  expect(screen.queryByText("Оқытушы А")).not.toBeInTheDocument();
});

it("allows changing weeks during loading and discards the slower previous week", async () => {
  let finish!: (value: PublishedView) => void;
  vi.mocked(publicationApi.get).mockImplementationOnce(
    () =>
      new Promise((done) => {
        finish = done;
      }),
  );
  setup();
  await waitFor(() => expect(publicationApi.get).toHaveBeenCalledOnce());
  vi.mocked(publicationApi.get).mockResolvedValue({
    ...published(),
    events: [{ ...lesson("next", "2026-10-29"), subject: "Информатика" }],
  });
  await userEvent.click(screen.getByRole("button", { name: wb.nextWeek }));
  await screen.findByRole("button", { name: /29 қазан.*Информатика/ });
  await act(async () => finish(published()));
  expect(
    screen.queryByRole("button", { name: /22 қазан.*Қазақ тілі/ }),
  ).not.toBeInTheDocument();
});
