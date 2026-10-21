import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { PlanningPage } from "./PlanningPage";
import { planningApi } from "./planning-api";
import type {
  PlanningData,
  Preview,
  SolverJob,
  IndependentReport,
  SavedReport,
} from "./planning-api";
import { ApiError } from "./api";
import { pm, jobStatuses, planningMessages } from "./locales/planning.kk";

vi.mock("./planning-api", () => ({
  planningApi: {
    data: vi.fn(),
    rules: vi.fn(),
    preview: vi.fn(),
    create: vi.fn(),
    jobs: vi.fn(),
    job: vi.fn(),
    cancel: vi.fn(),
    validate: vi.fn(),
    reports: vi.fn(),
  },
}));
const data = (): PlanningData => ({
  contexts: [
    {
      id: "ctx",
      academic_year: "2026-2027",
      data_kind: "synthetic",
      revision: 1,
      rules_revision: 0,
      rules: null,
    },
  ],
  groups: [{ id: "group", code: "TEST-GROUP", data_kind: "synthetic" }],
  teachers: [],
  rooms: [
    {
      id: "room",
      code: "TEST-101",
      data_kind: "synthetic",
      confirmed: true,
      exclusive: true,
      source: "SYNTHETIC",
      revision: 1,
    },
  ],
  demands: [
    {
      id: "demand",
      context_id: "ctx",
      group_id: "group",
      subject: "SYNTHETIC subject",
      semester: 1,
    },
  ],
  drafts: [],
});
const ready = (): Preview => ({
  token: "snapshot-token",
  ready: true,
  questions: [],
  question_count: 0,
  demands: 1,
  pins: 0,
  external_verified: false,
});
const job = (status = "feasible"): SolverJob => ({
  id: "test-job",
  context_id: "ctx",
  status,
  execution_status: status,
  stage: status === "running" ? "searching" : "finished",
  stale: false,
  elapsed_seconds: 2.5,
  created_at: "2026-10-21T00:00:00Z",
  algorithm_version: "cp-sat-whole-group-v1",
  parameters: {
    seconds: 30,
    workers: 1,
    memory_mib: 768,
    process_wall_seconds: 60,
  },
  snapshot_id: "snapshot",
  group_ids: ["group"],
  semester: 1,
  result_draft_id: "new-draft",
  cancel_requested: false,
  result: null,
});
const report = (): IndependentReport => ({
  identity: { draft_id: "new-draft", revision: 1, snapshot_id: "snapshot" },
  valid: true,
  complete: true,
  errors: [],
  questions: [],
  errors_truncated: false,
  questions_truncated: false,
  conflicts_truncated: false,
  conflicts: [],
  notes: ["EXTERNAL_OCCUPANCY_UNVERIFIED"],
  event_count: 2,
  elapsed_seconds: 0.01,
  check_scope: { context_id: "ctx", group_ids: ["group"], semester: 1 },
  hours: [
    {
      demand_id: "demand",
      subject: "SYNTHETIC subject",
      group: "TEST-GROUP",
      required: "4",
      planned: "4",
      remaining: "0",
    },
  ],
});
function setup(
  canRun = true,
  canRead = true,
  canManage = false,
  open = vi.fn(),
  expired = vi.fn(),
) {
  return render(
    <PlanningPage
      scope="scope"
      csrfToken="csrf"
      canRun={canRun}
      canRead={canRead}
      canManage={canManage}
      onExpired={expired}
      onOpenDraft={open}
    />,
  );
}
async function selectInputs() {
  const user = userEvent.setup();
  await user.click(await screen.findByLabelText("TEST-GROUP"));
  await user.click(screen.getByLabelText("TEST-101"));
  return user;
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(planningApi.data).mockResolvedValue(data());
  vi.mocked(planningApi.jobs).mockResolvedValue([]);
  vi.mocked(planningApi.preview).mockResolvedValue(ready());
  vi.mocked(planningApi.reports).mockResolvedValue([]);
});

