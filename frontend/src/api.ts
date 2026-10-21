export type Role = "admin" | "scheduler" | "approver" | "teacher" | "student";
export interface Grant {
  role: Role;
  scope_id: string;
  scope_name: string;
  is_demo: boolean;
  group_id: string | null;
  teacher_id: string | null;
}
export interface User {
  id: string;
  email: string;
  display_name: string;
  home_scope_id: string;
  grants: Grant[];
}
export interface Session {
  user: User | null;
  csrf_token: string;
}
export interface Workspace {
  scope: { id: string; name: string; is_demo: boolean };
  role_codes: Role[];
  permissions: string[];
  stage: number;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public params: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

export async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network_error");
  }
  if (!response.ok) {
    let code = "request_failed";
    let params: Record<string, unknown> = {};
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && "error" in body) {
        const error = body.error;
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
        )
          code = error.code;
        if (
          error &&
          typeof error === "object" &&
          "params" in error &&
          error.params &&
          typeof error.params === "object" &&
          !Array.isArray(error.params)
        )
          params = error.params as Record<string, unknown>;
      }
    } catch {
      /* An HTML proxy error must not appear as product text. */
    }
    throw new ApiError(response.status, code, params);
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiError(502, "invalid_response");
  }
}

export const api = {
  session: () => request<Session>("/api/auth/session"),
  login: (email: string, password: string, csrfToken: string) =>
    request<Session>("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify({ email, password }),
    }),
  logout: (csrfToken: string) =>
    request<void>("/api/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  workspace: (scopeId: string) =>
    request<Workspace>(`/api/scopes/${encodeURIComponent(scopeId)}/workspace`),
};
