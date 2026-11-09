"""Course content belongs to one confirmed group/subject/semester journal."""
import uuid
from datetime import datetime

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    LargeBinary,
    SmallInteger,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from .models import Base


class Course(Base):
    __tablename__ = "courses"
    journal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("journals.id"), primary_key=True)
    created_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class CourseTopic(Base):
    __tablename__ = "course_topics"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    journal_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("courses.journal_id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    week_number: Mapped[int | None] = mapped_column(SmallInteger())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        CheckConstraint("week_number IS NULL OR week_number BETWEEN 1 AND 10", name="course_topic_week_number"),
    )


class CourseMaterial(Base):
    __tablename__ = "course_materials"
    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    topic_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("course_topics.id"), index=True)
    title: Mapped[str] = mapped_column(String(160))
    body: Mapped[str | None] = mapped_column(Text)
    pdf: Mapped[bytes | None] = mapped_column(LargeBinary, deferred=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("(body IS NULL) <> (pdf IS NULL)", name="course_material_one_format"),)
