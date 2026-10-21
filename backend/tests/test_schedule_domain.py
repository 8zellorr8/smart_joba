from copy import deepcopy
from itertools import combinations
import random

from backend.app.domain.schedule import find_conflicts, replace_one


def event(key, **changes):
    return {"id": str(key), "date": "2026-09-01", "start": "09:00", "end": "10:30", "teacher_id": "teacher-A",
            "group_id": "group-A", "room_id": "room-A", "room_exclusive": True, "cancelled": False, "pinned": False, **changes}


def test_ac004a_disjoint_dates_have_no_conflict():
    assert not find_conflicts([event(1), event(2, date="2026-09-02")])["has_conflicts"]


def test_ac004b_teacher_conflict_has_both_events_resource_and_exact_date():
    report = find_conflicts([event(1), event(2, group_id="group-B", room_id="room-B")])
    assert report["conflicts"] == [{"rule": "RULE-001", "resource_type": "teacher", "resource_id": "teacher-A", "event_ids": ["1", "2"],
                                     "dates": ["2026-09-01"], "intersections": [{"date": "2026-09-01", "start": "09:00", "end": "10:30"}]}]


def test_ac004c_touching_end_and_start_is_not_overlap():
    assert not find_conflicts([event(1), event(2, start="10:30", end="12:00")])["has_conflicts"]


def test_ac004d_recurring_conflicts_retain_each_concrete_date():
    report = find_conflicts([event(1), event(2), event(3, date="2026-09-08"), event(4, date="2026-09-08")])
    assert {d for c in report["conflicts"] for d in c["dates"]} == {"2026-09-01", "2026-09-08"}


def test_ac005a_full_group_conflict():
    report = find_conflicts([event(1), event(2, teacher_id="other", room_id="other")])
    assert [c["resource_type"] for c in report["conflicts"]] == ["group"]


def test_ac005b_exclusive_room_conflict():
    report = find_conflicts([event(1), event(2, teacher_id="other", group_id="other")])
    assert [c["resource_type"] for c in report["conflicts"]] == ["room"]


def test_unknown_room_exclusivity_is_not_invented_as_a_checked_room_conflict():
    report = find_conflicts([event(1, room_exclusive=None), event(2, teacher_id="other", group_id="other", room_exclusive=None)])
    assert not report["has_conflicts"]


def test_cancelled_occurrence_does_not_occupy_resources():
    assert not find_conflicts([event(1), event(2, cancelled=True)])["has_conflicts"]


def test_ac021a_copy_on_write_only_changes_selected_occurrence():
    original = [event(1), event(2, date="2026-09-08")]; before = deepcopy(original)
    changed = replace_one(original, "2", {"start": "10:30", "end": "12:00", "pinned": True})
    assert original == before and changed[0] == before[0] and changed[1]["start"] == "10:30"
    assert changed[1]["id"] == "2" and changed[1]["pinned"] is True


def test_diagnostic_limit_is_explicit_and_never_turns_conflicts_into_valid_result():
    result = find_conflicts([event(i) for i in range(30)], limit=5)
    assert result["has_conflicts"] and result["conflicts_truncated"] and len(result["conflicts"]) == 5


def test_sweep_matches_independent_pairwise_reference_on_random_concrete_events():
    rng = random.Random(9021)
    for _ in range(80):
        events = []
        for i in range(18):
            start = rng.randrange(8, 15); end = start + rng.randrange(1, 4)
            events.append(event(i, date=f"2026-09-0{rng.randrange(1,4)}", start=f"{start:02}:00", end=f"{end:02}:00",
                                teacher_id=f"t{rng.randrange(4)}", group_id=f"g{rng.randrange(4)}", room_id=f"r{rng.randrange(4)}", cancelled=rng.random() < .2))
        reference = set()
        for left, right in combinations(events, 2):
            if left["cancelled"] or right["cancelled"] or left["date"] != right["date"]: continue
            if left["end"] <= right["start"] or right["end"] <= left["start"]: continue
            for kind in ("teacher", "group", "room"):
                if left[kind + "_id"] == right[kind + "_id"]:
                    reference.add((kind, left[kind + "_id"], *sorted([left["id"], right["id"]])))
        observed = {(c["resource_type"], c["resource_id"], *c["event_ids"]) for c in find_conflicts(events)["conflicts"]}
        assert observed == reference
