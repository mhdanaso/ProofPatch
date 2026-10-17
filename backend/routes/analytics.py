"""Workspace-level incident analytics built from persisted incident history."""

from collections import Counter
from datetime import date, datetime, time, timedelta, timezone

from fastapi import APIRouter, Query

from database import list_all_workflow_records, list_incident_records, parse_datetime

router = APIRouter(prefix="/api/analytics", tags=["analytics"])
SEVERITIES = ("critical", "high", "medium", "low")
ACTIVE_STATUSES = {"open", "investigating"}


@router.get("/overview")
def analytics_overview(days: int = Query(default=30, ge=7, le=90)) -> dict:
    """Return incident volume, current workload, severity, service, and MTTR metrics."""
    now = datetime.now(timezone.utc)
    first_day = now.date() - timedelta(days=days - 1)
    window_start = datetime.combine(first_day, time.min, tzinfo=timezone.utc)
    daily_counts = {
        (first_day + timedelta(days=offset)).isoformat(): 0
        for offset in range(days)
    }

    incidents = list_incident_records()
    incidents_by_id = {str(item["id"]): item for item in incidents}
    created_in_window = []
    severity_counts: Counter[str] = Counter()
    service_counts: Counter[str] = Counter()
    for incident in incidents:
        created_at = parse_datetime(incident["created_at"])
        if not window_start <= created_at <= now:
            continue
        created_in_window.append(incident)
        day = created_at.date().isoformat()
        if day in daily_counts:
            daily_counts[day] += 1
        severity = incident.get("severity", "medium")
        if severity in SEVERITIES:
            severity_counts[severity] += 1
        service = str(incident.get("service") or "Unknown service").strip() or "Unknown service"
        service_counts[service] += 1

    resolved_events = 0
    resolution_durations_hours: list[float] = []
    for event in list_all_workflow_records("status"):
        if event.get("to_status") != "resolved":
            continue
        resolved_at = parse_datetime(event["occurred_at"])
        if not window_start <= resolved_at <= now:
            continue
        incident = incidents_by_id.get(str(event.get("incident_id")))
        if not incident:
            continue
        created_at = parse_datetime(incident["created_at"])
        duration_hours = (resolved_at - created_at).total_seconds() / 3600
        if duration_hours >= 0:
            resolved_events += 1
            resolution_durations_hours.append(duration_hours)

    average_resolution_hours = (
        round(sum(resolution_durations_hours) / len(resolution_durations_hours), 2)
        if resolution_durations_hours
        else None
    )
    status_counts = Counter(item.get("status", "open") for item in incidents)

    return {
        "generated_at": now.isoformat(),
        "window_days": days,
        "created_count": len(created_in_window),
        "active_count": sum(status_counts[status] for status in ACTIVE_STATUSES),
        "resolved_count": resolved_events,
        "mean_resolution_hours": average_resolution_hours,
        "severity_counts": {severity: severity_counts[severity] for severity in SEVERITIES},
        "daily_incidents": [
            {"date": day, "count": count} for day, count in daily_counts.items()
        ],
        "top_services": [
            {"service": service, "count": count}
            for service, count in service_counts.most_common(5)
        ],
    }
