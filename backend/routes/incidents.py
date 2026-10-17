"""Incident intake routes for the ProofPatch API."""

from datetime import datetime, timezone
from typing import Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from database import append_workflow_record, attach_recent_github_changes, get_incident_record, list_incident_records, list_workflow_records, parse_datetime, save_incident

router = APIRouter(prefix="/api/incidents", tags=["incidents"])


class IncidentIntake(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    service: str = Field(min_length=1, max_length=100)
    severity: str = Field(default="medium", pattern="^(low|medium|high|critical)$")
    description: str = Field(default="", max_length=2000)
    symptoms: list[str] = Field(default_factory=list, max_length=30)
    source: str = Field(default="manual", max_length=100)


class IncidentRecord(IncidentIntake):
    id: UUID
    status: Literal["open", "investigating", "resolved", "closed"] = "open"
    created_at: datetime
    updated_at: datetime


class IncidentStatusUpdate(BaseModel):
    status: Literal["open", "investigating", "resolved", "closed"]


class IncidentStatusEvent(BaseModel):
    id: UUID
    incident_id: UUID
    from_status: str
    to_status: str
    changed_by: str = "Workspace user"
    occurred_at: datetime


@router.get("/{incident_id}/status-history", response_model=list[IncidentStatusEvent])
def status_history(incident_id: UUID) -> list[IncidentStatusEvent]:
    get_incident(incident_id)
    return [IncidentStatusEvent.model_validate(item) for item in list_workflow_records("status", incident_id)]


@router.post("", response_model=IncidentRecord, status_code=status.HTTP_201_CREATED)
def create_incident(payload: IncidentIntake) -> IncidentRecord:
    now = datetime.now(timezone.utc)
    incident = IncidentRecord(
        **payload.model_dump(),
        id=uuid4(),
        status="open",
        created_at=now,
        updated_at=now,
    )
    save_incident(incident.model_dump(mode="json"))
    attach_recent_github_changes(incident.id)
    return incident


@router.get("", response_model=list[IncidentRecord])
def list_incidents() -> list[IncidentRecord]:
    return [IncidentRecord.model_validate(item) for item in list_incident_records()]


@router.get("/{incident_id}", response_model=IncidentRecord)
def get_incident(incident_id: UUID) -> IncidentRecord:
    record = get_incident_record(incident_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Incident not found")
    return IncidentRecord.model_validate(record)


@router.patch("/{incident_id}/status", response_model=IncidentRecord)
def update_incident_status(incident_id: UUID, payload: IncidentStatusUpdate) -> IncidentRecord:
    incident = get_incident(incident_id)
    current = incident.status
    target = payload.status
    if current == target:
        return incident

    allowed_transitions = {
        "open": {"investigating"},
        "investigating": {"resolved"},
        "resolved": {"investigating", "closed"},
        "closed": {"investigating"},
    }
    if target not in allowed_transitions[current]:
        raise HTTPException(
            status_code=409,
            detail=f"Incident cannot move from {current} to {target}.",
        )
    if target == "resolved":
        from routes.approvals import approval_records_for_incident

        approvals = approval_records_for_incident(incident_id)
        if not approvals or approvals[-1].decision != "approved":
            raise HTTPException(
                status_code=409,
                detail="The latest human review must be approved before resolving this incident.",
            )
        history = list_workflow_records("status", incident_id)
        investigation = next(
            (item for item in reversed(history) if item.get("to_status") == "investigating"),
            None,
        )
        if investigation is None:
            raise HTTPException(status_code=409, detail="Start an investigation before resolving this incident.")
        investigation_at = parse_datetime(investigation["occurred_at"])
        if approvals[-1].recorded_at <= investigation_at:
            raise HTTPException(
                status_code=409,
                detail="Record a fresh human review after starting or reopening the investigation.",
            )
        checks = list_workflow_records("verification", incident_id)
        if not checks or checks[-1].get("status") != "passed":
            raise HTTPException(
                status_code=409,
                detail="Record a passed verification or service check before resolving this incident.",
            )
        checked_at = parse_datetime(checks[-1]["checked_at"])
        if checked_at <= approvals[-1].recorded_at:
            raise HTTPException(
                status_code=409,
                detail="Run a passed check after the latest human review before resolving this incident.",
            )

    now = datetime.now(timezone.utc)
    updated = incident.model_copy(update={"status": target, "updated_at": now})
    save_incident(updated.model_dump(mode="json"))
    event = IncidentStatusEvent(
        id=uuid4(),
        incident_id=incident_id,
        from_status=current,
        to_status=target,
        occurred_at=now,
    )
    append_workflow_record("status", incident_id, event.model_dump(mode="json"), now.isoformat())
    return updated


def incident_exists(incident_id: UUID) -> bool:
    return get_incident_record(incident_id) is not None
