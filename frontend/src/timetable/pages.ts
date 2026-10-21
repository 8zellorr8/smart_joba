import { ApiError } from "../api";

interface EventPage<T> {
  events: T[];
  offset: number;
  limit: number;
  total: number;
  key: string;
}

// Never render a partial week as a complete one, or join different revisions.
export async function collectWeek<T extends { id: string }>(
  fetchPage: (offset: number) => Promise<EventPage<T>>,
  expectedKey: string,
  active: () => boolean,
): Promise<T[] | null> {
  const events: T[] = [];
  const ids = new Set<string>();
  let offset = 0;
  let total: number | undefined;
  while (active()) {
    const page = await fetchPage(offset);
    if (!active()) return null;
    if (page.key !== expectedKey) throw new ApiError(409, "EDITOR_STALE");
    if (
      page.offset !== offset ||
      !Number.isInteger(page.limit) ||
      page.limit <= 0 ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      (total !== undefined && total !== page.total) ||
      page.events.length > page.limit ||
      offset + page.events.length > page.total ||
      page.events.some((event) => ids.has(event.id))
    )
      throw new ApiError(502, "INVALID_WEEK_PAGE");
    total = page.total;
    for (const event of page.events) {
      if (ids.has(event.id)) throw new ApiError(502, "INVALID_WEEK_PAGE");
      ids.add(event.id);
      events.push(event);
    }
    if (events.length === total) return events;
    if (page.events.length !== page.limit)
      throw new ApiError(502, "INVALID_WEEK_PAGE");
    offset += page.limit;
  }
  return null;
}
