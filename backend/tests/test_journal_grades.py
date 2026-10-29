"""Grade acceptance against PostgreSQL and the existing publication workflow."""
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from sqlalchemy import select, text, update
from sqlalchemy.exc import IntegrityError

from backend.app.adapters.lesson_http import LessonCommand
from backend.app.application.auth import ApiError
from backend.app.application.journal_lessons import JournalLessonService
from backend.app.application.planning_inputs import input_token
from backend.app.domain.journal import grade_change
from backend.app.infrastructure.journal_models import JournalAssignment
from backend.app.infrastructure.lesson_models import JournalLesson, JournalLessonChange, JournalLessonOperation, JournalLessonStudent
from .conftest import csrf, login
from .test_journal_lessons import lesson_env, preview, body, send, record, modify, get


@pytest.mark.parametrize('value', [0, 100, 75])
def test_integer_boundaries_and_null_independent_of_attendance(client, app, lesson_env, value):
    e = lesson_env; a, b = e['students']
    assert all(r['grade'] is None for r in preview(client, e).json()['students'])
    saved = record(client, e, grades=[{'student_id': a, 'value': value}], attendance=[{'student_id': b, 'value': 'absent'}])
    rows = {r['student_id']: r for r in get(client, e, saved).json()['students']}
    assert rows[a]['grade'] == value and type(rows[a]['grade']) is int and rows[a]['attendance'] is None
    assert rows[b]['grade'] is None and rows[b]['attendance'] == 'absent'
    assert all(key not in get(client, e, saved).json() for key in ('average', 'total_grade', 'final_grade'))


@pytest.mark.parametrize('value', [-1, 101, 75.5, True, '75', '', 0.0])
def test_invalid_grade_is_explicitly_rejected_without_first_fact(client, app, lesson_env, value):
    e = lesson_env
    response = send(client, e, body(client, e, grades=[{'student_id': e['students'][0], 'value': value}]))
    assert response.status_code == 422 and response.json()['error']['code'] == 'VALIDATION_ERROR'
    with app.state.session_factory() as db:
        assert db.scalar(select(JournalLesson.id)) is None
        assert db.scalar(select(JournalLessonChange.id)) is None
        assert db.scalar(select(JournalLessonOperation.id)) is None


def test_correction_and_clearing_zero_require_reason_and_preserve_history(client, app, lesson_env):
    e = lesson_env; a, b = e['students']
    saved = record(client, e, grades=[{'student_id': a, 'value': 0}, {'student_id': b, 'value': 100}])
    for value in (75, None):
        rejected = send(client, e, modify(client, e, saved, grades=[{'student_id': a, 'value': value}], reason='   '))
        assert rejected.status_code == 422
        assert rejected.json()['error']['params']['field'] == 'reason'
    corrected = send(client, e, modify(client, e, saved, grades=[{'student_id': a, 'value': 75}], reason='Synthetic correction'))
    assert corrected.status_code == 200
    cleared = send(client, e, modify(client, e, corrected.json(), grades=[{'student_id': a, 'value': None}], reason='Synthetic clearing'))
    assert cleared.status_code == 200
    rows = {r['student_id']: r for r in get(client, e, saved).json()['students']}
    assert rows[a]['grade'] is None and rows[b]['grade'] == 100
    history = client.get(e['root'] + f"/lessons/{saved['lesson_id']}/history").json()['items']
    values = lambda h, part: next(s['grade'] for s in h[part]['students'] if s['student_id'] == a)
    assert (values(history[0], 'before'), values(history[0], 'after')) == (75, None)
    assert (values(history[1], 'before'), values(history[1], 'after')) == (0, 75)
    assert history[0]['actor_id'] == history[1]['actor_id'] and history[0]['created_at'].endswith('+00:00')
    assert history[0]['reason'] == 'Synthetic clearing'
    # Filling empty again is not a correction; zero remains a real grade.
    assert send(client, e, modify(client, e, cleared.json(), grades=[{'student_id': a, 'value': 0}])).status_code == 200
    with app.state.session_factory() as db:
        assert len(db.scalars(select(JournalLessonStudent).where(JournalLessonStudent.lesson_id == uuid.UUID(saved['lesson_id']), JournalLessonStudent.student_id == uuid.UUID(a))).all()) == 1
    for sql in ("UPDATE journal_lesson_changes SET after='{}'", 'DELETE FROM journal_lesson_changes',
                'UPDATE journal_lesson_students SET grade=-1', 'UPDATE journal_lesson_students SET grade=101',
                "UPDATE journal_lesson_students SET membership='{}'"):
        with app.state.engine.begin() as db:
            with pytest.raises(IntegrityError):
                with db.begin_nested(): db.execute(text(sql))


def test_invalid_grade_row_rolls_back_topic_attendance_grade_and_receipt(client, app, lesson_env):
    e = lesson_env; a = e['students'][0]; saved = record(client, e)
    before = get(client, e, saved).json()
    patch = modify(client, e, saved, topic='Changed', reason='Synthetic', attendance=[{'student_id': a, 'value': 'present'}],
                   grades=[{'student_id': a, 'value': 80}, {'student_id': str(uuid.uuid4()), 'value': 99}])
    assert send(client, e, patch).status_code == 403
    assert get(client, e, saved).json() == before
    with app.state.session_factory() as db:
        assert len(db.scalars(select(JournalLessonChange)).all()) == 1
        assert db.scalar(select(JournalLessonOperation).where(JournalLessonOperation.operation_id == uuid.UUID(patch['operation_id']))) is None


