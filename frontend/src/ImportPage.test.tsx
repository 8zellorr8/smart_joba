import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImportPage } from "./ImportPage";
import { ApiError, api } from "./api";
import { fields, importsApi } from "./imports-api";
import type { ImportBatch } from "./imports-api";
import { im, importErrors, fieldNames } from "./locales/imports.kk";

vi.mock("./imports-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./imports-api")>()),
  importsApi: {
    list: vi.fn(),
    get: vi.fn(),
    preview: vi.fn(),
    review: vi.fn(),
    apply: vi.fn(),
    history: vi.fn(),
  },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: { session: vi.fn() },
}));

function sample(): ImportBatch {
  const normalized = {
    teacher: "Синтетикалық мұғалім",
    subject: "Синтетикалық пән",
    index: "TEST",
    group: "TEST-A",
    course: 1,
    room: null,
    weekly_hours: "2",
    subgroup: null,
    specialty: "Үлгі",
    qualification: "Үлгі",
    semester_hours: "36",
    semester: 1,
    whole_group: false,
  };
  return {
    id: "batch",
    filename: "synthetic.xlsx",
    sha256: "hash",
    sheet: "Жүктеме",
    range: "A1:L237",
    template: "s1-v1",
    hour_unit: "academic_hour",
    status: "preview",
    revision: 1,
    base_revision: 0,
    context_revision: 0,
    stale: false,
    academic_year: "2026-2027",
    data_kind: "synthetic",
    offset: 0,
    limit: 25,
    summary: {
      rows: 1,
      new: 1,
      changed: 0,
      unchanged: 0,
      missing: 0,
      open_issues: 2,
      ready: 0,
      duplicate_rows: 0,
    },
    missing: [],
    rows: [
      {
        id: "row",
        source_row: 2,
        normalized,
        raw: Object.fromEntries(
          fields.map((field) => [
            field,
            {
              value: field === "room" ? 0 : normalized[field],
              formula: null,
              cached: null,
            },
          ]),
        ) as ImportBatch["rows"][0]["raw"],
        corrections: {},
        references_confirmed: false,
        action: "new",
        previous: null,
        demand_id: null,
        issues: [
          {
            id: "room-issue",
            code: "ROOM_UNSPECIFIED",
            field: "room",
            blocking: true,
            coordinate: "F2",
          },
          {
            id: "subgroup-issue",
            code: "SUBGROUP_UNSPECIFIED",
            field: "subgroup",
            blocking: true,
            coordinate: "H2",
          },
        ],
      },
    ],
  };
}
function setup(canWrite = true) {
  return render(
    <ImportPage
      scope="scope"
      csrfToken="csrf"
      canWrite={canWrite}
      onExpired={vi.fn()}
    />,
  );
}
async function existing() {
  const batch = sample();
  vi.mocked(importsApi.list).mockResolvedValue([
    {
      id: batch.id,
      filename: batch.filename,
      academic_year: batch.academic_year,
      data_kind: batch.data_kind,
      status: batch.status,
    },
  ]);
  vi.mocked(importsApi.get).mockResolvedValue(batch);
  setup();
  await screen.findByRole("heading", { name: `2. ${im.preview}` });
  return batch;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(importsApi.list).mockResolvedValue([]);
  vi.mocked(importsApi.history).mockResolvedValue([]);
});

