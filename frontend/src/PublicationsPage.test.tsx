import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { PublicationsPage } from "./PublicationsPage";
import { publicationApi } from "./publication-api";
import type { PublishedView } from "./publication-api";
import { vm } from "./locales/publication.kk";

vi.mock("./publication-api", () => ({
  publicationApi: { list: vi.fn(), get: vi.fn() },
}));
const view = (): PublishedView => ({
  publication_id: "publication",
  version_id: "version",
  version_number: 4,
  revision: 7,
  published_at: "2026-10-21T12:00:00Z",
  name: "SYNTHETIC TEST editor draft",
  context_id: "context",
  academic_year: "2026-2027",
  data_kind: "synthetic",
  semester: 1,
  scope_name: "Демо орта",
  timezone: "Asia/Almaty",
  is_current: true,
  groups: ["TEST-EDITOR-A"],
  event_count: 1,
  external_verified: false,
  events: [
    {
      id: "event",
      date: "2026-09-01",
      start: "09:00",
      end: "10:30",
      subject: "SYNTHETIC Subject 0",
      group: "TEST-EDITOR-A",
      teacher: "SYNTHETIC Editor Teacher A",
      room: "TEST-101",
    },
  ],
  total: 1,
  offset: 0,
  limit: 100,
  resources: {
    group: [{ id: "own-group", name: "TEST-EDITOR-A" }],
    teacher: [{ id: "own-teacher", name: "SYNTHETIC Editor Teacher A" }],
    room: [{ id: "room", name: "TEST-101" }],
  },
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(publicationApi.list).mockResolvedValue([view()]);
  vi.mocked(publicationApi.get).mockResolvedValue(view());
});

it("shows selected publication number, date, scope and readable demo names", async () => {
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  expect(await screen.findByRole("table")).toHaveTextContent("Нұсқа 4");
  expect(screen.getByRole("table")).toHaveTextContent("Ағылшын тілі · демо");
  expect(screen.getByRole("table")).toHaveTextContent("Демо оқытушы А");
  expect(screen.getByText("Демо орта")).toBeVisible();
  expect(screen.getByText(vm.external)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: vm.approve }),
  ).not.toBeInTheDocument();
});

it("keeps dates and sends only a server-provided resource ID for the chosen view", async () => {
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  await screen.findByRole("table");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(vm.start), "2026-09-01");
  await user.type(screen.getByLabelText(vm.end), "2026-09-08");
  await user.selectOptions(screen.getByLabelText(vm.view), "teacher");
  await user.selectOptions(screen.getByLabelText(vm.resource), "own-teacher");
  await user.click(screen.getByRole("button", { name: vm.show }));
  await waitFor(() =>
    expect(publicationApi.get).toHaveBeenLastCalledWith("publication", {
      start: "2026-09-01",
      end: "2026-09-08",
      view: "teacher",
      resource_id: "own-teacher",
      offset: 0,
    }),
  );
});

it("clears previously visible closed events when access is revoked on the next read", async () => {
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce(view())
    .mockRejectedValueOnce(new ApiError(403, "ACCESS_DENIED"));
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  await screen.findByRole("table");
  await userEvent.click(screen.getByRole("button", { name: vm.show }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.queryByText("Ағылшын тілі · демо")).not.toBeInTheDocument();
});

it("clears publications and requests login after session expiration", async () => {
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce(view())
    .mockRejectedValueOnce(new ApiError(401, "AUTH_REQUIRED"));
  const expired = vi.fn();
  render(<PublicationsPage scope="scope" onExpired={expired} />);
  await screen.findByRole("table");
  await userEvent.click(screen.getByRole("button", { name: vm.show }));
  await waitFor(() => expect(expired).toHaveBeenCalledOnce());
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("does not leave an old schedule visible when the current publication list becomes empty", async () => {
  vi.mocked(publicationApi.list)
    .mockResolvedValueOnce([view()])
    .mockResolvedValueOnce([]);
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  await screen.findByRole("table");
  await userEvent.click(screen.getByRole("button", { name: vm.refresh }));
  expect(await screen.findByText(vm.noPublications)).toBeVisible();
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
});

it("does not rename real college source labels even when they match old fixture strings", async () => {
  const real = { ...view(), data_kind: "college" };
  vi.mocked(publicationApi.list).mockResolvedValue([real]);
  vi.mocked(publicationApi.get).mockResolvedValue(real);
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  expect(await screen.findByRole("table")).toHaveTextContent(
    "SYNTHETIC Subject 0",
  );
  expect(screen.getByRole("table")).not.toHaveTextContent(
    "Ағылшын тілі · демо",
  );
});

it("preserves entered date filters when a refresh fails", async () => {
  vi.mocked(publicationApi.get)
    .mockResolvedValueOnce(view())
    .mockRejectedValueOnce(new ApiError(0, "network_error"));
  render(<PublicationsPage scope="scope" onExpired={vi.fn()} />);
  await screen.findByRole("table");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(vm.start), "2026-09-01");
  await user.type(screen.getByLabelText(vm.end), "2026-09-08");
  await user.click(screen.getByRole("button", { name: vm.refresh }));
  await screen.findByRole("alert");
  expect(screen.getByLabelText(vm.start)).toHaveValue("2026-09-01");
  expect(screen.getByLabelText(vm.end)).toHaveValue("2026-09-08");
});
