from alembic import context
from sqlalchemy import create_engine

from backend.app.config import Settings
from backend.app.infrastructure.models import Base
from backend.app.infrastructure import journal_models  # register the journal schema
from backend.app.infrastructure import lesson_models  # register recorded lessons

config = context.config
settings = Settings()

if context.is_offline_mode():
    context.configure(url=settings.database_url, target_metadata=Base.metadata, literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()
else:
    def migrate(connection):
        context.configure(connection=connection, target_metadata=Base.metadata)
        with context.begin_transaction():
            context.run_migrations()
    supplied_connection = config.attributes.get("connection")
    if supplied_connection is not None:
        migrate(supplied_connection)
    else:
        engine = create_engine(settings.database_url, hide_parameters=True)
        with engine.connect() as connection:
            migrate(connection)
