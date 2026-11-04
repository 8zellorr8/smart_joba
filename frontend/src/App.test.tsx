import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { Role, Session, Workspace } from "./api";
import { kk } from "./locales/kk";
import { wb } from "./locales/workbench.kk";
import { portal } from "./locales/portal.kk";

vi.mock("./publication-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./publication-api")>();
  return {
    ...actual,
    publicationApi: {
      ...actual.publicationApi,
      list: vi.fn().mockResolvedValue([]),
    },
    versionApi: { ...actual.versionApi, list: vi.fn().mockResolvedValue([]) },
  };
});

const scheduler = {
  id: "user-test",
  email: "scheduler@example.test",
  display_name: "Үлгі құрастырушы",
  home_scope_id: "scope-test",
  grants: [
    {
      role: "scheduler" as const,
      scope_id: "scope-test",
      scope_name: "Үлгі аймақ",
      is_demo: true,
      group_id: null,
      teacher_id: null,
    },
  ],
};
const empty: Session = { user: null, csrf_token: "anonymous-csrf" };
const signedIn: Session = { user: scheduler, csrf_token: "authenticated-csrf" };
const workspace: Workspace = {
  scope: { id: "scope-test", name: "Үлгі аймақ", is_demo: true },
  role_codes: ["scheduler"],
  permissions: ["draft.edit", "generator.run", "import.write"],
  stage: 1,
};
const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("AUTH-003: prepared account sign-in", () => {
  it("keeps email, clears password and announces the same invalid-credentials error", async () => {
    fetchMock.mockResolvedValueOnce(json(empty)).mockResolvedValueOnce(
      json(
        {
          error: {
            code: "AUTH_INVALID_CREDENTIALS",
            params: {},
            request_id: "test",
          },
        },
        401,
      ),
    );
    const user = userEvent.setup();
    const persisted = vi.spyOn(Storage.prototype, "setItem");
    render(<App />);
    await user.type(
      await screen.findByLabelText(kk.email),
      "wrong@example.test",
    );
    const password = screen.getByLabelText(kk.password, { exact: true });
    await user.type(password, "a-private-password");
    await user.click(screen.getByRole("button", { name: kk.signIn }));
    expect(await screen.findByText(kk.invalidCredentials)).toBeVisible();
    expect(screen.getByLabelText(kk.email)).toHaveValue("wrong@example.test");
    expect(password).toHaveValue("");
    expect(password).toHaveFocus();
    expect(persisted).not.toHaveBeenCalled();
    expect(location.search).toBe("");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/auth/login",
      expect.objectContaining({
        credentials: "same-origin",
        headers: expect.objectContaining({ "X-CSRF-Token": "anonymous-csrf" }),
        body: JSON.stringify({
          email: "wrong@example.test",
          password: "a-private-password",
        }),
      }),
    );
  });

  it("supports password visibility and restores focus without storing secrets", async () => {
    fetchMock.mockResolvedValue(json(empty));
    const user = userEvent.setup();
    render(<App />);
    const password = await screen.findByLabelText(kk.password, { exact: true });
    await user.type(password, "private-test");
    await user.click(screen.getByRole("button", { name: kk.showPassword }));
    expect(password).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: kk.hidePassword }));
    expect(password).toHaveAttribute("type", "password");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("logs in using the server session and displays the real scope and role", async () => {
    fetchMock
      .mockResolvedValueOnce(json(empty))
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json(workspace));
    const user = userEvent.setup();
    render(<App />);
    await user.type(await screen.findByLabelText(kk.email), scheduler.email);
    await user.type(
      screen.getByLabelText(kk.password, { exact: true }),
      "private-test",
    );
    await user.click(screen.getByRole("button", { name: kk.signIn }));
    expect(await screen.findByText(scheduler.display_name)).toBeVisible();
    expect(screen.getByText(kk.roleScheduler)).toBeVisible();
    expect(screen.getByText(workspace.scope.name)).toBeVisible();
    expect(screen.getByText(wb.demo)).toBeVisible();
    expect(screen.getByRole("heading", { name: wb.overview })).toBeVisible();
    expect(
      screen.queryByLabelText(kk.password, { exact: true }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/scopes/scope-test/workspace",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });
});

describe("REQ-006: server-provided workspace and session", () => {
  it("resets reader pages after the server changes the teacher binding for the same account and scope", async () => {
    const teacher = {
      ...scheduler,
      grants: [
        {
          ...scheduler.grants[0],
          role: "teacher" as const,
          teacher_id: "teacher-a",
        },
      ],
    };
    const readerWorkspace = {
      ...workspace,
      role_codes: ["teacher"],
      permissions: ["publication.read.own"],
    };
    fetchMock
      .mockResolvedValueOnce(json({ ...signedIn, user: teacher }))
      .mockResolvedValueOnce(json(readerWorkspace));
    render(<App />);
    await screen.findByRole("heading", { name: wb.overview });
    await userEvent.click(
      screen.getByRole("button", { name: portal.mySubjects }),
    );
    await screen.findByRole("heading", {
      name: portal.mySubjects,
    });
    fetchMock
      .mockResolvedValueOnce(
        json({
          ...signedIn,
          user: {
            ...teacher,
            grants: [{ ...teacher.grants[0], teacher_id: "teacher-b" }],
          },
        }),
      )
      .mockResolvedValueOnce(json(readerWorkspace));
    fireEvent(document, new Event("visibilitychange"));
    expect(
      await screen.findByRole("heading", { name: wb.overview }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: portal.mySubjects }),
    ).not.toBeInTheDocument();
  });
  it("restores a teacher session and shows only the server permissions", async () => {
    const teacher = {
      ...scheduler,
      display_name: "Үлгі оқытушы",
      grants: [{ ...scheduler.grants[0], role: "teacher" as const }],
    };
    const teacherWorkspace = {
      ...workspace,
      role_codes: ["teacher"],
      permissions: ["publication.read.own", "publication.export.own"],
    };
    fetchMock
      .mockResolvedValueOnce(json({ ...signedIn, user: teacher }))
      .mockResolvedValueOnce(json(teacherWorkspace));
    render(<App />);
    expect(await screen.findByText(kk.roleTeacher)).toBeVisible();
    await userEvent.click(screen.getByText(wb.account));
    expect(screen.getByText("Өз сабақ кестесін қарау")).toBeVisible();
    expect(screen.getByText(kk.noPublishedTitle)).toBeVisible();
    expect(screen.queryByText("Кесте жобасын өңдеу")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Деректерді импорттау/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(kk.roleAdmin)).not.toBeInTheDocument();
  });

  it.each([
    {
      role: "admin",
      label: kk.roleAdmin,
      permission: "catalog.manage",
      next: kk.nextAdminDescription,
    },
    {
      role: "approver",
      label: kk.roleApprover,
      permission: "draft.approve",
      next: kk.nextApproverDescription,
    },
    {
      role: "student",
      label: kk.roleStudent,
      permission: "publication.read.group",
      next: kk.noPublishedBody,
    },
  ])(
    "renders the server-provided $role workspace",
    async ({ role, label, permission, next }) => {
      const user = {
        ...scheduler,
        grants: [{ ...scheduler.grants[0], role: role as Role }],
      };
      fetchMock
        .mockResolvedValueOnce(json({ ...signedIn, user }))
        .mockResolvedValueOnce(
          json({ ...workspace, role_codes: [role], permissions: [permission] }),
        );
      render(<App />);
      expect(await screen.findByText(label)).toBeVisible();
      await userEvent.click(screen.getByText(wb.account));
      expect(screen.getByText(next)).toBeVisible();
      expect(screen.queryByText(kk.roleScheduler)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /Деректерді импорттау/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("clears the workspace after the server reports session loss", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json({ error: { code: "AUTH_REQUIRED" } }, 401))
      .mockResolvedValueOnce(json(empty));
    render(<App />);
    expect(await screen.findByText(kk.sessionExpired)).toBeVisible();
    expect(screen.getByRole("button", { name: kk.signIn })).toBeVisible();
    expect(screen.queryByText(scheduler.display_name)).not.toBeInTheDocument();
  });

  it("sends logout to the server before returning to sign-in", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json(workspace))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(empty));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: kk.signOut }));
    expect(
      await screen.findByRole("button", { name: kk.signIn }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: { "X-CSRF-Token": "authenticated-csrf" },
        credentials: "same-origin",
      }),
    );
  });

  it("does not pretend logout succeeded when the server cannot be reached", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json(workspace))
      .mockRejectedValueOnce(new TypeError("offline"));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: kk.signOut }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      kk.connectionError,
    );
    expect(screen.getByText(scheduler.display_name)).toBeVisible();
  });

  it("refreshes a stale CSRF token and retries server logout once", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json(workspace))
      .mockResolvedValueOnce(json({ error: { code: "CSRF_INVALID" } }, 403))
      .mockResolvedValueOnce(
        json({ ...signedIn, csrf_token: "refreshed-csrf" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(empty));
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: kk.signOut }));
    expect(
      await screen.findByRole("button", { name: kk.signIn }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      "/api/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: { "X-CSRF-Token": "refreshed-csrf" },
      }),
    );
  });

  it("preserves the email after refreshing a stale login CSRF token", async () => {
    fetchMock
      .mockResolvedValueOnce(json(empty))
      .mockResolvedValueOnce(json({ error: { code: "CSRF_INVALID" } }, 403))
      .mockResolvedValueOnce(json({ ...empty, csrf_token: "fresh-anonymous" }));
    const user = userEvent.setup();
    render(<App />);
    await user.type(
      await screen.findByLabelText(kk.email),
      "preserved@example.test",
    );
    await user.type(
      screen.getByLabelText(kk.password, { exact: true }),
      "private-test",
    );
    await user.click(screen.getByRole("button", { name: kk.signIn }));
    expect(await screen.findByText(kk.sessionError)).toBeVisible();
    expect(screen.getByLabelText(kk.email)).toHaveValue(
      "preserved@example.test",
    );
    expect(screen.getByLabelText(kk.password, { exact: true })).toHaveValue("");
  });

  it("uses a distinct no-access state and can retry", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json({ error: { code: "ACCESS_DENIED" } }, 403));
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent(kk.noAccess);
    expect(screen.queryByText(scheduler.display_name)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: kk.retry })).toBeVisible();
  });

  it("refreshes the server session when returning to the browser tab", async () => {
    fetchMock
      .mockResolvedValueOnce(json(signedIn))
      .mockResolvedValueOnce(json(workspace))
      .mockResolvedValueOnce(json(empty));
    render(<App />);
    await screen.findByText(scheduler.display_name);
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: kk.signIn })).toBeVisible(),
    );
    expect(screen.queryByText(scheduler.display_name)).not.toBeInTheDocument();
  });
});

describe("LOC-001 / UX-014: Kazakh interface", () => {
  it("has complete non-empty KK resources including Kazakh characters", () => {
    for (const [key, value] of Object.entries(kk)) {
      if (typeof value !== "string")
        for (const item of value) expect(item.trim(), key).not.toBe("");
      else expect(value.trim(), key).not.toBe("");
    }
    const text = Object.values(kk).flat().join(" ");
    for (const character of ["ә", "ғ", "қ", "ң", "ө", "ұ", "ү", "і"])
      expect(text.toLocaleLowerCase("kk-KZ")).toContain(character);
  });

  it("labels the form and has no unused language or role selection", async () => {
    fetchMock.mockResolvedValueOnce(json(empty));
    render(<App />);
    const email = await screen.findByRole("textbox", { name: kk.email });
    expect(email).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText(kk.password, { exact: true })).toHaveAttribute(
      "autocomplete",
      "current-password",
    );
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    const main = screen.getByRole("main");
    expect(within(main).getByText(kk.language)).toBeVisible();
    expect(screen.getByRole("link", { name: kk.skipLink })).toHaveAttribute(
      "href",
      "#main",
    );
  });
});
