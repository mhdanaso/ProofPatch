"""ProofPatch API for the local, evidence-first incident response demo."""

import json
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from ai_analyst import analyze
from routes.analysis import router as analysis_router
from routes.approvals import router as approvals_router
from routes.analytics import router as analytics_router
from routes.evidence import router as evidence_router
from routes.github import router as github_router
from routes.github_webhooks import router as github_webhooks_router
from routes.incidents import router as incidents_router
from routes.reports import router as reports_router
from routes.verification import router as verification_router
from routes.webhooks import router as webhooks_router

DEMO_APP_URL = "http://127.0.0.1:8080"

app = FastAPI(title="ProofPatch API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type"],
)
app.include_router(incidents_router)
app.include_router(analytics_router)
app.include_router(evidence_router)
app.include_router(github_router)
app.include_router(github_webhooks_router)
app.include_router(analysis_router)
app.include_router(verification_router)
app.include_router(approvals_router)
app.include_router(reports_router)
app.include_router(webhooks_router)


class ApprovalRequest(BaseModel):
    approved: bool


incident_state = {"approved": False, "verification": "Not run"}
cached_analysis = None


def call_demo_app(path: str, method: str = "GET") -> tuple[int, dict]:
    """Call only the local demo service; never targets a production system."""
    request = Request(f"{DEMO_APP_URL}{path}", method=method)
    try:
        with urlopen(request, timeout=2) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))
    except URLError as exc:
        raise HTTPException(
            status_code=503,
            detail="Demo service is unavailable. Start demo-app/app.py and retry.",
        ) from exc


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "ProofPatch"}


@app.get("/api/demo-incident")
def demo_incident():
    """Return repeatable evidence and current approval/verification status."""
    health_status, health_body = call_demo_app("/health")
    is_healthy = health_status == 200
    return {
        "id": "demo-checkout-config",
        "title": "Checkout errors are increasing",
        "service": "demo-checkout",
        "severity": "high",
        "status": "resolved" if is_healthy else "investigating",
        "symptoms": ["HTTP 500 responses", "checkout health check failing"],
        "evidence": [
            {
                "id": "E1",
                "source": "service health",
                "observation": f"GET /health returned {health_status}: {health_body.get('status', 'unknown')}",
            },
            {
                "id": "E2",
                "source": "application log",
                "observation": "ConfigurationError: required PAYMENT_TIMEOUT setting is missing",
            },
            {
                "id": "E3",
                "source": "recent change",
                "observation": "Payment timeout was renamed to PAYMENT_TIMEOUT_MS",
            },
        ],
        "root_cause": (
            "The service reads PAYMENT_TIMEOUT, while its updated configuration provides "
            "PAYMENT_TIMEOUT_MS. The missing setting causes the health check to fail."
        ),
        "suggested_fix": "Map PAYMENT_TIMEOUT_MS to PAYMENT_TIMEOUT in the demo service configuration.",
        "approval": "Approved for demo sandbox" if incident_state["approved"] else "Waiting for human review",
        "approved": incident_state["approved"],
        "verification": incident_state["verification"] if not is_healthy else "Passed: demo health check returned 200",
        "verification_passed": is_healthy,
    }


@app.post("/api/demo-incident/analyze")
def analyze_demo_incident():
    """Ask the optional AI analyst to interpret collected evidence; never apply a fix."""
    global cached_analysis
    if cached_analysis is None:
        incident = demo_incident()
        cached_analysis = analyze(incident)
    return {"analysis": cached_analysis}


@app.post("/api/demo-incident/approval")
def set_approval(decision: ApprovalRequest):
    """Record a human decision. Approval alone does not change the demo service."""
    incident_state["approved"] = decision.approved
    incident_state["verification"] = "Not run"
    return {
        "approved": decision.approved,
        "message": "Approved for the local demo sandbox." if decision.approved else "Fix rejected; no change was applied.",
    }


@app.post("/api/demo-incident/verify")
def verify_fix():
    """After explicit approval, apply the fix to the demo fixture and check health."""
    if not incident_state["approved"]:
        raise HTTPException(status_code=409, detail="A human must approve the fix before verification.")

    call_demo_app("/admin/apply-demo-fix", method="POST")
    status_code, health_body = call_demo_app("/health")
    passed = status_code == 200 and health_body.get("status") == "ok"
    incident_state["verification"] = (
        "Passed: demo health check returned 200" if passed else "Failed: demo health check is still failing"
    )
    return {"passed": passed, "status_code": status_code, "details": incident_state["verification"]}


@app.post("/api/demo-incident/reset")
def reset_demo():
    """Restore the seeded failure so the demonstration can be repeated."""
    global cached_analysis
    call_demo_app("/admin/reset", method="POST")
    incident_state["approved"] = False
    incident_state["verification"] = "Not run"
    cached_analysis = None
    return {"status": "reset", "message": "Demo incident restored to its failing state."}
