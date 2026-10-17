"""Evidence-based triage with optional external AI enrichment."""

import re
from datetime import datetime, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter
from pydantic import BaseModel, Field

from ai_analyst import analyze as analyze_with_ai
from database import get_analysis, save_analysis
from routes.evidence import EvidenceRecord, evidence_for_incident
from routes.incidents import IncidentRecord, get_incident

router = APIRouter(prefix="/api/incidents", tags=["triage and analysis"])


class RootCauseFinding(BaseModel):
    status: Literal["likely", "undetermined"]
    summary: str
    confidence: Literal["high", "medium", "low"]
    rationale: list[str]
    supporting_evidence_ids: list[UUID]


class RemediationRecommendation(BaseModel):
    action: str
    rationale: str
    risk: Literal["low", "medium", "high"]
    human_approval_required: bool = True


class AIAnalysis(BaseModel):
    provider: Literal["ai", "rules"]
    model: str | None = None
    summary: str
    likely_cause: str
    confidence: float = Field(ge=0, le=1)
    supporting_evidence_ids: list[str]
    recommended_fix: str
    verification_plan: list[str]
    unknowns: list[str]
    note: str


class IncidentAnalysis(BaseModel):
    incident_id: UUID
    analyzed_at: datetime
    triage_summary: str
    severity: str
    evidence_count: int
    evidence_sources: list[str]
    root_cause: RootCauseFinding
    recommendations: list[RemediationRecommendation]
    next_steps: list[str]
    ai_analysis: AIAnalysis | None = None


def _missing_config_key(evidence: list[EvidenceRecord]) -> tuple[str, UUID] | None:
    for item in evidence:
        if item.source.casefold() != "application log":
            continue
        key = item.details.get("key")
        if isinstance(key, str) and key:
            return key, item.id
        match = re.search(r"(?:KeyError|missing)\s*[:=]?\s*['\"]?([A-Z][A-Z0-9_]+)", item.observation)
        if match:
            return match.group(1), item.id
    return None


def _config_rename(evidence: list[EvidenceRecord]) -> tuple[str, str, UUID] | None:
    for item in evidence:
        if item.source.casefold() != "recent change":
            continue
        previous = item.details.get("previous_key")
        current = item.details.get("current_key")
        if isinstance(previous, str) and isinstance(current, str) and previous and current:
            return previous, current, item.id
    return None


def _ai_payload(incident: IncidentRecord, evidence: list[EvidenceRecord], root_cause: RootCauseFinding, recommendation: str) -> AIAnalysis:
    result = analyze_with_ai({
        "title": incident.title,
        "service": incident.service,
        "symptoms": incident.symptoms,
        "evidence": [item.model_dump(mode="json") for item in evidence],
        "root_cause": root_cause.summary,
        "suggested_fix": recommendation,
    })
    return AIAnalysis.model_validate(result)


@router.post("/{incident_id}/analyze", response_model=IncidentAnalysis)
def analyze_incident(incident_id: UUID) -> IncidentAnalysis:
    incident: IncidentRecord = get_incident(incident_id)
    evidence = evidence_for_incident(incident_id)
    sources = list(dict.fromkeys(item.source for item in evidence))
    health_failures = [item for item in evidence if item.source.casefold() == "health check" and any(signal in item.observation.casefold() for signal in ("500", "failed", "unhealthy", "error"))]
    missing_config = _missing_config_key(evidence)
    missing_key = missing_config[0] if missing_config else None
    renamed_key = _config_rename(evidence)
    recommendations: list[RemediationRecommendation]

    if renamed_key and missing_key == renamed_key[0]:
        previous, current, change_id = renamed_key
        supporting = [missing_config[1], *[item.id for item in health_failures], change_id]
        finding = RootCauseFinding(
            status="likely",
            summary=f"The service expects {previous}, while the updated configuration uses {current}.",
            confidence="high" if health_failures else "medium",
            rationale=[
                f"An application log reports the missing setting {missing_key}.",
                f"A recent-change record says {previous} was renamed to {current}.",
                *(["The health-check evidence confirms the service is failing."] if health_failures else []),
            ],
            supporting_evidence_ids=list(dict.fromkeys(supporting)),
        )
        recommendations = [
            RemediationRecommendation(
                action=f"Align the service and configuration on one setting name: update the service to read {current}, or restore {previous} in configuration.",
                rationale="This addresses the setting mismatch identified by the application log and change record.",
                risk="medium",
            ),
            RemediationRecommendation(
                action="Add a configuration validation check and a test for the selected setting name.",
                rationale="A startup check and regression test can catch a future mismatch before it causes an outage.",
                risk="low",
            ),
        ]
    else:
        rationale = ["A health-check record shows the service is failing."] if health_failures else []
        if missing_key:
            rationale.append(f"An application log references the missing setting {missing_key}.")
        if not renamed_key:
            rationale.append("No recent-change record with a before-and-after setting name was found.")
        finding = RootCauseFinding(status="undetermined", summary="The available evidence does not support a specific root-cause finding yet.", confidence="low", rationale=rationale or ["The collected evidence does not match a known deterministic rule."], supporting_evidence_ids=[item.id for item in health_failures])
        recommendations = [RemediationRecommendation(action="Collect the failing health-check response, relevant application logs, and the latest change record.", rationale="Those signals are needed to connect customer impact to a recent change before recommending a specific patch.", risk="low")]

    triage_summary = f"{incident.severity.capitalize()} severity incident for {incident.service}. Collected {len(evidence)} evidence item(s); " + ("a health-check failure is present." if health_failures else "no health-check failure was identified in the evidence.")
    result = IncidentAnalysis(
        incident_id=incident_id,
        analyzed_at=datetime.now(timezone.utc),
        triage_summary=triage_summary,
        severity=incident.severity,
        evidence_count=len(evidence),
        evidence_sources=sources,
        root_cause=finding,
        recommendations=recommendations,
        next_steps=["Review the evidence and recommendation with a teammate.", "Require human approval before applying any change.", "After an approved patch, run the sandbox health check and record the result."],
    )
    try:
        result.ai_analysis = _ai_payload(incident, evidence, finding, recommendations[0].action)
    except Exception as exc:
        result.ai_analysis = AIAnalysis(
            provider="rules",
            summary=finding.summary,
            likely_cause=finding.summary,
            confidence={"high": 0.82, "medium": 0.62, "low": 0.35}[finding.confidence],
            supporting_evidence_ids=[str(item.id) for item in finding.supporting_evidence_ids],
            recommended_fix=recommendations[0].action,
            verification_plan=["Review the proposal, approve it, then run deterministic sandbox checks."],
            unknowns=[f"AI enrichment unavailable ({type(exc).__name__}); deterministic analysis retained."],
            note="Deterministic evidence analysis is active; external AI enrichment was unavailable.",
        )
    save_analysis(str(incident_id), result.analyzed_at.isoformat(), result.model_dump(mode="json"))
    return result


def latest_analysis_for_incident(incident_id: UUID) -> IncidentAnalysis | None:
    record = get_analysis(incident_id)
    return IncidentAnalysis.model_validate(record) if record else None
