"""Pure workflow policy and cross-publication resource checks (VER-001/002)."""
from collections import defaultdict
from bisect import bisect_left
from datetime import UTC, datetime
from zoneinfo import ZoneInfo


TRANSITIONS = {
    ("draft", "submit"): "submitted",
    ("submitted", "approve"): "approved",
    ("submitted", "reject"): "rejected",
    ("rejected", "reopen"): "draft",
    ("approved", "publish"): "published",
    ("published", "archive"): "archived",
}


def utc_interval(event, timezone):
    """Reject ambiguous/nonexistent civil instants instead of inventing a fold."""
    zone = ZoneInfo(timezone)
    result = []
    for field in ("start", "end"):
        local = datetime.fromisoformat(event["date"] + "T" + event[field])
        options = {local.replace(tzinfo=zone, fold=fold).astimezone(UTC) for fold in (0, 1)
                   if local.replace(tzinfo=zone, fold=fold).astimezone(UTC).astimezone(zone).replace(tzinfo=None) == local}
        if len(options) != 1:
            raise ValueError("PUBLICATION_TIME_AMBIGUOUS")
        result.append(options.pop())
    civil_start = datetime.fromisoformat(event["date"] + "T" + event["start"])
    civil_end = datetime.fromisoformat(event["date"] + "T" + event["end"])
    if result[1] <= result[0] or result[1] - result[0] != civil_end - civil_start:
        raise ValueError("PUBLICATION_TIME_AMBIGUOUS")
    return tuple(result)


def shared_conflicts(events, timezone, publications, limit=200):
    """Compare new events only with active snapshots; no scope/name shortcut.

    Resource UUIDs are confirmed identities. Equal names never merge resources.
    Diagnostics deliberately contain only the caller's own event and labels.
    """
    occupied = defaultdict(list)
    count = 0
    for publication in publications:
        for event in publication["events"]:
            if event["cancelled"]: continue
            count += 1
            if count > 200000: raise ValueError("PUBLICATION_REGISTRY_LIMIT")
            start, end = utc_interval(event, publication["timezone"])
            for kind in ("teacher", "group", "room"):
                occupied[(kind, event[kind + "_id"])].append((start, end))
    indexes = {}
    for key, intervals in occupied.items():
        intervals.sort()
        starts, maximum_ends = [], []
        for start, end in intervals:
            starts.append(start)
            maximum_ends.append(max(end, maximum_ends[-1]) if maximum_ends else end)
        indexes[key] = (starts, maximum_ends)
    found = []
    for event in events:
        if event["cancelled"]: continue
        start, end = utc_interval(event, timezone)
        for kind in ("teacher", "group", "room"):
            starts, ends = indexes.get((kind, event[kind + "_id"]), ([], []))
            before_end = bisect_left(starts, end)
            if before_end and ends[before_end - 1] > start:
                if len(found) == limit: return found, True
                found.append({"code": "PUBLICATION_RESOURCE_CONFLICT", "resource_type": kind,
                    "resource_name": event[kind], "event_id": event["id"], "date": event["date"]})
    return found, False
