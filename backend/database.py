"""Small SQLite persistence layer for incident workflow records."""

import json
import os
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4


DEFAULT_DB_PATH = Path(__file__).with_name("proofpatch.sqlite3")
DB_PATH = Path(os.environ.get("PROOFPATCH_DB_PATH", str(DEFAULT_DB_PATH))).expanduser()


def parse_datetime(value: str) -> datetime:
    """Parse ISO timestamps from SQLite JSON on supported Python versions."""
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


@contextmanager
def _session() -> Iterator[sqlite3.Connection]:
    connection = _connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with _session() as connection:
        connection.execute("PRAGMA journal_mode = WAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS incidents (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analyses (
                incident_id TEXT PRIMARY KEY REFERENCES incidents(id) ON DELETE CASCADE,
                analyzed_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS workflow_records (
                id TEXT PRIMARY KEY,
                incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                source TEXT NOT NULL,
                event_key TEXT NOT NULL,
                incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                received_at TEXT NOT NULL,
                PRIMARY KEY(source, event_key)
            );
            CREATE TABLE IF NOT EXISTS github_change_events (
                id TEXT PRIMARY KEY,
                delivery_id TEXT NOT NULL UNIQUE,
                repository TEXT NOT NULL,
                service TEXT NOT NULL,
                occurred_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS github_change_correlations (
                event_id TEXT NOT NULL REFERENCES github_change_events(id) ON DELETE CASCADE,
                incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
                PRIMARY KEY(event_id, incident_id)
            );
            CREATE INDEX IF NOT EXISTS idx_workflow_records_incident_kind_time
                ON workflow_records(incident_id, kind, occurred_at);
            CREATE INDEX IF NOT EXISTS idx_github_change_service_time
                ON github_change_events(service, occurred_at);
            """
        )


def save_incident(record: dict[str, Any]) -> None:
    with _session() as connection:
        connection.execute(
            "INSERT INTO incidents(id, created_at, payload) VALUES (?, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
            (record["id"], record["created_at"], json.dumps(record)),
        )


def get_incident_record(incident_id: UUID | str) -> dict[str, Any] | None:
    with _session() as connection:
        row = connection.execute(
            "SELECT payload FROM incidents WHERE id = ?", (str(incident_id),)
        ).fetchone()
    return json.loads(row["payload"]) if row else None


def list_incident_records() -> list[dict[str, Any]]:
    with _session() as connection:
        rows = connection.execute(
            "SELECT payload FROM incidents ORDER BY created_at DESC"
        ).fetchall()
    records = [json.loads(row["payload"]) for row in rows]
    return sorted(
        records,
        key=lambda record: record.get("updated_at") or record["created_at"],
        reverse=True,
    )


def save_analysis(incident_id: UUID | str, analyzed_at: str, record: dict[str, Any]) -> None:
    with _session() as connection:
        connection.execute(
            "INSERT INTO analyses(incident_id, analyzed_at, payload) VALUES (?, ?, ?) "
            "ON CONFLICT(incident_id) DO UPDATE SET analyzed_at=excluded.analyzed_at, payload=excluded.payload",
            (str(incident_id), analyzed_at, json.dumps(record)),
        )


def get_analysis(incident_id: UUID | str) -> dict[str, Any] | None:
    with _session() as connection:
        row = connection.execute(
            "SELECT payload FROM analyses WHERE incident_id = ?", (str(incident_id),)
        ).fetchone()
    return json.loads(row["payload"]) if row else None


def append_workflow_record(kind: str, incident_id: UUID | str, record: dict[str, Any], occurred_at: str) -> None:
    with _session() as connection:
        connection.execute(
            "INSERT INTO workflow_records(id, incident_id, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?)",
            (record["id"], str(incident_id), kind, occurred_at, json.dumps(record)),
        )


def list_workflow_records(kind: str, incident_id: UUID | str) -> list[dict[str, Any]]:
    with _session() as connection:
        rows = connection.execute(
            "SELECT payload FROM workflow_records WHERE incident_id = ? AND kind = ? ORDER BY occurred_at ASC, rowid ASC",
            (str(incident_id), kind),
        ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def list_all_workflow_records(kind: str) -> list[dict[str, Any]]:
    with _session() as connection:
        rows = connection.execute(
            "SELECT payload FROM workflow_records WHERE kind = ? ORDER BY occurred_at ASC, rowid ASC",
            (kind,),
        ).fetchall()
    return [json.loads(row["payload"]) for row in rows]


def create_webhook_incident(
    source: str,
    event_key: str,
    incident: dict[str, Any],
    evidence: dict[str, Any],
) -> tuple[dict[str, Any], str]:
    """Deduplicate or correlate an alert, otherwise create an incident atomically."""
    with _session() as connection:
        connection.execute("BEGIN IMMEDIATE")
        existing = connection.execute(
            "SELECT incident_id FROM webhook_deliveries WHERE source = ? AND event_key = ?",
            (source, event_key),
        ).fetchone()
        if existing:
            row = connection.execute(
                "SELECT payload FROM incidents WHERE id = ?", (existing["incident_id"],)
            ).fetchone()
            if row:
                return json.loads(row["payload"]), "duplicate"

        received_at = datetime.fromisoformat(incident["created_at"].replace("Z", "+00:00"))
        correlation_cutoff = received_at - timedelta(minutes=30)
        correlation_target: dict[str, Any] | None = None
        rows = connection.execute(
            "SELECT created_at, payload FROM incidents ORDER BY created_at DESC"
        ).fetchall()
        for row in rows:
            candidate = json.loads(row["payload"])
            candidate_time = datetime.fromisoformat(
                (candidate.get("updated_at") or row["created_at"]).replace("Z", "+00:00")
            )
            if candidate_time < correlation_cutoff:
                continue
            if (
                candidate.get("source") == source
                and str(candidate.get("service") or "").strip().casefold()
                == str(incident.get("service") or "").strip().casefold()
                and candidate.get("status") in {"open", "investigating"}
            ):
                correlation_target = candidate
                break

        if correlation_target:
            severity_rank = {"low": 0, "medium": 1, "high": 2, "critical": 3}
            current_severity = correlation_target.get("severity", "medium")
            incoming_severity = incident.get("severity", "medium")
            if severity_rank.get(incoming_severity, 1) > severity_rank.get(current_severity, 1):
                correlation_target["severity"] = incoming_severity
            correlation_target["updated_at"] = incident["updated_at"]
            incident_id = correlation_target["id"]
            evidence["incident_id"] = incident_id
            connection.execute(
                "UPDATE incidents SET payload = ? WHERE id = ?",
                (json.dumps(correlation_target), incident_id),
            )
            outcome = "correlated"
        else:
            incident_id = incident["id"]
            connection.execute(
                "INSERT INTO incidents(id, created_at, payload) VALUES (?, ?, ?)",
                (incident_id, incident["created_at"], json.dumps(incident)),
            )
            outcome = "created"

        connection.execute(
            "INSERT INTO workflow_records(id, incident_id, kind, occurred_at, payload) "
            "VALUES (?, ?, ?, ?, ?)",
            (
                evidence["id"],
                incident_id,
                "evidence",
                evidence["collected_at"],
                json.dumps(evidence),
            ),
        )
        connection.execute(
            "INSERT INTO webhook_deliveries(source, event_key, incident_id, received_at) "
            "VALUES (?, ?, ?, ?)",
            (source, event_key, incident_id, evidence["collected_at"]),
        )
        return correlation_target or incident, outcome


def _utc_datetime(value: str) -> datetime:
    parsed = parse_datetime(value)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _attach_change_evidence(
    connection: sqlite3.Connection,
    event: sqlite3.Row,
    incident: dict[str, Any],
    collected_at: datetime,
) -> bool:
    incident_id = str(incident["id"])
    inserted = connection.execute(
        "INSERT OR IGNORE INTO github_change_correlations(event_id, incident_id) VALUES (?, ?)",
        (event["id"], incident_id),
    )
    if inserted.rowcount == 0:
        return False

    change = json.loads(event["payload"])
    details = dict(change.get("details") or {})
    details["github_event_id"] = event["id"]
    evidence = {
        "id": str(uuid4()),
        "incident_id": incident_id,
        "source": change["source"],
        "observation": change["observation"],
        "details": details,
        "collected_at": collected_at.isoformat(),
    }
    connection.execute(
        "INSERT INTO workflow_records(id, incident_id, kind, occurred_at, payload) VALUES (?, ?, ?, ?, ?)",
        (evidence["id"], incident_id, "evidence", evidence["collected_at"], json.dumps(evidence)),
    )
    incident["updated_at"] = collected_at.isoformat()
    connection.execute(
        "UPDATE incidents SET payload = ? WHERE id = ?",
        (json.dumps(incident), incident_id),
    )
    # The previous analysis no longer reflects the incident's full evidence set.
    connection.execute("DELETE FROM analyses WHERE incident_id = ?", (incident_id,))
    return True


def save_github_change_event(delivery_id: str, record: dict[str, Any]) -> dict[str, Any]:
    """Persist a signed GitHub change and attach it to matching active incidents."""
    event_id = str(uuid4())
    received_at = datetime.now(timezone.utc)
    event_time = _utc_datetime(record["occurred_at"])
    service_key = str(record["service"]).strip().casefold()
    attached_incidents: list[str] = []
    with _session() as connection:
        connection.execute("BEGIN IMMEDIATE")
        duplicate = connection.execute(
            "SELECT id FROM github_change_events WHERE delivery_id = ?", (delivery_id,)
        ).fetchone()
        if duplicate:
            return {"duplicate": True, "attached_incidents": []}

        connection.execute(
            "INSERT INTO github_change_events(id, delivery_id, repository, service, occurred_at, payload) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (
                event_id,
                delivery_id,
                record["repository"],
                record["service"],
                event_time.isoformat(),
                json.dumps(record),
            ),
        )
        event = connection.execute(
            "SELECT * FROM github_change_events WHERE id = ?", (event_id,)
        ).fetchone()
        rows = connection.execute("SELECT payload FROM incidents").fetchall()
        for row in rows:
            incident = json.loads(row["payload"])
            incident_service = str(incident.get("service") or "").strip().casefold()
            if incident_service != service_key or incident.get("status") not in {"open", "investigating"}:
                continue
            incident_time = _utc_datetime(incident["created_at"])
            if event_time < incident_time - timedelta(minutes=60) or event_time > received_at + timedelta(minutes=5):
                continue
            if _attach_change_evidence(connection, event, incident, received_at):
                attached_incidents.append(str(incident["id"]))

    return {"duplicate": False, "attached_incidents": attached_incidents}


def attach_recent_github_changes(incident_id: UUID | str) -> int:
    """Attach matching GitHub changes recorded during the hour before an incident."""
    collected_at = datetime.now(timezone.utc)
    with _session() as connection:
        connection.execute("BEGIN IMMEDIATE")
        incident_row = connection.execute(
            "SELECT payload FROM incidents WHERE id = ?", (str(incident_id),)
        ).fetchone()
        if not incident_row:
            return 0
        incident = json.loads(incident_row["payload"])
        service = str(incident.get("service") or "").strip().casefold()
        if not service:
            return 0
        created_at = _utc_datetime(incident["created_at"])
        cutoff = (created_at - timedelta(minutes=60)).isoformat()
        upper_bound = (created_at + timedelta(minutes=1)).isoformat()
        events = connection.execute(
            "SELECT * FROM github_change_events WHERE lower(trim(service)) = ? "
            "AND occurred_at >= ? AND occurred_at <= ? ORDER BY occurred_at DESC LIMIT 100",
            (service, cutoff, upper_bound),
        ).fetchall()
        return sum(
            _attach_change_evidence(connection, event, incident, collected_at)
            for event in events
        )


initialize_database()
