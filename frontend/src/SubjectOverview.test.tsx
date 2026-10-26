import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { SubjectOverview, SubjectsPage } from "./SubjectOverview";
import { loadPublishedSubjects } from "./portal/subjects";
import { publicationApi } from "./publication-api";
import type { PublishedView } from "./publication-api";
import type { Workspace } from "./api";
import { ApiError } from "./api";
import { portal as p } from "./locales/portal.kk";

vi.mock("./publication-api", () => ({
  publicationApi: { list: vi.fn(), get: vi.fn() },
}));
const workspace: Workspace = {
  scope: { id: "scope-a", name: "Test", is_demo: true },
  permissions: ["publication.read.group"],
  role_codes: ["student"],
  stage: 6,
};
const page = (): PublishedView => ({
  publication_id: "pub-a",
  version_id: "version-a",
  version_number: 5,
  revision: 2,
  published_at: "2026-10-21T12:00:00Z",
  name: "Test",
  context_id: "context-a",
  academic_year: "2026-2027",
  data_kind: "college",
  semester: 1,
  scope_name: "Test",
  timezone: "Asia/Almaty",
  is_current: true,
  groups: ["Unrestricted summary label"],
  event_count: 100,
  external_verified: false,
  events: [
    {
      id: "event-a",
      subject: "Ағылшын тілі",
      group: "101-А",
      teacher: "Оқытушы А",
      room: "101",
      date: "2026-10-28",
      start: "09:00",
      end: "10:30",
    },
    {
      id: "event-b",
      subject: "Қазақ тілі",
      group: "101-А",
      teacher: "Оқытушы Б",
      room: "102",
      date: "2026-10-29",
      start: "11:00",
      end: "12:30",
    },
  ],
  total: 2,
  offset: 0,
  limit: 100,
  resources: {
    group: [{ id: "group-a", name: "101-А" }],
    teacher: [],
    room: [],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publicationApi.list).mockResolvedValue([page()]);
  vi.mocked(publicationApi.get).mockResolvedValue(page());
});
const setup = (props = {}) =>
  render(
    <SubjectOverview
      workspace={workspace}
      sources={[page()]}
      onRetry={vi.fn()}
      onExpired={vi.fn()}
      onOpenPublication={vi.fn()}
      {...props}
    />,
  );

