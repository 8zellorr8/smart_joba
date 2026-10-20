from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


def create_database(url: str):
    engine = create_engine(url, pool_pre_ping=True, hide_parameters=True)
    return engine, sessionmaker(bind=engine, expire_on_commit=False)
