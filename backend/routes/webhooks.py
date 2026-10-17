"""Authenticated Prometheus Alertmanager webhook intake."""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Body, Header, HTTPException, status

from database import attach_recent_github_changes, create_webhook_incident
from routes.evidence import EvidenceRecord
from routes.incidents import IncidentRecord

router = APIRouter(prefix="/api/webhooks", tags=["webhooks"])
SOURCE = "webhook:prometheus-alertmanager"
ALERTMANAGER_EVIDENCE_SOURCE = "Prometheus Alertmanager"


def _text(value: Any, limit: int = 2000) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _severity(value: Any) -> str:
    normalized = _text(value, 30).casefold()
    return {
        "critical": "critical",
        "high": "high",
        "error": "high",
        "warning": "medium",
        "warn": "medium",
        "medium": "medium",
        "info": "low",
        "low": "low",
    }.get(normalized, "medium")


def _string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        _text(key, 100): _text(item, 1000)
        for key, item in list(value.items())[:40]
        if isinstance(key, str) and isinstance(item, str) and _text(key, 100)
    }


def _event_key(alert: dict[str, Any], labels: dict[str, Any], title: str) -> str:
    fingerprint = _text(alert.get("fingerprint"), 200)
    starts_at = _text(alert.get("startsAt"), 100)
    if not fingerprint:
        stable_alert = {
            "labels": labels,
            "title": title,
            "startsAt": starts_at,
        }
        fingerprint = json.dumps(stable_alert, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(f"{fingerprint}|{starts_at}".encode("utf-8")).hexdigest()


@router.post("/alerts", status_code=status.HTTP_202_ACCEPTED)
def receive_alertmanager_webhook(
    payload: dict[str, Any] = Body(...),
    webhook_token: str | None = Header(default=None, alias="X-ProofPatch-Webhook-Token"),
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Turn firing Alertmanager notifications into evidence-backed incidents.

    Retries for the same alert fingerprint and start time reuse the original
    incident. Different firing alerts for the same service are correlated into
    an active webhook incident from the last 30 minutes. Resolved notifications
    are acknowledged but never close an incident automatically.
    """
    expected_token = os.getenv("PROOFPATCH_WEBHOOK_TOKEN", "").strip()
    if not expected_token:
        raise HTTPException(status_code=503, detail="Alert webhook is not configured.")
    bearer_token = ""
    if authorization:
        scheme, separator, credentials = authorization.partition(" ")
        if separator and scheme.casefold() == "bearer":
            bearer_token = credentials.strip()
    supplied_token = bearer_token or (webhook_token or "").strip()
    if not supplied_token or not hmac.compare_digest(supplied_token, expected_token):
        raise HTTPException(status_code=401, detail="Invalid webhook token.")

    alerts = payload.get("alerts")
    if not isinstance(alerts, list):
        raise HTTPException(status_code=422, detail="Expected an Alertmanager payload with an alerts array.")
    if len(alerts) > 100:
        raise HTTPException(status_code=413, detail="A webhook request may contain at most 100 alerts.")

    created: list[dict[str, str]] = []
    correlated: list[dict[str, str]] = []
    duplicates: list[dict[str, str]] = []
    ignored_non_firing = 0

    for alert in alerts:
        if not isinstance(alert, dict):
            continue
        alert_status = _text(alert.get("status", payload.get("status", "firing")), 30).casefold()
        if alert_status != "firing":
            ignored_non_firing += 1
            continue

        raw_labels = alert.get("labels")
        raw_annotations = alert.get("annotations")
        labels = _string_map(raw_labels)
        annotations = _string_map(raw_annotations)
        summary = _text(annotations.get("summary"), 1000)
        title = _text(labels.get("alertname"), 160) or summary[:160] or "Monitoring alert"
        service = (
            _text(labels.get("service"), 100)
            or _text(labels.get("job"), 100)
            or title[:100]
        )
        description = _text(annotations.get("description"), 2000) or summary
        if not description:
            description = f"Prometheus Alertmanager reported {title} as firing."
        severity_name = _text(labels.get("severity"), 30)
        started_at = datetime.now(timezone.utc)
        incident = IncidentRecord(
            id=uuid4(),
            title=title,
            service=service,
            severity=_severity(severity_name),
            description=description,
            symptoms=[summary] if summary else [],
            source=SOURCE,
            status="open",
            created_at=started_at,
            updated_at=started_at,
        )
        evidence = EvidenceRecord(
            id=uuid4(),
            incident_id=incident.id,
            source=ALERTMANAGER_EVIDENCE_SOURCE,
            observation=description[:4000],
            details={
                "status": alert_status,
                "fingerprint": _text(alert.get("fingerprint"), 200),
                "labels": labels,
                "annotations": annotations,
                "startsAt": _text(alert.get("startsAt"), 100),
                "endsAt": _text(alert.get("endsAt"), 100),
                "generatorURL": _text(alert.get("generatorURL"), 1000),
                "receiver": _text(payload.get("receiver"), 200),
            },
            collected_at=started_at,
        )
        incident_data = incident.model_dump(mode="json")
        evidence_data = evidence.model_dump(mode="json")
        saved, outcome = create_webhook_incident(
            SOURCE,
            _event_key(alert, labels, title),
            incident_data,
            evidence_data,
        )
        attach_recent_github_changes(saved["id"])
        entry = {"id": str(saved["id"]), "title": saved["title"]}
        {
            "created": created,
            "correlated": correlated,
            "duplicate": duplicates,
        }[outcome].append(entry)

    return {
        "received": len(alerts),
        "created": created,
        "correlated": correlated,
        "duplicates": duplicates,
        "ignored_non_firing": ignored_non_firing,
    }
