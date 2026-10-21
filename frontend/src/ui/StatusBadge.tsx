import type { ReactNode } from "react";
import type { VersionStatus } from "../publication-api";

type Tone = "neutral" | "info" | "success" | "warning" | "danger";

const versionTones: Record<VersionStatus, Tone> = {
  draft: "neutral",
  submitted: "info",
  rejected: "danger",
  approved: "info",
  published: "success",
  archived: "neutral",
};
const solverTones: Record<string, Tone> = {
  queued: "neutral",
  running: "info",
  feasible: "success",
  optimal: "success",
  infeasible: "warning",
  time_limit_without_solution: "warning",
  cancelled: "neutral",
  failed: "danger",
  stale: "warning",
};

export function statusTone(kind: "version" | "solver", status: string): Tone {
  const tones: Record<string, Tone> =
    kind === "version" ? versionTones : solverTones;
  return Object.hasOwn(tones, status) ? tones[status] : "neutral";
}

// A badge stays presentational: callers own permissions, labels and live regions.
export function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: Tone;
}) {
  return (
    <span className={`status-badge status-badge--${tone}`}>{children}</span>
  );
}
