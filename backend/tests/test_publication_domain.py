from copy import deepcopy
from datetime import UTC, datetime

import pytest

from backend.app.domain.publication import shared_conflicts, utc_interval


def event(**changes):
    return {"id": "own", "date": "2026-09-01", "start": "09:00", "end": "10:30", "cancelled": False,
        "teacher_id": "teacher", "group_id": "group", "room_id": "room", "teacher": "SYNTHETIC teacher",
        "group": "SYNTHETIC group", "room": "SYNTHETIC room", **changes}


def test_shared_resources_compare_absolute_instants_and_never_leak_foreign_labels():
    other = event(id="foreign-secret", start="04:00", end="05:30", teacher="Private foreign label", group_id="other", room_id="other")
    found, truncated = shared_conflicts([event()], "Asia/Almaty", [{"timezone": "UTC", "events": [other]}])
    assert len(found) == 1 and found[0]["resource_type"] == "teacher" and not truncated
    assert "foreign-secret" not in str(found) and "Private foreign label" not in str(found)


@pytest.mark.parametrize("changes,expected", [({"start": "10:30", "end": "12:00"}, 0),
    ({"cancelled": True}, 0), ({"teacher_id": "other", "group_id": "other", "room_id": "other"}, 0),
    ({"start": "10:29", "end": "12:00"}, 3)])
def test_publication_half_open_intervals_cancellations_and_uuid_identities(changes, expected):
    found, _ = shared_conflicts([event()], "Asia/Almaty", [{"timezone": "Asia/Almaty", "events": [event(**changes)]}])
    assert len(found) == expected


def test_cross_midnight_utc_dates_are_checked_and_original_data_is_unchanged():
    own = event(start="01:00", end="02:00")
    foreign = event(date="2026-08-31", start="20:00", end="21:00")
    original = deepcopy([own, foreign])
    assert len(shared_conflicts([own], "Asia/Almaty", [{"timezone": "UTC", "events": [foreign]}])[0]) == 3
    assert [own, foreign] == original


@pytest.mark.parametrize("day,start,end", [("2026-03-08", "02:00", "03:00"), ("2026-11-01", "01:00", "02:00"),
    ("2026-03-08", "01:30", "03:00"), ("2026-11-01", "00:30", "02:00")])
def test_unknown_dst_fold_or_missing_civil_time_is_blocked(day, start, end):
    with pytest.raises(ValueError, match="PUBLICATION_TIME_AMBIGUOUS"):
        utc_interval(event(date=day, start=start, end=end), "America/New_York")


def test_diagnostics_limit_is_reported_instead_of_calling_an_incomplete_check_valid():
    found, truncated = shared_conflicts([event()], "UTC", [{"timezone": "UTC", "events": [event()]}], limit=1)
    assert len(found) == 1 and truncated


def test_interval_index_matches_a_pairwise_oracle_on_random_small_sets():
    import random
    randomizer = random.Random(60)
    def make(index):
        start = randomizer.randrange(0, 22 * 60)
        end = start + randomizer.randrange(1, 120)
        return event(id=str(index), start=f'{start // 60:02}:{start % 60:02}', end=f'{end // 60:02}:{end % 60:02}',
            date=f'2026-09-{randomizer.randint(1,3):02}', cancelled=randomizer.choice([False, False, True]),
            teacher_id=str(randomizer.randint(0,3)), group_id=str(randomizer.randint(0,3)), room_id=str(randomizer.randint(0,3)))
    for _ in range(100):
        old, new = [make(i) for i in range(15)], [make(i) for i in range(15,25)]
        expected = {(e['id'],kind) for e in new if not e['cancelled'] for kind in ('teacher','group','room')
            if any(not o['cancelled'] and o['date'] == e['date'] and e['start'] < o['end'] and o['start'] < e['end']
                   and e[kind+'_id'] == o[kind+'_id'] for o in old)}
        found, truncated = shared_conflicts(new, 'UTC', [{'timezone':'UTC','events':old}])
        assert not truncated and {(e['event_id'],e['resource_type']) for e in found} == expected
