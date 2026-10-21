import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, api } from "./api";
import { VersionsPage } from "./VersionsPage";
import { planningApi } from "./planning-api";
import { expectedVersion, versionApi } from "./publication-api";
import type { PublicationReadiness, VersionDetail } from "./publication-api";
import type { IndependentReport, PlanningData } from "./planning-api";
import { publicationMessages, vm } from "./locales/publication.kk";

vi.mock("./publication-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./publication-api")>()),
  versionApi: {
    list: vi.fn(),
    get: vi.fn(),
    submit: vi.fn(),
    decide: vi.fn(),
    reopen: vi.fn(),
    fork: vi.fn(),
    readiness: vi.fn(),
    publish: vi.fn(),
  },
}));
vi.mock("./planning-api", () => ({ planningApi: { data: vi.fn() } }));
const report = (): IndependentReport => ({
  identity: { draft_id: "version", revision: 7, snapshot_id: "snap" },
  valid: true,
  complete: true,
  errors: [],
  questions: [],
  errors_truncated: false,
  questions_truncated: false,
  conflicts_truncated: false,
  conflicts: [],
  notes: [],
  event_count: 2,
  elapsed_seconds: 0.01,
  check_scope: { context_id: "context", group_ids: ["group"], semester: 1 },
  hours: [],
});
const version = (status: VersionDetail["status"] = "draft"): VersionDetail => ({
  id: "version",
  name: "SYNTHETIC TEST editor draft",
  context_id: "context",
  scope_id: "scope",
  academic_year: "2026-2027",
  data_kind: "synthetic",
  version_number: 2,
  revision: 7,
  workflow_revision: 3,
  status,
  parent_id: null,
  created_at: "2026-10-21T12:00:00Z",
  event_count: 2,
  selection: { group_ids: ["group"], room_ids: ["room"], semester: 1 },
  submission:
    status === "draft"
      ? null
      : { id: "submission", revision: 7, stale: false, report: report() },
  decision:
    status === "approved"
      ? {
          id: "approval",
          revision: 7,
          action: "approve",
          comment: "",
          actor: "Демо бекітуші",
          created_at: "2026-10-21T12:00:00Z",
        }
      : null,
  history: [],
});
const options = (): PlanningData => ({
  contexts: [
    {
      id: "context",
      academic_year: "2026-2027",
      data_kind: "synthetic",
      revision: 1,
      rules_revision: 1,
      rules: null,
    },
  ],
  groups: [{ id: "group", code: "TEST-EDITOR-A", data_kind: "synthetic" }],
  teachers: [],
  rooms: [
    {
      id: "room",
      code: "TEST-101",
      data_kind: "synthetic",
      exclusive: true,
      confirmed: true,
      source: "SYNTHETIC TEST",
      revision: 1,
    },
  ],
  demands: [
    {
      id: "demand",
      context_id: "context",
      group_id: "group",
      subject: "SYNTHETIC Subject 0",
      semester: 1,
    },
  ],
  drafts: [],
});
const readiness = (): PublicationReadiness => ({
  ready: true,
  token: "ready-token",
  version_id: "version",
  revision: 7,
  workflow_revision: 3,
  approval_id: "approval",
  report: report(),
  issues: [],
  issues_truncated: false,
});
const props = () => ({
  scope: "scope",
  userId: "user",
  csrfToken: "csrf",
  canSubmit: true,
  canApprove: false,
  canReject: false,
  canPublish: false,
  canEdit: true,
  onExpired: vi.fn(),
  onOpenDraft: vi.fn(),
  onDirtyChange: vi.fn(),
});
const pendingKey = "smart-joba:publish:user:scope:version";
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(planningApi.data).mockResolvedValue(options());
  vi.mocked(versionApi.list).mockResolvedValue([version()]);
  vi.mocked(versionApi.get).mockResolvedValue(version());
  vi.mocked(versionApi.readiness).mockResolvedValue(readiness());
});
async function loaded() {
  await screen.findByRole("heading", { name: /Демо оқу кестесі/ });
}

it("submits the visible exact content/workflow revisions and original resource IDs", async () => {
  vi.mocked(versionApi.submit).mockResolvedValue(version("submitted"));
  render(<VersionsPage {...props()} />);
  await loaded();
  expect(screen.getByLabelText("Демо топ 101-А")).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: vm.submit }));
  await waitFor(() =>
    expect(versionApi.submit).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 7, workflow_revision: 3 }),
      { group_ids: ["group"], room_ids: ["room"], semester: 1 },
      "csrf",
    ),
  );
  expect(
    screen.queryByRole("button", { name: vm.submit }),
  ).not.toBeInTheDocument();
});

