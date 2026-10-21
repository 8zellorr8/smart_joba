"""RULE-001/002: concrete dates + half-open intervals + exclusive resources.

The sweep reports only intra-draft conflicts, never claims external occupancy
has been checked. An independent full-schedule validator remains a later module.
"""
from collections import defaultdict


def exclusive_resources(event):
    resources = [("teacher", event["teacher_id"]), ("group", event["group_id"])]
    if event.get("room_exclusive") is True:
        resources.append(("room", event["room_id"]))
    return resources


def overlaps(a, b):
    return a["date"] == b["date"] and a["start"] < b["end"] and b["start"] < a["end"]


def find_conflicts(events, limit=200):
    buckets = defaultdict(list)
    for event in events:
        if not event["cancelled"]:
            for kind, resource in exclusive_resources(event):
                buckets[(event["date"], kind, resource)].append(event)
    found, truncated = {}, False
    for (day, kind, resource), items in sorted(buckets.items()):
        active = []
        for event in sorted(items, key=lambda e: (e["start"], e["end"], e["id"])):
            active = [old for old in active if old["end"] > event["start"]]
            for old in active:
                left, right = sorted([old["id"], event["id"]])
                key = (kind, resource, left, right)
                if key not in found:
                    if len(found) >= limit:
                        # The first omitted conflict proves incompleteness. Do
                        # not enumerate a quadratic remainder just to discard it.
                        return {"conflicts": list(found.values()), "conflicts_truncated": True, "has_conflicts": True}
                    found[key] = {"rule": "RULE-001",
                                  "resource_type": kind, "resource_id": resource,
                                  "event_ids": [left, right], "dates": [], "intersections": []}
                item = found[key]
                item["dates"].append(day)
                item["intersections"].append({"date": day, "start": max(old["start"], event["start"]),
                                               "end": min(old["end"], event["end"])})
            active.append(event)
    return {"conflicts": list(found.values()), "conflicts_truncated": truncated,
            "has_conflicts": bool(found) or truncated}


def replace_one(events, occurrence_id, changes):
    """Copy-on-write so a single-date edit cannot alter other repetitions."""
    if not any(e["id"] == occurrence_id for e in events):
        raise KeyError(occurrence_id)
    return [{**event, **changes} if event["id"] == occurrence_id else dict(event) for event in events]
