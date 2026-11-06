import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { api } from "./api";
import { courseApi } from "./course-api";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: { session: vi.fn(), workspace: vi.fn(), logout: vi.fn() },
}));
vi.mock("./course-api", () => ({
  courseApi: { list: vi.fn(), contents: vi.fn() },
}));

it("keeps the teacher's unsaved topic when logout is cancelled, then permits confirmed logout", async () => {
  const course = {
    id: "course",
    subject: "Test course",
    group: "Test group",
    academic_year: "2026-2027",
    semester: 1,
    data_kind: "synthetic" as const,
    can_manage: true,
    opened: true,
  };
  vi.mocked(api.session).mockResolvedValue({
    csrf_token: "test-csrf",
    user: {
      id: "teacher",
      email: "teacher@example.test",
      display_name: "Test teacher",
      home_scope_id: "scope",
      grants: [
        {
          role: "teacher",
          scope_id: "scope",
          scope_name: "Test",
          is_demo: true,
          group_id: null,
          teacher_id: "teacher",
        },
      ],
    },
  });
  vi.mocked(api.workspace).mockResolvedValue({
    scope: { id: "scope", name: "Test", is_demo: true },
    role_codes: ["teacher"],
    permissions: ["course.read", "course.manage"],
    stage: 6,
  });
  vi.mocked(courseApi.list).mockResolvedValue([course]);
  vi.mocked(courseApi.contents).mockResolvedValue({ course, topics: [] });
  vi.mocked(api.logout).mockResolvedValue();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Курстар" }));
  fireEvent.click(await screen.findByRole("button", { name: "Курсқа кіру" }));
  fireEvent.click(await screen.findByRole("button", { name: "Тақырып қосу" }));
  fireEvent.change(screen.getByLabelText("Тақырып атауы"), {
    target: { value: "Unsaved topic" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Шығу" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(api.logout).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Тақырып атауы")).toHaveValue("Unsaved topic");
  confirm.mockReturnValue(true);
  vi.mocked(api.session).mockResolvedValue({ user: null, csrf_token: "anon" });
  fireEvent.click(screen.getByRole("button", { name: "Шығу" }));
  await waitFor(() => expect(api.logout).toHaveBeenCalledOnce());
  expect(await screen.findByRole("button", { name: "Кіру" })).toBeVisible();
  confirm.mockRestore();
});
