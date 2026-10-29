"""Pure lesson-field rules. No inferred attendance or invented grade values."""
ATTENDANCE = frozenset({"present", "absent", "late", "excused", None})


def attendance_change(previous, value):
    if value not in ATTENDANCE:
        raise ValueError("JOURNAL_ATTENDANCE_INVALID")
    return previous is not None and previous != value


def topic_value(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 2000:
        raise ValueError("JOURNAL_TOPIC_INVALID")
    return value.strip()
