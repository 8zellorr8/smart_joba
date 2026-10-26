import { publicationApi } from "../publication-api";
import { ApiError } from "../api";
import type { PublishedSummary, ReaderEvent } from "../publication-api";
import { collectWeek } from "../timetable/pages";

/** A display projection of authorized published events, not course enrolment. */
export interface PublishedSubject {
  key: string;
  name: string;
  source: PublishedSummary;
  events: ReaderEvent[];
}

export async function loadPublishedSubjects(
  sources: PublishedSummary[],
  active: () => boolean,
): Promise<PublishedSubject[] | null> {
  const publications = await Promise.all(
    sources
      .filter((source) => source.is_current)
      .map(async (source) => {
        const events = await collectWeek<ReaderEvent>(
          async (offset) => {
            // The existing reader API applies account and scope restrictions first.
            const page = await publicationApi.get(source.publication_id, {
              start: "",
              end: "",
              view: "group",
              resource_id: "",
              offset,
            });
            if (!page.is_current) throw new ApiError(409, "PUBLICATION_STALE");
            return {
              events: page.events,
              total: page.total,
              offset: page.offset,
              limit: page.limit,
              key: `${page.publication_id}:${page.revision}`,
            };
          },
          `${source.publication_id}:${source.revision}`,
          active,
        );
        if (!events || !active()) return [];
        const subjects = new Map<string, PublishedSubject>();
        for (const event of events) {
          // Names group presentation only; they never identify permission resources.
          const key = JSON.stringify([source.publication_id, event.subject]);
          const subject = subjects.get(key) ?? {
            key,
            name: event.subject,
            source,
            events: [],
          };
          subject.events.push(event);
          subjects.set(key, subject);
        }
        return [...subjects.values()].map((subject) => ({
          ...subject,
          events: subject.events.sort((a, b) =>
            `${a.date} ${a.start} ${a.id}`.localeCompare(
              `${b.date} ${b.start} ${b.id}`,
            ),
          ),
        }));
      }),
  );
  return active()
    ? publications
        .flat()
        .sort(
          (a, b) =>
            a.name.localeCompare(b.name, "kk") || a.key.localeCompare(b.key),
        )
    : null;
}
