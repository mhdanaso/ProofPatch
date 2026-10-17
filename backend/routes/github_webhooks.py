"""Signed GitHub change-event intake and incident correlation."""

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Request, status

from database import save_github_change_event

router = APIRouter(prefix="/api/webhooks", tags=["GitHub webhooks"])
MAX_BODY_BYTES = 1_000_000
SUPPORTED_EVENTS = {"push", "deployment_status", "pull_request"}
TERMINAL_DEPLOYMENT_STATES = {"success", "failure", "error", "inactive"}


def _text(value: Any, limit: int = 1000) -> str:
    return value.strip()[:limit] if isinstance(value, str) else ""


def _mapping() -> dict[str, str]:
    """Read comma-separated repository=service pairs from the environment."""
    result: dict[str, str] = {}
    for item in os.getenv("PROOFPATCH_GITHUB_SERVICES", "").split(","):
        repository, separator, service = item.partition("=")
        if separator and repository.strip() and service.strip():
            result[repository.strip().casefold()] = service.strip()[:100]
    return result


def _parse_time(value: Any, fallback: datetime) -> datetime:
    if not isinstance(value, str) or not value.strip():
        return fallback
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return fallback
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _event_record(event_type: str, payload: dict[str, Any], received_at: datetime) -> dict[str, Any] | None:
    repository_data = payload.get("repository")
    repository = _text(repository_data.get("full_name"), 200) if isinstance(repository_data, dict) else ""
    if not repository:
        raise HTTPException(status_code=422, detail="GitHub event is missing its repository name.")

    repo_name = repository.rsplit("/", 1)[-1]
    service = _mapping().get(repository.casefold(), repo_name)[:100]
    details: dict[str, Any] = {
        "repository": repository,
        "service": service,
        "event": event_type,
    }

    if event_type == "push":
        if payload.get("deleted") is True:
            return None
        branch = _text(payload.get("ref"), 300).removeprefix("refs/heads/")
        commit = _text(payload.get("after"), 80)
        head = payload.get("head_commit") if isinstance(payload.get("head_commit"), dict) else {}
        message = _text(head.get("message"), 1000)
        commit_url = (
            _text(head.get("html_url"), 1000)
            or _text(payload.get("compare"), 1000)
            or (f"https://github.com/{repository}/commit/{commit}" if commit else "")
        )
        actor = _text((payload.get("pusher") or {}).get("name"), 200) if isinstance(payload.get("pusher"), dict) else ""
        occurred_at = received_at
        details.update({
            "branch": branch,
            "commit": commit,
            "commit_message": message,
            "url": commit_url,
            "actor": actor,
            "occurred_at": occurred_at.isoformat(),
        })
        summary = f"Push to {branch or 'the repository'} in {repository} was recorded."
        if message:
            summary += f" Latest commit: {message}"
        summary += " This is a timing clue, not a confirmed cause."
        source = "GitHub push"

    elif event_type == "deployment_status":
        deployment = payload.get("deployment") if isinstance(payload.get("deployment"), dict) else {}
        deployment_status = payload.get("deployment_status") if isinstance(payload.get("deployment_status"), dict) else {}
        state = _text(deployment_status.get("state"), 40).casefold()
        if state not in TERMINAL_DEPLOYMENT_STATES:
            return None
        environment = _text(deployment.get("environment"), 200) or "unspecified environment"
        branch = _text(deployment.get("ref"), 300)
        commit = _text(deployment.get("sha"), 80)
        description = _text(deployment_status.get("description"), 1000) or _text(deployment.get("description"), 1000)
        target_url = _text(deployment_status.get("target_url"), 1000) or _text(deployment_status.get("log_url"), 1000)
        actor_data = deployment_status.get("creator") if isinstance(deployment_status.get("creator"), dict) else {}
        actor = _text(actor_data.get("login"), 200)
        occurred_at = _parse_time(deployment_status.get("created_at"), received_at)
        details.update({
            "environment": environment,
            "state": state,
            "branch": branch,
            "commit": commit,
            "description": description,
            "url": target_url,
            "actor": actor,
            "occurred_at": occurred_at.isoformat(),
        })
        summary = f"Deployment to {environment} for {repository} finished with status {state}."
        if description:
            summary += f" {description}"
        summary += " This timing signal does not establish cause."
        source = "GitHub deployment"

    else:  # pull_request
        pull_request = payload.get("pull_request") if isinstance(payload.get("pull_request"), dict) else {}
        if _text(payload.get("action"), 40).casefold() != "closed" or not pull_request.get("merged"):
            return None
        number = pull_request.get("number") or payload.get("number")
        title = _text(pull_request.get("title"), 300)
        base_data = pull_request.get("base") if isinstance(pull_request.get("base"), dict) else {}
        head_data = pull_request.get("head") if isinstance(pull_request.get("head"), dict) else {}
        base_ref = _text(base_data.get("ref"), 300)
        head_ref = _text(head_data.get("ref"), 300)
        merge_sha = _text(pull_request.get("merge_commit_sha"), 80)
        url = _text(pull_request.get("html_url"), 1000)
        author_data = pull_request.get("merged_by") if isinstance(pull_request.get("merged_by"), dict) else {}
        actor = _text(author_data.get("login"), 200)
        occurred_at = _parse_time(pull_request.get("merged_at"), received_at)
        details.update({
            "number": number,
            "title": title,
            "base_branch": base_ref,
            "head_branch": head_ref,
            "commit": merge_sha,
            "url": url,
            "actor": actor,
            "occurred_at": occurred_at.isoformat(),
        })
        pr_label = f"PR #{number}" if isinstance(number, (int, str)) else "Pull request"
        summary = f"{pr_label} was merged into {base_ref or 'the default branch'} in {repository}."
        if title:
            summary += f" {title}"
        summary += " This is a timing clue, not a confirmed cause."
        source = "GitHub merged pull request"

    return {
        "repository": repository,
        "service": service,
        "occurred_at": occurred_at.isoformat(),
        "source": source,
        "observation": summary,
        "details": details,
    }


