import type { PublishCommand } from "./publication-api";

export function readPending(key: string): PublishCommand | null {
  try {
    const value = JSON.parse(
      localStorage.getItem(key) ?? "null",
    ) as PublishCommand | null;
    return value &&
      typeof value.idempotency_key === "string" &&
      typeof value.readiness_token === "string" &&
      typeof value.approval_id === "string" &&
      Number.isInteger(value.expected_revision) &&
      Number.isInteger(value.expected_workflow_revision)
      ? value
      : null;
  } catch {
    return null;
  }
}
export function savePending(key: string, value: PublishCommand | null) {
  // UUIDs and revisions are not authority; the server checks current grants.
  // Storage failure still leaves the command in the component's memory.
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* local storage can be unavailable */
  }
}