it("keeps an approver's decision text after a revision conflict", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("submitted"));
  vi.mocked(versionApi.decide).mockRejectedValue(
    new ApiError(409, "VERSION_STALE"),
  );
  const p = props();
  render(
    <VersionsPage
      {...p}
      canSubmit={false}
      canEdit={false}
      canApprove
      canReject
    />,
  );
  await loaded();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(vm.reason), "Күнін тексеру керек");
  await user.click(screen.getByRole("button", { name: vm.approve }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    publicationMessages.VERSION_STALE,
  );
  expect(screen.getByLabelText(vm.reason)).toHaveValue("Күнін тексеру керек");
  expect(versionApi.decide).toHaveBeenCalledWith(
    expect.objectContaining({ revision: 7, workflow_revision: 3 }),
    "approve",
    "Күнін тексеру керек",
    "csrf",
  );
  expect(p.onDirtyChange).toHaveBeenLastCalledWith(true);
});

it("requires a rejection reason and does not offer editing to an approver", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("submitted"));
  render(
    <VersionsPage
      {...props()}
      canSubmit={false}
      canEdit={false}
      canApprove
      canReject
    />,
  );
  await loaded();
  expect(screen.getByRole("button", { name: vm.reject })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: vm.fork }),
  ).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText(vm.reason), "   ");
  expect(screen.getByRole("button", { name: vm.reject })).toBeDisabled();
});

it("separates approval from publication permission", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  render(
    <VersionsPage {...props()} canEdit={false} canSubmit={false} canApprove />,
  );
  await loaded();
  expect(
    screen.queryByRole("button", { name: vm.publish }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: vm.check }),
  ).not.toBeInTheDocument();
});

it("requires a bound readiness result before publishing", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  vi.mocked(versionApi.publish).mockResolvedValue({
    publication_id: "publication",
    version_id: "version",
    version_number: 2,
    revision: 7,
    published_at: "2026-10-21T12:00:00Z",
  });
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  const user = userEvent.setup();
  expect(screen.getByRole("button", { name: vm.publish })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: vm.check }));
  await user.click(screen.getByRole("button", { name: vm.publish }));
  await waitFor(() =>
    expect(versionApi.publish).toHaveBeenCalledWith(
      "version",
      expect.objectContaining({
        expected_revision: 7,
        expected_workflow_revision: 3,
        approval_id: "approval",
        readiness_token: "ready-token",
        idempotency_key: expect.any(String),
      }),
      "csrf",
    ),
  );
  expect(await screen.findByText(vm.published)).toBeVisible();
});

it("does not enable publication when shared-resource readiness is blocked", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  vi.mocked(versionApi.readiness).mockResolvedValue({
    ...readiness(),
    ready: false,
    issues: [
      {
        code: "PUBLICATION_RESOURCE_CONFLICT",
        resource_name: "TEST-101",
        date: "2026-09-01",
      },
    ],
  });
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  await userEvent.click(screen.getByRole("button", { name: vm.check }));
  expect(
    await screen.findByRole("heading", { name: vm.blocked }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: vm.publish })).toBeDisabled();
  expect(screen.getByText(/Демо кабинет 101/)).toBeVisible();
});

it("retries the identical publication command after an uncertain network failure", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  vi.mocked(versionApi.publish)
    .mockRejectedValueOnce(new ApiError(0, "network_error"))
    .mockResolvedValueOnce({
      publication_id: "publication",
      version_id: "version",
      version_number: 2,
      revision: 7,
      published_at: "2026-10-21T12:00:00Z",
    });
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: vm.check }));
  await user.click(screen.getByRole("button", { name: vm.publish }));
  await screen.findByText(vm.pending);
  const command = JSON.parse(localStorage.getItem(pendingKey)!);
  await user.click(screen.getByRole("button", { name: vm.retryPublish }));
  await waitFor(() => expect(versionApi.publish).toHaveBeenCalledTimes(2));
  expect(vi.mocked(versionApi.publish).mock.calls[0][1]).toEqual(command);
  expect(vi.mocked(versionApi.publish).mock.calls[1][1]).toEqual(command);
  await waitFor(() => expect(localStorage.getItem(pendingKey)).toBeNull());
});