it("requires readiness and invalidates it when the selected scope changes", async () => {
  setup();
  const user = await selectInputs();
  expect(screen.getByRole("button", { name: pm.start })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  expect(await screen.findByText(pm.ready)).toBeVisible();
  expect(screen.getByRole("button", { name: pm.start })).toBeEnabled();
  await user.click(screen.getByLabelText("TEST-GROUP"));
  expect(screen.getByRole("button", { name: pm.start })).toBeDisabled();
});

it("keeps blocking input questions and does not allow start", async () => {
  vi.mocked(planningApi.preview).mockResolvedValue({
    ...ready(),
    ready: false,
    questions: [
      { code: "ASSIGNMENT_UNCONFIRMED", source: { coordinate: "K12" } },
    ],
    question_count: 1,
  });
  setup();
  const user = await selectInputs();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  expect(await screen.findByText(pm.blocked)).toBeVisible();
  expect(screen.getByText(/K12/)).toBeVisible();
  expect(screen.getByRole("button", { name: pm.start })).toBeDisabled();
});

it("starts a job and opens its exact result draft", async () => {
  const open = vi.fn();
  vi.mocked(planningApi.create).mockResolvedValue(job());
  vi.mocked(planningApi.job).mockResolvedValue(job());
  setup(true, true, false, open);
  const user = await selectInputs();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  await screen.findByText(pm.ready);
  await user.click(screen.getByRole("button", { name: pm.start }));
  await user.click(await screen.findByRole("button", { name: pm.open }));
  expect(open).toHaveBeenCalledWith("new-draft");
  expect(planningApi.create).toHaveBeenCalledWith(
    "scope",
    expect.objectContaining({ group_ids: ["group"], room_ids: ["room"] }),
    "snapshot-token",
    30,
    "csrf",
  );
});

it("restores a saved running job by ID and shows stage and time without percent", async () => {
  const running = job("running");
  running.result_draft_id = null;
  vi.mocked(planningApi.jobs).mockResolvedValue([running]);
  vi.mocked(planningApi.job).mockResolvedValue(running);
  localStorage.setItem("smart-joba-job:scope", running.id);
  setup();
  expect(
    await screen.findByText(jobStatuses.running, { selector: "p" }),
  ).toBeVisible();
  expect(screen.getByText(/Шешім іздеу/)).toHaveTextContent("2.5");
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: pm.cancel })).toBeEnabled();
});

it("marks stale results and prevents opening them as current", async () => {
  const stale = {
    ...job(),
    status: "stale",
    stale: true,
    result: { validation: report() },
  };
  vi.mocked(planningApi.jobs).mockResolvedValue([stale]);
  vi.mocked(planningApi.job).mockResolvedValue(stale);
  setup();
  expect(await screen.findByText(pm.stale)).toBeVisible();
  expect(screen.getByText(pm.reportStale)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: pm.open }),
  ).not.toBeInTheDocument();
});

it("approver can see results and validation but cannot run or cancel", async () => {
  vi.mocked(planningApi.jobs).mockResolvedValue([job("running")]);
  vi.mocked(planningApi.job).mockResolvedValue(job("running"));
  setup(false);
  await screen.findByText(jobStatuses.running, { selector: "p" });
  expect(
    screen.queryByRole("button", { name: pm.start }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: pm.cancel }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: pm.check })).toBeDisabled();
});

it("preserves admin inputs on a revision conflict and leaves them dirty", async () => {
  vi.mocked(planningApi.rules).mockRejectedValue(
    new ApiError(409, "PLANNING_STALE"),
  );
  setup(false, false, true);
  const user = userEvent.setup();
  const capacity = await screen.findByLabelText(`${pm.capacity}: TEST-101`);
  await user.type(capacity, "25");
  await user.click(screen.getByRole("button", { name: pm.save }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    planningMessages.PLANNING_STALE,
  );
  expect(capacity).toHaveValue(25);
  expect(screen.getByText(pm.dirty)).toBeVisible();
  expect(screen.getByRole("button", { name: pm.reload })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: pm.start }),
  ).not.toBeInTheDocument();
});

it("does not invent capacity or confirm unknown conditions in a new profile", async () => {
  setup(false, false, true);
  expect(await screen.findByLabelText(`${pm.capacity}: TEST-101`)).toHaveValue(
    null,
  );
  expect(screen.getByLabelText(pm.confirm)).not.toBeChecked();
  expect(screen.getByLabelText(pm.external)).not.toBeChecked();
});

it("retains selected inputs after a network error", async () => {
  vi.mocked(planningApi.preview).mockRejectedValue(
    new ApiError(0, "network_error"),
  );
  setup();
  const user = await selectInputs();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  expect(await screen.findByRole("alert")).toHaveTextContent(pm.connection);
  expect(screen.getByLabelText("TEST-GROUP")).toBeChecked();
  expect(screen.getByLabelText("TEST-101")).toBeChecked();
});