describe("S1 import flow", () => {
  it("keeps selected file after a rejected workbook and never shows success", async () => {
    const user = userEvent.setup();
    vi.mocked(importsApi.preview).mockRejectedValue(
      new ApiError(422, "IMPORT_ARCHIVE_INVALID"),
    );
    setup();
    const input = screen.getByLabelText(im.file) as HTMLInputElement;
    await user.upload(input, new File(["invalid"], "broken.xlsx"));
    await user.click(screen.getByRole("button", { name: im.makePreview }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      importErrors.IMPORT_ARCHIVE_INVALID,
    );
    expect(input.files?.[0].name).toBe("broken.xlsx");
    expect(screen.queryByText(im.appliedNotice)).not.toBeInTheDocument();
  });
  it("sends only the changed room and retains other questions after review", async () => {
    const batch = await existing();
    const user = userEvent.setup();
    const updated = structuredClone(batch);
    updated.revision = 2;
    updated.rows[0].normalized.room = "101";
    updated.rows[0].issues.shift();
    updated.summary.open_issues = 1;
    vi.mocked(importsApi.review).mockResolvedValue(updated);
    await user.click(screen.getByRole("button", { name: `${im.review} · 2` }));
    expect(await screen.findByText("Жүктеме!F2 · Кабинет")).toBeVisible();
    await user.type(screen.getByLabelText(fieldNames.room), "101");
    expect(screen.getByRole("button", { name: im.refresh })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: im.save }));
    await waitFor(() =>
      expect(importsApi.review).toHaveBeenCalledWith(
        "batch",
        "row",
        1,
        { room: "101" },
        false,
        "csrf",
      ),
    );
    expect(await screen.findByText(im.saved)).toBeVisible();
    expect(screen.getByText("Жүктеме!H2 · Ішкі топ")).toBeVisible();
    expect(screen.queryByText("Жүктеме!F2 · Кабинет")).not.toBeInTheDocument();
  });
  it("requires explicit confirmation and preserves preview after failed apply", async () => {
    await existing();
    const user = userEvent.setup();
    vi.mocked(importsApi.apply).mockRejectedValue(
      new ApiError(503, "SERVICE_UNAVAILABLE"),
    );
    const button = screen.getByRole("button", { name: im.applyButton });
    expect(button).toBeDisabled();
    await user.click(screen.getByLabelText(im.confirmApply));
    await user.click(button);
    await waitFor(() =>
      expect(importsApi.apply).toHaveBeenCalledWith("batch", 1, "csrf"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(im.error);
    expect(screen.queryByText(im.appliedNotice)).not.toBeInTheDocument();
  });
  it("keeps unsaved values after a stale revision rejection", async () => {
    await existing();
    const user = userEvent.setup();
    vi.mocked(importsApi.review).mockRejectedValue(
      new ApiError(409, "IMPORT_STALE"),
    );
    await user.click(screen.getByRole("button", { name: `${im.review} · 2` }));
    await user.type(screen.getByLabelText(fieldNames.room), "101");
    await user.click(screen.getByRole("button", { name: im.save }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      importErrors.IMPORT_STALE,
    );
    expect(screen.getByLabelText(fieldNames.room)).toHaveValue("101");
  });
  it("refreshes CSRF and retries the same confirmed operation once", async () => {
    await existing();
    const user = userEvent.setup();
    vi.mocked(api.session).mockResolvedValue({
      user: { id: "user" } as never,
      csrf_token: "new-csrf",
    });
    vi.mocked(importsApi.apply)
      .mockRejectedValueOnce(new ApiError(403, "CSRF_INVALID"))
      .mockResolvedValueOnce({ ...sample(), status: "applied" });
    await user.click(screen.getByLabelText(im.confirmApply));
    await user.click(screen.getByRole("button", { name: im.applyButton }));
    await waitFor(() =>
      expect(importsApi.apply).toHaveBeenNthCalledWith(
        2,
        "batch",
        1,
        "new-csrf",
      ),
    );
    expect(await screen.findAllByText(im.appliedNotice)).not.toHaveLength(0);
  });
  it("gives admin a read-only source view with disabled review fields", async () => {
    const batch = sample();
    vi.mocked(importsApi.list).mockResolvedValue([
      {
        id: "batch",
        filename: batch.filename,
        academic_year: batch.academic_year,
        data_kind: "synthetic",
        status: "preview",
      },
    ]);
    vi.mocked(importsApi.get).mockResolvedValue(batch);
    setup(false);
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: `2. ${im.preview}` });
    expect(screen.queryByLabelText(im.file)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: im.applyButton }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `${im.view} · 2` }));
    expect(screen.getByLabelText(fieldNames.room)).toBeDisabled();
    expect(screen.getByRole("link", { name: im.source })).toHaveAttribute(
      "href",
      "/api/imports/batch/source",
    );
  });
});