def test_audit_failure_rolls_back_grade_and_revision(client, app, lesson_env, monkeypatch):
    e = lesson_env; saved = record(client, e); before = get(client, e, saved).json()
    def fail(*args): raise RuntimeError('synthetic grade transaction failure')
    monkeypatch.setattr('backend.app.application.journal_lessons.audit', fail)
    with pytest.raises(RuntimeError, match='grade transaction'):
        send(client, e, modify(client, e, saved, grades=[{'student_id': e['students'][0], 'value': 88}]))
    assert get(client, e, saved).json() == before


@pytest.mark.parametrize('role', ['admin', 'approver', 'scheduler', 'student'])
def test_grade_write_and_read_policy(client, app, lesson_env, role):
    e = lesson_env; saved = record(client, e, grades=[{'student_id': e['students'][0], 'value': 75}])
    patch = modify(client, e, saved, grades=[{'student_id': e['students'][0], 'value': 100}], reason='Denied')
    login(client, app, role)
    assert send(client, e, patch).status_code == 403
    result = get(client, e, saved)
    assert result.status_code == (200 if role == 'approver' else 403)
    if role == 'approver':
        assert result.json()['can_write'] is False
        assert any(s['grade'] == 75 for s in result.json()['students'])
    if role == 'admin':
        projection = client.get(e['root'] + f"/lesson-admin/lessons/{saved['lesson_id']}/roster").json()
        assert 'grade' not in str(projection)
        assert client.get(e['root'] + f"/lessons/{saved['lesson_id']}/history").status_code == 403


def test_grade_receipt_retry_stale_conflict_and_revocation(client, app, lesson_env):
    e = lesson_env; saved = record(client, e)
    patch = modify(client, e, saved, grades=[{'student_id': e['students'][0], 'value': 0}])
    first = send(client, e, patch)
    assert first.status_code == 200
    assert send(client, e, patch).json() == first.json()
    changed = {**patch, 'command': {**patch['command'], 'grades': [{'student_id': e['students'][0], 'value': 100}]}}
    assert send(client, e, changed).json()['error']['code'] == 'JOURNAL_OPERATION_CONFLICT'
    assert send(client, e, {**changed, 'operation_id': str(uuid.uuid4())}).json()['error']['code'] == 'JOURNAL_STALE'
    with app.state.session_factory.begin() as db:
        db.execute(update(JournalAssignment).values(active=False))
    assert send(client, e, patch).status_code == 403


def test_pre_grade_fingerprint_and_receipt_remain_compatible(client, app, lesson_env):
    e = lesson_env; b = body(client, e)
    old_body = LessonCommand.model_validate(b).model_dump(mode='json')
    old_body['command'].pop('grades')
    old_hash = input_token({'scope_id': e['scope'], 'admin': False, **old_body})
    first = send(client, e, b)
    assert first.status_code == 200
    with app.state.session_factory() as db:
        stored = db.scalar(select(JournalLessonOperation).where(JournalLessonOperation.operation_id == uuid.UUID(b['operation_id'])))
        assert stored.request_hash == old_hash
    # Same receipt across old/new clients; history and old operation are not rewritten.
    assert send(client, e, {**b, 'command': {**b['command'], 'grades': []}}).json() == first.json()


def test_concurrent_grades_cannot_overwrite_each_other(client, app, lesson_env):
    e = lesson_env; saved = record(client, e)
    service = JournalLessonService(app.state.session_factory, app.state.auth)
    token = client.cookies.get('smart_joba_session')
    patches = [modify(client, e, saved, grades=[{'student_id': e['students'][0], 'value': value}]) for value in (0, 100)]
    def write(b):
        try: return service.command(token, uuid.UUID(e['scope']), b, str(uuid.uuid4()))['revision']
        except ApiError as err: return err.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, patches))
    assert sorted(map(str, results)) == ['2', 'JOURNAL_STALE']
    assert next(r['grade'] for r in get(client, e, saved).json()['students'] if r['student_id'] == e['students'][0]) in (0, 100)


def test_duplicate_limit_and_session_checks_for_grade_command(client, app, lesson_env):
    e = lesson_env; saved = record(client, e)
    a = {'student_id': e['students'][0], 'value': 0}
    assert send(client, e, modify(client, e, saved, grades=[a, a])).json()['error']['code'] == 'JOURNAL_ROWS_DUPLICATE'
    assert send(client, e, modify(client, e, saved, grades=[a] * 101)).status_code == 422
    ids = [str(uuid.uuid4()) for _ in range(101)]
    mixed = modify(client, e, saved, grades=[{'student_id': x, 'value': 75} for x in ids[:100]], attendance=[{'student_id': ids[-1], 'value': 'present'}])
    assert send(client, e, mixed).json()['error']['code'] == 'JOURNAL_ROWS_LIMIT'
    patch = modify(client, e, saved, grades=[a]); path = e['root'] + '/lesson-commands'
    assert client.post(path, json=patch).status_code == 403
    assert client.post(path, json=patch, headers={**csrf(client), 'Origin': 'https://invalid.example'}).status_code == 403
    assert send(client, e, {**patch, 'command': {**patch['command'], 'final_grade': 100}}).status_code == 422
    assert all(r['grade'] is None for r in get(client, e, saved).json()['students'])


@pytest.mark.parametrize('value', [True, False, 75.5, 0.0, '0', -1, 101])
def test_domain_does_not_coerce_invalid_grades(value):
    with pytest.raises(ValueError, match='JOURNAL_GRADE_INVALID'): grade_change(None, value)


def test_domain_zero_clear_and_first_fill():
    assert grade_change(None, 0) is False
    assert grade_change(0, 100) is True
    assert grade_change(0, None) is True
    assert grade_change(0, 0) is False
