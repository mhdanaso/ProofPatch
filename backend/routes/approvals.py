"""Human approval audit records for proposed remediation."""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from database import append_workflow_record, list_workflow_records
from routes.incidents import incident_exists

router = APIRouter(prefix="/api/incidents/{incident_id}/approvals", tags=["approvals"])


class ApprovalInput(BaseModel):
    decision: Literal["approved", "rejected"]
    approver: str = Field(min_length=1, max_length=120)
    note: str = Field(default="", max_length=1000)


class ApprovalRecord(ApprovalInput):
    id: UUID
    incident_id: UUID
    recorded_at: datetime


def approval_records_for_incident(incident_id: UUID) -> list[ApprovalRecord]:
    return [ApprovalRecord.model_validate(item) for item in list_workflow_records("approval", incident_id)]


@router.post("", response_model=ApprovalRecord, status_code=status.HTTP_201_CREATED)
def record_approval(incident_id: UUID, payload: ApprovalInput) -> ApprovalRecord:
    if not incident_exists(incident_id):
        raise HTTPException(status_code=404, detail="Incident not found")
    approval = ApprovalRecord(
        **payload.model_dump(),
        id=uuid4(),
        incident_id=incident_id,
        recorded_at=datetime.now(timezone.utc),
    )
    append_workflow_record("approval", incident_id, approval.model_dump(mode="json"), approval.recorded_at.isoformat())
    return approval


@router.get("", response_model=list[ApprovalRecord])
def list_approvals(incident_id: UUID) -> list[ApprovalRecord]:
    if not incident_exists(incident_id):
        raise HTTPException(status_code=404, detail="Incident not found")
    return approval_records_for_incident(incident_id)