it("restores an uncertain publication command after reload instead of generating another key", async () => {
  const command = {
    ...expectedVersion(version("approved")),
    approval_id: "approval",
    readiness_token: "older-token",
    idempotency_key: "saved-key",
  };
  localStorage.setItem(pendingKey, JSON.stringify(command));
  vi.mocked(versionApi.get).mockResolvedValue(version("published"));
  vi.mocked(versionApi.publish).mockRejectedValue(
    new ApiError(409, "PUBLICATION_BUSY"),
  );
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  await userEvent.click(screen.getByRole("button", { name: vm.retryPublish }));
  await waitFor(() =>
    expect(versionApi.publish).toHaveBeenCalledWith("version", command, "csrf"),
  );
  expect(versionApi.readiness).not.toHaveBeenCalled();
  expect(JSON.parse(localStorage.getItem(pendingKey)!)).toEqual(command);
});

it("invalidates readiness after a definite stale refusal while keeping the version", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  vi.mocked(versionApi.publish).mockRejectedValue(
    new ApiError(409, "PUBLICATION_READINESS_STALE"),
  );
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: vm.check }));
  await user.click(screen.getByRole("button", { name: vm.publish }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    publicationMessages.PUBLICATION_READINESS_STALE,
  );
  expect(screen.getByRole("button", { name: vm.publish })).toBeDisabled();
  expect(localStorage.getItem(pendingKey)).toBeNull();
});

it("preserves the operation body through CSRF refresh", async () => {
  vi.mocked(versionApi.get).mockResolvedValue(version("approved"));
  vi.mocked(versionApi.publish)
    .mockRejectedValueOnce(new ApiError(403, "CSRF_INVALID"))
    .mockResolvedValueOnce({
      publication_id: "publication",
      version_id: "version",
      version_number: 2,
      revision: 7,
      published_at: "2026-10-21T12:00:00Z",
    });
  const session = vi.spyOn(api, "session").mockResolvedValue({
    user: { id: "user" } as never,
    csrf_token: "fresh-csrf",
  });
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: vm.check }));
  await user.click(screen.getByRole("button", { name: vm.publish }));
  await waitFor(() => expect(versionApi.publish).toHaveBeenCalledTimes(2));
  const calls = vi.mocked(versionApi.publish).mock.calls;
  expect(calls[1][1]).toEqual(calls[0][1]);
  expect(calls[1][2]).toBe("fresh-csrf");
  session.mockRestore();
});

it("clears closed version data after session expiration", async () => {
  vi.mocked(versionApi.get)
    .mockResolvedValueOnce(version("submitted"))
    .mockRejectedValueOnce(new ApiError(401, "AUTH_REQUIRED"));
  const p = props();
  render(<VersionsPage {...p} canApprove />);
  await loaded();
  await userEvent.click(screen.getByRole("button", { name: vm.reload }));
  await waitFor(() => expect(p.onExpired).toHaveBeenCalledOnce());
  expect(
    screen.queryByRole("heading", { name: /Демо оқу кестесі/ }),
  ).not.toBeInTheDocument();
});

it("opens the exact version handed off by the editor and keeps it through parent rerenders", async () => {
  const newer = { ...version(), id: "newer", version_number: 3 };
  vi.mocked(versionApi.list).mockResolvedValue([newer, version()]);
  const p = props();
  const selected = vi.fn();
  const rendered = render(
    <VersionsPage
      {...p}
      initialVersionId="version"
      onSelectedVersion={selected}
    />,
  );
  await loaded();
  expect(versionApi.get).toHaveBeenCalledWith("version");
  expect(selected).toHaveBeenCalledWith("version");
  rendered.rerender(
    <VersionsPage
      {...p}
      initialVersionId="newer"
      onSelectedVersion={selected}
      onExpired={vi.fn()}
    />,
  );
  expect(versionApi.list).toHaveBeenCalledTimes(1);
  expect(versionApi.get).toHaveBeenCalledTimes(1);
});

it("refreshes the superseded version's archive status after successful publication", async () => {
  const approved = version("approved"),
    published = version("published");
  const previous = {
    ...version("published"),
    id: "previous",
    version_number: 1,
  };
  vi.mocked(versionApi.list)
    .mockResolvedValueOnce([approved, previous])
    .mockResolvedValueOnce([published, { ...previous, status: "archived" }]);
  vi.mocked(versionApi.get)
    .mockResolvedValueOnce(approved)
    .mockResolvedValueOnce(published);
  vi.mocked(versionApi.publish).mockResolvedValue({
    publication_id: "publication",
    version_id: "version",
    version_number: 2,
    revision: 7,
    published_at: "2026-10-21T12:00:00Z",
  });
  render(<VersionsPage {...props()} canPublish />);
  await loaded();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: vm.check }));
  await user.click(screen.getByRole("button", { name: vm.publish }));
  expect(
    await screen.findByRole("option", { name: /Нұсқа 1.*Мұрағат/ }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: /Нұсқа 1.*Жарияланды/ }),
  ).not.toBeInTheDocument();
});