it("redirects an expired session instead of showing a false result", async () => {
  const expired = vi.fn();
  vi.mocked(planningApi.preview).mockRejectedValue(
    new ApiError(401, "AUTH_REQUIRED"),
  );
  setup(true, true, false, vi.fn(), expired);
  const user = await selectInputs();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  await waitFor(() => expect(expired).toHaveBeenCalled());
  expect(screen.queryByText(pm.ready)).not.toBeInTheDocument();
});

it("validates the revision selected by the user without silently fetching a newer one", async () => {
  const loaded = data();
  loaded.drafts = [
    {
      id: "old-draft",
      context_id: "ctx",
      name: "SYNTHETIC revision",
      revision: 7,
    },
  ];
  vi.mocked(planningApi.data).mockResolvedValue(loaded);
  vi.mocked(planningApi.validate).mockRejectedValue(
    new ApiError(409, "EDITOR_STALE"),
  );
  setup();
  const user = await selectInputs();
  await user.selectOptions(screen.getByLabelText(pm.draft), "old-draft");
  await user.click(screen.getByRole("button", { name: pm.check }));
  expect(planningApi.validate).toHaveBeenCalledWith(
    "old-draft",
    7,
    expect.objectContaining({ group_ids: ["group"] }),
    "csrf",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    planningMessages.EDITOR_STALE,
  );
});

it("requires reconfirmation when a saved profile lacks newly added catalog entries", async () => {
  const loaded = data();
  loaded.contexts[0].rules = {
    confirmed: true,
    source: "SYNTHETIC confirmed earlier",
    external_confirmed: false,
    external_source: "",
    groups: [],
    rooms: [{ room_id: "room", capacity: 30, features: [] }],
    needs: [],
    availability: [],
    busy: [],
  };
  loaded.contexts[0].rules_revision = 1;
  vi.mocked(planningApi.data).mockResolvedValue(loaded);
  setup(false, false, true);
  expect(await screen.findByLabelText(pm.confirm)).not.toBeChecked();
  expect(screen.getByLabelText(`${pm.sizes}: TEST-GROUP`)).toHaveValue(null);
});

it("allows comma-separated equipment input and normalizes it at save", async () => {
  vi.mocked(planningApi.rules).mockResolvedValue({
    revision: 1,
    document: {
      confirmed: false,
      source: "",
      external_confirmed: false,
      external_source: "",
      groups: [],
      rooms: [],
      needs: [],
      availability: [],
      busy: [],
    },
  });
  setup(false, false, true);
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText(`${pm.features}: TEST-101`),
    "projector, pc",
  );
  await user.click(screen.getByRole("button", { name: pm.save }));
  await waitFor(() =>
    expect(planningApi.rules).toHaveBeenCalledWith(
      "ctx",
      0,
      expect.objectContaining({
        rooms: [expect.objectContaining({ features: ["projector", "pc"] })],
      }),
      "csrf",
    ),
  );
});

it("preserves selected scope when the parent refreshes its session callback", async () => {
  const root = setup();
  const user = await selectInputs();
  await user.click(screen.getByRole("button", { name: pm.preview }));
  await screen.findByText(pm.ready);
  root.rerender(
    <PlanningPage
      scope="scope"
      csrfToken="refreshed-csrf"
      canRun
      canRead
      canManage={false}
      onExpired={() => {}}
      onOpenDraft={() => {}}
    />,
  );
  await waitFor(() =>
    expect(screen.getByLabelText("TEST-GROUP")).toBeChecked(),
  );
  expect(screen.getByLabelText("TEST-101")).toBeChecked();
  expect(screen.getByRole("button", { name: pm.start })).toBeEnabled();
  expect(planningApi.data).toHaveBeenCalledTimes(1);
});

it("waits for prior reports before checking and keeps the selected draft fixed during the request", async () => {
  const loaded = data();
  loaded.drafts = [
    { id: "draft", context_id: "ctx", name: "SYNTHETIC draft", revision: 1 },
  ];
  vi.mocked(planningApi.data).mockResolvedValue(loaded);
  let resolveReports!: (value: SavedReport[]) => void;
  vi.mocked(planningApi.reports).mockReturnValue(
    new Promise((resolve) => {
      resolveReports = resolve;
    }),
  );
  setup();
  const user = await selectInputs();
  await user.selectOptions(screen.getByLabelText(pm.draft), "draft");
  expect(screen.getByRole("button", { name: pm.check })).toBeDisabled();
  resolveReports([]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: pm.check })).toBeEnabled(),
  );
});
