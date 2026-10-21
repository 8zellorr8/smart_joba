"""S1 preview, corrections and atomic, revision-checked application (IMP-007)."""
from collections import Counter, defaultdict
from datetime import UTC, datetime
from decimal import Decimal
import hashlib
import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import distinct_on, insert

from .auth import ApiError, audit
from ..domain.importing import FIELDS, normalize, same_source, source_key
from ..domain.permissions import permissions_for
from ..infrastructure.models import (DemandRevision, Group, ImportBatch, ImportContext, ImportIssue,
                                     ImportRow, Scope, SourceReference, Subject, Teacher, TeachingAssignment, TeachingDemand)
from ..infrastructure.s1_excel import ImportFileError, TEMPLATE, read_s1


def issue_signature(issues):
    return sorted((item["code"], item["field"], item["blocking"]) for item in issues)


class ImportService:
    def __init__(self, factory, auth):
        self.factory, self.auth = factory, auth

    def authorize(self, db, token, scope_id, *, write=False):
        user = self.auth.resolve(db, token)
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        permission = "import.write" if write else "import.source.read"
        if permission not in permissions_for(self.auth.grants(db, user.id), str(scope_id)):
            raise ApiError("ACCESS_DENIED", 403)
        return user

    def batch_access(self, db, token, batch_id, *, write=False, lock=False):
        user = self.auth.resolve(db, token)
        if user is None:
            raise ApiError("AUTH_REQUIRED", 401)
        batch = db.get(ImportBatch, batch_id)
        if batch is None:
            raise ApiError("NOT_FOUND", 404)
        context = db.get(ImportContext, batch.context_id)
        self.authorize(db, token, context.scope_id, write=write)
        if lock:
            # Shared dictionaries are scoped; serialize their creation as well.
            db.scalar(select(Scope).where(Scope.id == context.scope_id).with_for_update())
            context = db.scalar(select(ImportContext).where(ImportContext.id == context.id).with_for_update().execution_options(populate_existing=True))
            batch = db.scalar(select(ImportBatch).where(ImportBatch.id == batch_id).with_for_update().execution_options(populate_existing=True))
        return batch, context, user

    def create(self, token, scope_id, content, filename, sheet, last_row, academic_year, data_kind, hour_unit, request_id):
        with self.factory() as db:
            self.authorize(db, token, scope_id, write=True)
        try:
            parsed = read_s1(content, filename, sheet, last_row)
        except ImportFileError as error:
            raise ApiError(error.code, 413 if error.code in {"IMPORT_FILE_TOO_LARGE", "IMPORT_ARCHIVE_LIMIT"} else 422) from None
        with self.factory.begin() as db:
            user = self.authorize(db, token, scope_id, write=True)
            db.execute(insert(ImportContext).values(id=uuid.uuid4(), scope_id=scope_id, academic_year=academic_year,
                                                  data_kind=data_kind, revision=0).on_conflict_do_nothing())
            context = db.scalar(select(ImportContext).where(ImportContext.scope_id == scope_id,
                                ImportContext.academic_year == academic_year, ImportContext.data_kind == data_kind).with_for_update())
            batch = ImportBatch(context_id=context.id, filename=filename, file_sha256=hashlib.sha256(content).hexdigest(),
                                original_file=content, template=TEMPLATE, sheet=sheet, last_row=last_row,
                                hour_unit=hour_unit, base_revision=context.revision, created_by=user.id)
            db.add(batch)
            db.flush()
            existing = {d.source_key: d for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
            old_rows = {r.id: r for r in db.scalars(select(ImportRow).where(ImportRow.id.in_([d.source_row_id for d in existing.values()])))}
            # Human-confirmed aliases survive subsequent uploads and renamed
            # labels. Source hashes locate candidates, never replace stable IDs.
            aliases = defaultdict(dict)
            by_id = {d.id: d for d in existing.values()}
            historical = db.execute(select(DemandRevision, ImportRow).join(ImportRow, ImportRow.id == DemandRevision.source_row_id)
                                    .join(TeachingDemand, TeachingDemand.id == DemandRevision.demand_id)
                                    .where(TeachingDemand.context_id == context.id).order_by(DemandRevision.revision.desc())).all()
            for history, original in historical:
                raw_normalized, _ = normalize(original.raw, {}, False, history.normalized["hour_unit"])
                aliases[source_key(raw_normalized)].setdefault(history.demand_id, (original, history.normalized["hour_unit"]))
            for parsed_row in parsed:
                normalized, _ = normalize(parsed_row.raw, {}, False, hour_unit)
                key = source_key(normalized)
                previous = existing.get(key)
                old = old_rows.get(previous.source_row_id) if previous else None
                candidates = aliases.get(key, {})
                if previous is None and len(candidates) == 1:
                    previous = by_id[next(iter(candidates))]
                old_unit = previous.normalized["hour_unit"] if previous else None
                if previous and previous.id in candidates:
                    old, old_unit = candidates[previous.id]
                corrections, confirmed = {}, False
                if old:
                    identity_fields = {"group", "subject", "index", "semester", "subgroup", "whole_group"}
                    corrections = {field: value for field, value in old.corrections.items()
                                   if old.raw["subgroup" if field == "whole_group" else field] == parsed_row.raw["subgroup" if field == "whole_group" else field]
                                   and (old_unit == hour_unit or field in identity_fields)}
                    confirmed = old.references_confirmed and same_source(old.raw, parsed_row.raw) and old_unit == hour_unit
                if len(candidates) > 1 and previous is None:
                    # Multiple explicit past correspondences require a new human
                    # decision; never choose an identity by name or iteration order.
                    raise ApiError("IMPORT_IDENTITY_AMBIGUOUS", 409)
                row = ImportRow(batch_id=batch.id, source_row=parsed_row.number, raw=parsed_row.raw,
                                normalized=normalized, corrections=corrections, references_confirmed=confirmed, source_key=key)
                db.add(row)
                db.flush()
                db.add_all([SourceReference(row_id=row.id, field=field, coordinate=f"{chr(65 + column)}{parsed_row.number}",
                                            original=parsed_row.raw[field]) for column, field in enumerate(FIELDS)])
            db.flush()
            self.refresh(db, batch, context)
            audit(db, "import.preview", "created", request_id, user.id)
            result = self.dto(db, batch, context)
        return result

    def refresh(self, db, batch, context):
        rows = db.scalars(select(ImportRow).where(ImportRow.batch_id == batch.id).order_by(ImportRow.source_row)).all()
        demands = {d.source_key: d for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
        teachers = Counter(db.scalars(select(Teacher.display_name).where(Teacher.scope_id == context.scope_id,
                                                                        Teacher.data_kind == context.data_kind)).all())
        questions = {}
        for row in rows:
            normalized, issues = normalize(row.raw, row.corrections, row.references_confirmed, batch.hour_unit)
            for field, limit in (("group", 80), ("teacher", 160), ("room", 80)):
                if normalized[field] and len(normalized[field]) > limit:
                    issues.append({"code": "VALUE_TOO_LONG", "field": field, "blocking": True})
            if row.references_confirmed and teachers[normalized["teacher"]] > 1:
                issues.append({"code": "REFERENCE_AMBIGUOUS", "field": "teacher", "blocking": True})
            row.normalized, row.source_key = normalized, source_key(normalized)
            row.matched_demand_id = demands[row.source_key].id if row.source_key in demands else None
            questions[row.id] = issues
        duplicates = Counter(row.source_key for row in rows)
        for row in rows:
            if duplicates[row.source_key] > 1:
                questions[row.id].append({"code": "DUPLICATE_KEY", "field": "group", "blocking": True})
        references = {(ref.row_id, ref.field): ref for ref in db.scalars(select(SourceReference).join(ImportRow).where(ImportRow.batch_id == batch.id))}
        existing = {(issue.row_id, issue.code, issue.field): issue for issue in db.scalars(select(ImportIssue).join(ImportRow).where(ImportRow.batch_id == batch.id))}
        for issue in existing.values():
            issue.resolved = True
        for row in rows:
            for question in questions[row.id]:
                key = (row.id, question["code"], question["field"])
                issue = existing.get(key)
                if issue is None:
                    issue = ImportIssue(row_id=row.id, source_reference_id=references[(row.id, question["field"])].id,
                                        code=question["code"], field=question["field"], blocking=question["blocking"])
                    db.add(issue)
                issue.resolved = False
        db.flush()

    def open_questions(self, db, batch_id):
        questions = defaultdict(list)
        for issue, ref in db.execute(select(ImportIssue, SourceReference).join(SourceReference).join(ImportRow, ImportRow.id == ImportIssue.row_id)
                                    .where(ImportRow.batch_id == batch_id, ImportIssue.resolved.is_(False))):
            questions[issue.row_id].append({"id": str(issue.id), "code": issue.code, "field": issue.field,
                                          "blocking": issue.blocking, "coordinate": ref.coordinate,
                                          "source_reference_id": str(ref.id)})
        return questions

    def dto(self, db, batch, context, offset=0, limit=25):
        rows = db.scalars(select(ImportRow).where(ImportRow.batch_id == batch.id).order_by(ImportRow.source_row)).all()
        questions = self.open_questions(db, batch.id)
        demands = {d.source_key: d for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
        summary = {"rows": len(rows), "new": 0, "changed": 0, "unchanged": 0, "missing": 0,
                   "open_issues": sum(len(value) for value in questions.values()), "ready": 0, "duplicate_rows": 0}
        output = []
        for index, row in enumerate(rows):
            old = demands.get(row.source_key)
            row_issues = questions[row.id]
            if not old:
                action = "new"
            elif row.normalized == old.normalized and issue_signature(row_issues) == issue_signature(old.open_issues):
                action = "unchanged"
            else:
                action = "changed"
            summary[action] += 1
            summary["ready"] += not any(issue["blocking"] for issue in row_issues)
            summary["duplicate_rows"] += any(issue["code"] == "DUPLICATE_KEY" for issue in row_issues)
            if offset <= index < offset + limit:
                output.append({"id": str(row.id), "source_row": row.source_row, "raw": row.raw,
                               "normalized": row.normalized, "corrections": row.corrections,
                               "references_confirmed": row.references_confirmed, "issues": row_issues,
                               "action": action, "previous": old.normalized if old else None,
                               "demand_id": str(old.id) if old else None})
        keys = {row.source_key for row in rows}
        missing = [d for key, d in demands.items() if key not in keys]
        summary["missing"] = len(missing)
        return {"id": str(batch.id), "filename": batch.filename, "sha256": batch.file_sha256, "template": batch.template,
                "sheet": batch.sheet, "range": f"A1:L{batch.last_row}", "hour_unit": batch.hour_unit,
                "status": batch.status, "revision": batch.revision, "base_revision": batch.base_revision,
                "context_revision": context.revision, "stale": batch.status == "preview" and context.revision != batch.base_revision,
                "academic_year": context.academic_year, "data_kind": context.data_kind, "summary": summary,
                "offset": offset, "limit": limit, "rows": output,
                "missing": [{"id": str(d.id), "group": d.normalized.get("group"), "subject": d.normalized.get("subject")} for d in missing]}

    def get(self, token, batch_id, offset=0, limit=25):
        with self.factory() as db:
            batch, context, _ = self.batch_access(db, token, batch_id)
            return self.dto(db, batch, context, offset, limit)

    def list(self, token, scope_id):
        with self.factory() as db:
            self.authorize(db, token, scope_id)
            return [{"id": str(batch.id), "filename": batch.filename, "academic_year": context.academic_year,
                     "data_kind": context.data_kind, "status": batch.status, "revision": batch.revision}
                    for batch, context in db.execute(select(ImportBatch, ImportContext).join(ImportContext)
                        .where(ImportContext.scope_id == scope_id).order_by(ImportBatch.created_at.desc()).limit(100))]

    def revise(self, token, batch_id, row_id, revision, corrections, confirmed, request_id):
        with self.factory.begin() as db:
            batch, context, user = self.batch_access(db, token, batch_id, write=True, lock=True)
            if batch.status != "preview":
                raise ApiError("IMPORT_ALREADY_APPLIED", 409)
            if batch.revision != revision or context.revision != batch.base_revision:
                raise ApiError("IMPORT_STALE", 409)
            row = db.scalar(select(ImportRow).where(ImportRow.id == row_id, ImportRow.batch_id == batch.id))
            if row is None:
                raise ApiError("NOT_FOUND", 404)
            row.corrections = {**row.corrections, **corrections}
            row.references_confirmed = confirmed
            batch.revision += 1
            db.flush()
            self.refresh(db, batch, context)
            audit(db, "import.row.review", "updated", request_id, user.id)
            index = db.scalar(select(func.count()).select_from(ImportRow).where(ImportRow.batch_id == batch.id, ImportRow.source_row < row.source_row))
            return self.dto(db, batch, context, offset=(index // 25) * 25)

    def reference(self, db, model, field, value, context):
        candidates = db.scalars(select(model).where(model.scope_id == context.scope_id, model.data_kind == context.data_kind,
                                                   getattr(model, field) == value)).all()
        if len(candidates) > 1:
            raise ApiError("IMPORT_REFERENCE_AMBIGUOUS", 409)
        if candidates:
            return candidates[0].id
        extra = {"name_sha256": hashlib.sha256(value.encode()).hexdigest()} if model is Subject else {}
        record = model(scope_id=context.scope_id, data_kind=context.data_kind, **{field: value}, **extra)
        db.add(record)
        db.flush()
        return record.id

    def apply(self, token, batch_id, revision, request_id):
        with self.factory.begin() as db:
            batch, context, user = self.batch_access(db, token, batch_id, write=True, lock=True)
            if batch.status == "applied":
                return self.dto(db, batch, context)
            if batch.revision != revision or context.revision != batch.base_revision:
                raise ApiError("IMPORT_STALE", 409)
            self.refresh(db, batch, context)
            questions = self.open_questions(db, batch.id)
            rows = db.scalars(select(ImportRow).where(ImportRow.batch_id == batch.id).order_by(ImportRow.source_row)).all()
            existing = {d.source_key: d for d in db.scalars(select(TeachingDemand).where(TeachingDemand.context_id == context.id))}
            changed = False
            for row in rows:
                normalized, row_issues = row.normalized, questions[row.id]
                if any(issue["code"] == "DUPLICATE_KEY" for issue in row_issues):
                    # Preserve both originals in the accepted batch. They are an
                    # unresolved question, never two invented independent demands.
                    changed = True
                    continue
                demand = existing.get(row.source_key)
                if demand and normalized == demand.normalized and issue_signature(row_issues) == issue_signature(demand.open_issues):
                    continue
                changed = True
                if demand is None:
                    demand = TeachingDemand(context_id=context.id, source_key=row.source_key, revision=1,
                                            source_row_id=row.id, normalized=normalized, open_issues=row_issues)
                    db.add(demand)
                    db.flush()
                    previous = None
                else:
                    previous = db.scalar(select(DemandRevision).where(DemandRevision.demand_id == demand.id,
                                                                     DemandRevision.revision == demand.revision))
                    demand.revision += 1
                demand.source_row_id, demand.normalized, demand.open_issues = row.id, normalized, row_issues
                demand.weekly_amount = Decimal(normalized["weekly_hours"]) if normalized["weekly_hours"] is not None else None
                demand.semester_amount = Decimal(normalized["semester_hours"]) if normalized["semester_hours"] is not None else None
                references = {}
                if not any(issue["blocking"] for issue in row_issues):
                    references["group_id"] = str(self.reference(db, Group, "code", normalized["group"], context))
                    references["subject_id"] = str(self.reference(db, Subject, "name", normalized["subject"], context))
                    references["teacher_id"] = str(self.reference(db, Teacher, "display_name", normalized["teacher"], context))
                demand.group_id = uuid.UUID(references["group_id"]) if references else None
                demand.subject_id = uuid.UUID(references["subject_id"]) if references else None
                history = DemandRevision(demand_id=demand.id, revision=demand.revision,
                                         previous_revision_id=previous.id if previous else None, source_row_id=row.id,
                                         normalized=normalized, open_issues=row_issues, reference_ids=references, confirmed_by=user.id)
                db.add(history)
                db.flush()
                db.execute(delete(TeachingAssignment).where(TeachingAssignment.demand_id == demand.id))
                if references:
                    db.add(TeachingAssignment(demand_id=demand.id, teacher_id=uuid.UUID(references["teacher_id"]),
                                              source_revision_id=history.id, confirmed_by=user.id))
            if changed:
                context.revision += 1
            batch.status, batch.applied_at = "applied", datetime.now(UTC)
            batch.applied_context_revision = context.revision
            audit(db, "import.apply", "applied", request_id, user.id)
            db.flush()
            return self.dto(db, batch, context)

    def history(self, token, batch_id, row_id):
        with self.factory() as db:
            batch, context, _ = self.batch_access(db, token, batch_id)
            row = db.scalar(select(ImportRow).where(ImportRow.id == row_id, ImportRow.batch_id == batch.id))
            if row is None:
                raise ApiError("NOT_FOUND", 404)
            demand = db.scalar(select(TeachingDemand).where(TeachingDemand.context_id == context.id, TeachingDemand.source_key == row.source_key))
            if demand is None:
                return []
            results = db.execute(select(DemandRevision, ImportRow, ImportBatch)
                                 .join(ImportRow, ImportRow.id == DemandRevision.source_row_id)
                                 .join(ImportBatch, ImportBatch.id == ImportRow.batch_id)
                                 .where(DemandRevision.demand_id == demand.id).order_by(DemandRevision.revision.desc())).all()
            return [{"id": str(history.id), "revision": history.revision,
                     "previous_revision_id": str(history.previous_revision_id) if history.previous_revision_id else None,
                     "normalized": history.normalized, "open_issues": history.open_issues,
                     "source": {"batch_id": str(source.id), "filename": source.filename, "sheet": source.sheet, "row": original.source_row}}
                    for history, original, source in results]

    def source(self, token, batch_id):
        with self.factory() as db:
            batch, _, _ = self.batch_access(db, token, batch_id)
            return batch.filename, batch.original_file

    @staticmethod
    def unresolved_for_context(db, context_id, groups=None):
        """Latest accepted source per key, including questions with no demand.

        A missing row never removes an older question. A later accepted review
        of that key supersedes it. The generator must call this before solving.
        """
        recent = (select(ImportRow.source_key, ImportBatch.id.label("batch_id"))
                  .join(ImportBatch, ImportBatch.id == ImportRow.batch_id)
                  .where(ImportBatch.context_id == context_id, ImportBatch.status == "applied")
                  .ext(distinct_on(ImportRow.source_key))
                  .order_by(ImportRow.source_key, ImportBatch.applied_at.desc(), ImportBatch.id.desc()).subquery())
        rows = db.scalars(select(ImportRow).join(recent, (recent.c.source_key == ImportRow.source_key) &
                                               (recent.c.batch_id == ImportRow.batch_id))).all()
        result = []
        for row in rows:
            group = row.normalized.get("group")
            if groups is not None and group is not None and group not in groups:
                continue
            questions = db.scalars(select(ImportIssue).where(ImportIssue.row_id == row.id, ImportIssue.resolved.is_(False))).all()
            if questions:
                result.append({"source_row_id": str(row.id), "group": group,
                               "issues": [{"code": issue.code, "field": issue.field} for issue in questions]})
        return result