it("loads every authorized page before counting subjects and ignores summary totals and names", async () => {
  const value = page();
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce({ ...value, limit: 1, events: [value.events[0]] })
    .mockResolvedValueOnce({
      ...value,
      limit: 1,
      offset: 1,
      events: [value.events[1]],
    });
  const result = await loadPublishedSubjects([value], () => true);
  expect(result).toHaveLength(2);
  expect(result?.flatMap((subject) => subject.events)).toHaveLength(2);
  expect(publicationApi.get).toHaveBeenNthCalledWith(2, "pub-a", {
    start: "",
    end: "",
    view: "group",
    resource_id: "",
    offset: 1,
  });
});
it("does not merge equally named subjects from different publications", async () => {
  vi.mocked(publicationApi.get).mockImplementation(async (id) => ({
    ...page(),
    publication_id: id,
  }));
  const result = await loadPublishedSubjects(
    [page(), { ...page(), publication_id: "pub-b" }],
    () => true,
  );
  expect(result).toHaveLength(4);
  expect(new Set(result?.map((subject) => subject.key)).size).toBe(4);
});
it("never loads archived publications", async () => {
  expect(
    await loadPublishedSubjects([{ ...page(), is_current: false }], () => true),
  ).toEqual([]);
  expect(publicationApi.get).not.toHaveBeenCalled();
});
it("requires refresh if a publication becomes archived between list and detail requests", async () => {
  vi.mocked(publicationApi.get).mockResolvedValue({
    ...page(),
    is_current: false,
  });
  await expect(
    loadPublishedSubjects([page()], () => true),
  ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_STALE" });
});
it("discards the whole projection when a later page fails", async () => {
  const value = page();
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce({ ...value, limit: 1, events: [value.events[0]] })
    .mockRejectedValueOnce(new ApiError(0, "NETWORK_ERROR"));
  setup();
  expect(await screen.findByRole("alert")).toHaveTextContent(p.loadError);
  expect(
    screen.queryByRole("link", { name: `${p.openSubject}: Ағылшын тілі` }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(p.noSubjects)).not.toBeInTheDocument();
});
it("rejects mixed publication revisions", async () => {
  vi.mocked(publicationApi.get).mockResolvedValue({ ...page(), revision: 3 });
  await expect(
    loadPublishedSubjects([page()], () => true),
  ).rejects.toMatchObject({ status: 409 });
});
it("does not expose a partial result when another publication fails", async () => {
  vi.mocked(publicationApi.get).mockImplementation(async (id) => {
    if (id === "pub-b") throw new ApiError(403, "FORBIDDEN");
    return page();
  });
  await expect(
    loadPublishedSubjects(
      [page(), { ...page(), publication_id: "pub-b" }],
      () => true,
    ),
  ).rejects.toMatchObject({ status: 403 });
});
it("ignores results after disposal", async () => {
  let active = true;
  vi.mocked(publicationApi.get).mockImplementation(async () => {
    active = false;
    return page();
  });
  expect(await loadPublishedSubjects([page()], () => active)).toBeNull();
});
it("shows authorized event facts and searches subjects, groups and teachers", async () => {
  setup();
  expect(await screen.findByText("Ағылшын тілі")).toBeVisible();
  expect(
    screen.queryByText("Unrestricted summary label"),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(p.search), {
    target: { value: "Оқытушы Б" },
  });
  expect(screen.queryByText("Ағылшын тілі")).not.toBeInTheDocument();
  expect(screen.getByText("Қазақ тілі")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("1 пән");
});
it("distinguishes empty search from unavailable publication data", async () => {
  setup();
  await screen.findByText("Ағылшын тілі");
  fireEvent.change(screen.getByLabelText(p.search), {
    target: { value: "absent" },
  });
  expect(screen.getByText(p.noMatches)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: p.clearSearch }));
  expect(screen.getByText("Ағылшын тілі")).toBeVisible();
});
it("opens read-only subject lessons and precise publication date without inventing resource IDs", async () => {
  const open = vi.fn();
  setup({ onOpenPublication: open });
  await userEvent.click(
    await screen.findByRole("link", { name: `${p.openSubject}: Ағылшын тілі` }),
  );
  expect(screen.getByRole("table")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: /Сақтау/ }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: /^Кестеде қарау:/ }),
  );
  expect(open).toHaveBeenCalledWith("pub-a", "2026-10-28", "");
  await userEvent.click(screen.getByRole("button", { name: p.backToSubjects }));
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});
it("routes preview cards to the full subject page", async () => {
  const open = vi.fn();
  setup({ preview: true, onOpenSubject: open });
  await userEvent.click(
    await screen.findByRole("link", { name: `${p.openSubject}: Ағылшын тілі` }),
  );
  expect(open).toHaveBeenCalledWith(JSON.stringify(["pub-a", "Ағылшын тілі"]));
});
it("does not request reader endpoints without server-provided reader permission", async () => {
  render(
    <SubjectsPage
      workspace={{ ...workspace, permissions: [] }}
      onExpired={vi.fn()}
      onOpenPublication={vi.fn()}
    />,
  );
  expect(await screen.findByText(p.noAccess)).toBeVisible();
  expect(publicationApi.list).not.toHaveBeenCalled();
  expect(publicationApi.get).not.toHaveBeenCalled();
});
it("expires the account and clears data on 401", async () => {
  const expired = vi.fn();
  vi.mocked(publicationApi.get).mockRejectedValue(
    new ApiError(401, "AUTH_REQUIRED"),
  );
  setup({ onExpired: expired });
  await screen.findByRole("alert");
  expect(expired).toHaveBeenCalledOnce();
  expect(screen.queryByText("Ағылшын тілі")).not.toBeInTheDocument();
});
it("hides previous scope subjects and ignores its late response", async () => {
  let resolveOld!: (value: PublishedView) => void;
  vi.mocked(publicationApi.get).mockReturnValueOnce(
    new Promise((resolve) => {
      resolveOld = resolve;
    }),
  );
  const callbacks = { onExpired: vi.fn(), onOpenPublication: vi.fn() };
  const view = render(<SubjectsPage workspace={workspace} {...callbacks} />);
  await waitFor(() => expect(publicationApi.get).toHaveBeenCalledOnce());
  vi.mocked(publicationApi.list).mockResolvedValue([]);
  view.rerender(
    <SubjectsPage
      workspace={{ ...workspace, scope: { ...workspace.scope, id: "scope-b" } }}
      {...callbacks}
    />,
  );
  resolveOld(page());
  await screen.findByText(p.noPublication);
  expect(screen.queryByText("Ағылшын тілі")).not.toBeInTheDocument();
  expect(publicationApi.list).toHaveBeenLastCalledWith("scope-b");
});
it("retries failed listing and recovers without a false empty success", async () => {
  vi.mocked(publicationApi.list)
    .mockRejectedValueOnce(new ApiError(0, "NETWORK_ERROR"))
    .mockResolvedValue([page()]);
  render(
    <SubjectsPage
      workspace={workspace}
      onExpired={vi.fn()}
      onOpenPublication={vi.fn()}
    />,
  );
  await screen.findByRole("alert");
  expect(screen.queryByText(p.noPublication)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Қайталап көру" }));
  expect(await screen.findByText("Ағылшын тілі")).toBeVisible();
});
