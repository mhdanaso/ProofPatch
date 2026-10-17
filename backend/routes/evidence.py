"""Evidence collection and retrieval for ProofPatch incidents."""

from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from database import append_workflow_record, list_workflow_records
from routes.incidents import incident_exists

router = APIRouter(prefix="/api/incidents/{incident_id}/evidence", tags=["evidence"])


class EvidenceInput(BaseModel):
    source: str = Field(min_length=1, max_length=100)
    observation: str = Field(min_length=1, max_length=4000)
    details: dict[str, Any] = Field(default_factory=dict)


class EvidenceRecord(EvidenceInput):
    id: UUID
    incident_id: UUID
    collected_at: datetime


def _require_incident(incident_id: UUID) -> None:
    if not incident_exists(incident_id):
        raise HTTPException(status_code=404, detail="Incident not found")


def _record_evidence(incident_id: UUID, item: EvidenceInput) -> EvidenceRecord:
    record = EvidenceRecord(
        **item.model_dump(),
        id=uuid4(),
        incident_id=incident_id,
        collected_at=datetime.now(timezone.utc),
    )
    append_workflow_record("evidence", incident_id, record.model_dump(mode="json"), record.collected_at.isoformat())
    return record


def evidence_for_incident(incident_id: UUID) -> list[EvidenceRecord]:
    return [EvidenceRecord.model_validate(item) for item in list_workflow_records("evidence", incident_id)]


@router.post("", response_model=EvidenceRecord, status_code=status.HTTP_201_CREATED)
def add_evidence(incident_id: UUID, payload: EvidenceInput) -> EvidenceRecord:
    _require_incident(incident_id)
    return _record_evidence(incident_id, payload)


@router.get("", response_model=list[EvidenceRecord])
def list_evidence(incident_id: UUID) -> list[EvidenceRecord]:
    _require_incident(incident_id)
    return evidence_for_incident(incident_id)


@router.post("/collect-demo", response_model=list[EvidenceRecord])
def collect_demo_evidence(incident_id: UUID) -> list[EvidenceRecord]:
    _require_incident(incident_id)
    fixtures = [
        EvidenceInput(
            source="health check",
            observation="GET /health returned HTTP 500: missing PAYMENT_TIMEOUT",
            details={"service": "demo-checkout", "endpoint": "http://127.0.0.1:8080/health"},
        ),
        EvidenceInput(
            source="application log",
            observation="Configuration lookup failed because PAYMENT_TIMEOUT was not set",
            details={"exception": "KeyError", "key": "PAYMENT_TIMEOUT"},
        ),
        EvidenceInput(
            source="recent change",
            observation="The payment timeout setting was renamed to PAYMENT_TIMEOUT_MS",
            details={"previous_key": "PAYMENT_TIMEOUT", "current_key": "PAYMENT_TIMEOUT_MS"},
        ),
    ]
    existing = list_evidence(incident_id)
    known = {(record.source, record.observation) for record in existing}
    added = []
    for fixture in fixtures:
        key = (fixture.source, fixture.observation)
        if key not in known:
            added.append(_record_evidence(incident_id, fixture))
            known.add(key)
    return existing + added
