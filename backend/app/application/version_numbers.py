"""A number belongs to one academic context; allocation never changes inputs."""
from sqlalchemy import update
from ..infrastructure.models import ImportContext


def next_version_number(db, context_id):
    return db.scalar(update(ImportContext).where(ImportContext.id == context_id)
        .values(version_counter=ImportContext.version_counter + 1).returning(ImportContext.version_counter))
