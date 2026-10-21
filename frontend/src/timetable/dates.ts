export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function weekStart(iso: string): string {
  const day = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return addDays(iso, -((day + 6) % 7));
}

export function todayInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function dayLabel(iso: string, weekday = false): string {
  // Some offline/browser ICU builds lack kk and fall back to M10/Thu.
  const months = [
    "қаңтар",
    "ақпан",
    "наурыз",
    "сәуір",
    "мамыр",
    "маусым",
    "шілде",
    "тамыз",
    "қыркүйек",
    "қазан",
    "қараша",
    "желтоқсан",
  ];
  const weekdays = [
    "Жексенбі",
    "Дүйсенбі",
    "Сейсенбі",
    "Сәрсенбі",
    "Бейсенбі",
    "Жұма",
    "Сенбі",
  ];
  const date = new Date(`${iso}T12:00:00Z`);
  return `${weekday ? `${weekdays[date.getUTCDay()]}, ` : ""}${date.getUTCDate()} ${months[date.getUTCMonth()]}`;
}

export function minutes(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

export function clock(value: number): string {
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

// Interval partitioning keeps simultaneous lessons visible in separate lanes.
export function lessonLanes<
  T extends { id: string; start: string; end: string },
>(events: T[]) {
  const sorted = [...events].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      a.end.localeCompare(b.end) ||
      a.id.localeCompare(b.id),
  );
  const result: { event: T; lane: number; lanes: number }[] = [];
  let cluster: { event: T; lane: number; lanes: number }[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const item of cluster) result.push({ ...item, lanes: ends.length });
    cluster = [];
    ends = [];
  };
  for (const event of sorted) {
    const start = minutes(event.start);
    const end = minutes(event.end);
    if (start >= clusterEnd) flush();
    let lane = ends.findIndex((value) => value <= start);
    if (lane < 0) lane = ends.length;
    ends[lane] = end;
    cluster.push({ event, lane, lanes: 1 });
    clusterEnd = Math.max(cluster.length === 1 ? -1 : clusterEnd, end);
  }
  flush();
  return result;
}