@router.post("/github", status_code=status.HTTP_202_ACCEPTED)
async def receive_github_webhook(
    request: Request,
    event_type: str | None = Header(default=None, alias="X-GitHub-Event"),
    signature: str | None = Header(default=None, alias="X-Hub-Signature-256"),
    delivery_id: str | None = Header(default=None, alias="X-GitHub-Delivery"),
) -> dict[str, Any]:
    """Verify GitHub's HMAC signature and correlate pushes, deploys, and merges."""
    secret = os.getenv("PROOFPATCH_GITHUB_WEBHOOK_SECRET", "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="GitHub webhook is not configured.")
    if not event_type or not signature or not delivery_id:
        raise HTTPException(status_code=401, detail="Required GitHub webhook headers are missing.")
    if len(delivery_id) > 200:
        raise HTTPException(status_code=400, detail="GitHub delivery ID is too long.")

    content_length = request.headers.get("content-length")
    if content_length and content_length.isdigit() and int(content_length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="GitHub webhook payload is too large.")
    body = await request.body()
    if len(body) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="GitHub webhook payload is too large.")

    algorithm, separator, supplied_digest = signature.partition("=")
    expected_digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    if (
        not separator
        or algorithm.casefold() != "sha256"
        or not hmac.compare_digest(supplied_digest, expected_digest)
    ):
        raise HTTPException(status_code=401, detail="Invalid GitHub webhook signature.")

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="GitHub webhook body must be valid JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="GitHub webhook body must be a JSON object.")

    normalized_event = event_type.strip().casefold()
    if normalized_event not in SUPPORTED_EVENTS:
        return {"status": "ignored", "reason": "unsupported_event", "event": normalized_event}

    record = _event_record(normalized_event, payload, datetime.now(timezone.utc))
    if record is None:
        return {"status": "ignored", "reason": "event_has_no_completed_change"}

    result = save_github_change_event(delivery_id, record)
    if result["duplicate"]:
        return {"status": "duplicate", "delivery_id": delivery_id, "correlated_incidents": []}
    return {
        "status": "accepted",
        "event": normalized_event,
        "repository": record["repository"],
        "service": record["service"],
        "correlated_incidents": result["attached_incidents"],
    }
