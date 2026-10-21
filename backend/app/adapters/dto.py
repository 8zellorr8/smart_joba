from typing import Literal
from uuid import UUID

from pydantic import BaseModel

Role = Literal["admin", "scheduler", "approver", "teacher", "student"]


class GrantDTO(BaseModel):
    role: Role
    scope_id: UUID
    scope_name: str
    is_demo: bool
    group_id: UUID | None
    teacher_id: UUID | None


class UserDTO(BaseModel):
    id: UUID
    email: str
    display_name: str
    home_scope_id: UUID
    grants: list[GrantDTO]


class SessionDTO(BaseModel):
    user: UserDTO | None
    csrf_token: str


class ScopeDTO(BaseModel):
    id: UUID
    name: str
    is_demo: bool


class WorkspaceDTO(BaseModel):
    scope: ScopeDTO
    role_codes: list[Role]
    permissions: list[str]
    stage: Literal[3]


class HealthDTO(BaseModel):
    status: Literal["ok"]
    database: Literal["ok"]
    stage: Literal[3]
