"""GitHub handoff metadata for preparing issue drafts."""

from uuid import UUID

from fastapi import APIRouter

from routes.incidents import get_incident

router = APIRouter(prefix="/api/incidents/{incident_id}/github", tags=["github"])


@router.get("/context")
def get_github_context(incident_id: UUID) -> dict[str, str]:
    """Return repository destination metadata; no live GitHub data is fetched."""
    get_incident(incident_id)
    repository = "mhdanaso/patchproof"
    return {
        "repository": repository,
        "issues_url": f"https://github.com/{repository}/issues",
        "integration_status": "draft_only",
    }
