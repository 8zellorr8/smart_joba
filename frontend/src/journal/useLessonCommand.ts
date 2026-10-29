import { useEffect, useRef, useState } from "react";
import { ApiError } from "../api";
import { lessonApi } from "../lesson-api";
import type { LessonCommand, LessonReceipt } from "../lesson-api";
import { jm } from "../locales/journal.kk";
import { lm } from "../locales/lesson.kk";

export function useLessonCommand(options: {
  scope: string;
  csrfToken: string;
  admin?: boolean;
  onExpired: () => void;
  onDenied: () => void;
  onSaved: (receipt: LessonReceipt) => Promise<void>;
}) {
  const callbacks = useRef(options);
  callbacks.current = options;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [field, setField] = useState("");
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState<LessonCommand | null>(null);
  const [saved, setSaved] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  function reset() {
    setError("");
    setField("");
    setStale(false);
    setPending(null);
    setSaved(false);
  }
  async function perform(body: LessonCommand) {
    const o = callbacks.current;
    setBusy(true);
    setError("");
    setField("");
    setSaved(false);
    let receipt: LessonReceipt;
    try {
      receipt = await lessonApi.command(o.scope, o.csrfToken, body, o.admin);
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof ApiError && e.status === 401) o.onExpired();
      if (e instanceof ApiError && e.status === 403) {
        setPending(null);
        o.onDenied();
      } else if (
        !(e instanceof ApiError) ||
        e.status === 0 ||
        e.status >= 500
      ) {
        setPending(body);
        setError(jm.uncertain);
      } else {
        setPending(null);
        const conflict = e.status === 409;
        setStale(conflict);
        setError(
          e.code === "JOURNAL_STALE"
            ? jm.stale
            : (lm.errors[e.code] ?? jm.errors[e.code] ?? jm.loadError),
        );
        setField(typeof e.params.field === "string" ? e.params.field : "");
      }
      setBusy(false);
      return;
    }
    if (!alive.current) return;
    setPending(null);
    setStale(false);
    setSaved(true);
    try {
      await o.onSaved(receipt);
    } catch {
      if (alive.current) setError(lm.loadSaved);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return {
    busy,
    error,
    field,
    stale,
    pending,
    saved,
    errorRef,
    reset,
    perform,
  };
}
