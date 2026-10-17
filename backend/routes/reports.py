"""Unified incident report assembled from persisted workflow records."""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel

from database import list_workflow_records
from routes.analysis import IncidentAnalysis, latest_analysis_for_incident
from routes.approvals import ApprovalRecord, approval_records_for_incident
from routes.evidence import EvidenceRecord, evidence_for_incident
from routes.incidents import IncidentRecord, get_incident
from routes.verification import VerificationRecord, verification_records_for_incident

router = APIRouter(prefix="/api/incidents", tags=["reports"])


class TimelineEvent(BaseModel):
    occurred_at: datetime
    kind: str
    summary: str
    reference_id: UUID | None = None


class IncidentReport(BaseModel):
    generated_at: datetime
    incident: IncidentRecord
    evidence: list[EvidenceRecord]
    analysis: IncidentAnalysis | None
    approvals: list[ApprovalRecord]
    verifications: list[VerificationRecord]
    timeline: list[TimelineEvent]


def _evidence_time(item: EvidenceRecord) -> datetime:
    """Use the source event's timestamp for GitHub changes in the timeline."""
    value = item.details.get("occurred_at")
    if isinstance(value, str):
        try:
            occurred_at = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return occurred_at.replace(tzinfo=timezone.utc) if occurred_at.tzinfo is None else occurred_at
        except ValueError:
            pass
    return item.collected_at


@router.get("/{incident_id}/report", response_model=IncidentReport)
def get_incident_report(incident_id: UUID) -> IncidentReport:
    incident = get_incident(incident_id)
    evidence = evidence_for_incident(incident_id)
    analysis = latest_analysis_for_incident(incident_id)
    approvals = approval_records_for_incident(incident_id)
    verifications = verification_records_for_incident(incident_id)
    events = [
        TimelineEvent(
            occurred_at=incident.created_at,
            kind="incident_created",
            summary=f"Incident reported: {incident.title}",
            reference_id=incident.id,
        )
    ]
    events.extend(
        TimelineEvent(
            occurred_at=_evidence_time(item),
            kind="github_change_recorded" if item.source.casefold().startswith("github ") else "evidence_collected",
            summary=f"{item.source}: {item.observation}",
            reference_id=item.id,
        )
        for item in evidence
    )
    if analysis:
        events.append(
            TimelineEvent(
                occurred_at=analysis.analyzed_at,
                kind="analysis_completed",
                summary=analysis.root_cause.summary,
            )
        )
    events.extend(
        TimelineEvent(
            occurred_at=item.recorded_at,
            kind="approval_recorded",
            summary=f"{item.decision.capitalize()} by {item.approver}" + (f": {item.note}" if item.note else ""),
            reference_id=item.id,
        )
        for item in approvals
    )
    events.extend(
        TimelineEvent(
            occurred_at=item.checked_at,
            kind="service_check_recorded" if item.kind == "manual" else "verification_completed",
            summary=(
                f"Manual service check {item.status}: {item.check_name}" + (f" — {item.note}" if item.note else "")
                if item.kind == "manual"
                else f"Sandbox verification {item.status}: {item.summary}"
            ),
            reference_id=item.id,
        )
        for item in verifications
    )
    events.extend(
        TimelineEvent(
            occurred_at=item["occurred_at"],
            kind="incident_status_changed",
            summary=f"Incident status changed from {item['from_status']} to {item['to_status']} by {item.get('changed_by', 'Workspace user')}.",
            reference_id=item["id"],
        )
        for item in list_workflow_records("status", incident_id)
    )
    events.sort(key=lambda event: event.occurred_at)
    return IncidentReport(
        generated_at=datetime.now(timezone.utc),
        incident=incident,
        evidence=evidence,
        analysis=analysis,
        approvals=approvals,
        verifications=verifications,
        timeline=events,
    )
