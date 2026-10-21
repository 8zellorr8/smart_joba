"""S1 values and questions, independent of Excel, HTTP and persistence."""
from decimal import Decimal, InvalidOperation
import hashlib
import json
import re

FIELDS = ("teacher", "subject", "index", "group", "course", "room", "weekly_hours",
          "subgroup", "specialty", "qualification", "semester_hours", "semester")
HEADERS = ("Мұғалім", "Пән", "Индекс", "Группа", "Курс", "Кабинет", "Сағат/апта",
           "Топ", "мамандығы", "Біліктілік", "Семестрдегі жалпы сағат саны", "Семестр")
HOUR_UNITS = {"source_hour", "academic_hour", "pair", "minute"}


def clean(value):
    return str(value).strip() if value is not None else ""


def normalize(raw: dict, corrections: dict, references_confirmed: bool, hour_unit: str):
    values = {field: raw[field].get("cached") if raw[field].get("formula") else raw[field].get("value") for field in FIELDS}
    values.update({key: value for key, value in corrections.items() if key in FIELDS})
    result = {key: clean(value) or None for key, value in values.items()}
    result.update(whole_group=bool(corrections.get("whole_group", False)), hour_unit=hour_unit,
                  references_confirmed=references_confirmed)
    issues = []

    def issue(code, field, blocking=True):
        issues.append({"code": code, "field": field, "blocking": blocking})

    for field in FIELDS:
        if raw[field].get("formula") and field not in corrections:
            issue("FORMULA_REVIEW" if raw[field].get("cached") is not None else "FORMULA_NO_CACHE", field)
    for field in ("subject", "group", "specialty", "qualification"):
        if not result[field]:
            issue("VALUE_MISSING", field)
    teacher = result["teacher"] or ""
    if not teacher:
        issue("VALUE_MISSING", "teacher")
    elif re.search(r"вак|vacan", teacher, re.I):
        issue("TEACHER_VACANCY", "teacher")
    elif any(separator in teacher for separator in ("/", ";", "\n")):
        issue("TEACHER_AMBIGUOUS", "teacher")
    if not result["subgroup"] and not result["whole_group"]:
        issue("SUBGROUP_UNSPECIFIED", "subgroup")
    elif result["subgroup"]:
        issue("SUBGROUP_UNSUPPORTED", "subgroup")
    if result["room"] in (None, "0", "0.0"):
        result["room"] = None
        issue("ROOM_UNSPECIFIED", "room")
    for field in ("course", "semester"):
        try:
            number = Decimal(clean(values[field]).replace(",", "."))
            if not number.is_finite() or number != int(number) or not 1 <= number <= 20:
                raise ValueError
            result[field] = int(number)
        except (InvalidOperation, ValueError, OverflowError):
            result[field] = None
            issue("INTEGER_REQUIRED", field)
    for field in ("weekly_hours", "semester_hours"):
        try:
            number = Decimal(clean(values[field]).replace(",", "."))
            if not number.is_finite() or not 0 <= number <= 100000 or number.as_tuple().exponent < -2:
                raise ValueError
            result[field] = format(number, "f")
        except (InvalidOperation, ValueError):
            result[field] = None
            issue("HOURS_REQUIRED", field)
    if hour_unit == "source_hour":
        issue("HOUR_UNIT_UNCONFIRMED", "weekly_hours")
    if not references_confirmed:
        issue("REFERENCES_UNCONFIRMED", "teacher")
    return result, issues


def source_key(normalized):
    # Mutable amounts, room and teacher are deliberately not the record identity.
    identity = [normalized.get(field) for field in ("group", "subject", "index", "semester", "subgroup")]
    return hashlib.sha256(json.dumps(identity, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def same_source(left, right):
    return all(left.get(key) == right.get(key) for key in FIELDS)
