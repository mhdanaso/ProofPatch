# ProofPatch

**Evidence-first incident response, with verified fixes and human approval.**

ProofPatch is an incident-response workspace built during a hackathon. It accepts manually reported incidents and monitoring alerts, gathers operational and GitHub change evidence, explains what the evidence supports, and records human review and verification in a persistent incident timeline. Rule-based analysis works without an AI key; optional AI adds a second interpretation without applying changes.

## MVP workflow

```text
Manual report or alert → evidence and related changes → evidence-based analysis → human review → verification → incident report
```

The starter uses deterministic sample data, so it works without a paid model or API key. Add a free model provider only after the end-to-end demo works; keep evidence collection and verification deterministic.

## Repository layout

```text
proofpatch/
├── backend/       # FastAPI endpoints, workflow routes, and SQLite storage
├── frontend/      # Static dashboard (no Node setup needed)
├── demo-app/      # Reproducible failing health check
├── CONTRIBUTING.md
└── README.md
```

## Run it locally

You need Python 3.10 or newer.

### 1. Start the API

```bash
cd backend
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload
```

API health: <http://127.0.0.1:8000/api/health>  
Interactive API docs: <http://127.0.0.1:8000/docs>

### Submit an incident

`POST /api/incidents` accepts a JSON body with `title` and `service` required.
Optional fields are `severity` (`low`, `medium`, `high`, or `critical`),
`description`, `symptoms` (a list of strings), and `source` (defaults to
`manual`). The response includes a generated incident ID, an `open` status,
and UTC creation/update times. Use `GET /api/incidents` to list incidents or
`GET /api/incidents/{incident_id}` to retrieve one. Incidents and workflow
records are stored in SQLite and remain available after the API process restarts.

### Manage incident status

Incidents can move through `open → investigating → resolved → closed`. A
resolved incident can be reopened for investigation. ProofPatch requires the
latest human review to be approved after investigation starts and a passed
sandbox verification or manually recorded service check after that review
before allowing resolution. Reopening requires a new review and check. Each
transition is added to the incident report timeline.

Use `PATCH /api/incidents/{incident_id}/status` with a JSON body such as:

```json
{"status": "investigating"}
```

The allowed status values are `open`, `investigating`, `resolved`, and `closed`.
Invalid transitions return `409 Conflict`. Use
`GET /api/incidents/{incident_id}/status-history` to view the transition history.

Example:

```json
{
  "title": "Checkout returns HTTP 500",
  "service": "demo-checkout",
  "severity": "high",
  "description": "Errors began after a configuration change.",
  "symptoms": ["GET /health returned 500"],
  "source": "demo-alert"
}
```

### Receive monitoring alerts

ProofPatch can accept firing alerts from Prometheus Alertmanager at
`POST /api/webhooks/alerts`. Add `PROOFPATCH_WEBHOOK_TOKEN` to `backend/.env`
locally and to the backend service's environment settings when hosted. Configure
Alertmanager to send the same secret as a bearer token in the `Authorization`
request header. Requests without the matching token are rejected. Keep the
token private and do not put it in frontend code.

The endpoint accepts Alertmanager's standard `alerts` payload. It creates an
open incident with the alert labels and annotations saved as evidence. Different
firing alerts for the same service are grouped into one open or investigating
webhook incident when it received a related alert within the last 30 minutes; each alert is
kept as a separate evidence item, and a higher severity alert raises the
incident's severity. Retries for the same alert fingerprint and start time are
deduplicated. Resolved notifications are acknowledged but do not close
incidents. A person still reviews the evidence, approves or rejects
recommendations, and records a service check before resolving an incident.
The response separates `created`, `correlated`, and `duplicates` so an alert
sender can see how each firing alert was handled.

Example Alertmanager payload:

```json
{
  "receiver": "proofpatch",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "CheckoutHealthCheckFailed",
        "service": "checkout-api",
        "severity": "critical"
      },
      "annotations": {
        "summary": "Checkout health check is returning HTTP 500",
        "description": "GET /health returned HTTP 500 for five minutes."
      },
      "startsAt": "2026-10-17T10:30:00Z",
      "fingerprint": "a1b2c3d4e5f6",
      "generatorURL": "https://prometheus.example/graph"
    }
  ]
}
```

For a local PowerShell example, set the same secret in the current terminal and
send the payload from a JSON file:

```powershell
$env:PROOFPATCH_WEBHOOK_TOKEN = "your-shared-secret"
Invoke-RestMethod -Uri "http://127.0.0.1:8000/api/webhooks/alerts" `
  -Method Post `
  -Headers @{ Authorization = "Bearer $env:PROOFPATCH_WEBHOOK_TOKEN" } `
  -ContentType "application/json" `
  -InFile ".\alertmanager-payload.json"
```

To generate a secret, use a password manager or a secure random generator. Add
the exact same value to the backend environment and Alertmanager's bearer-token
secret configuration. Alertmanager supports reading this token from a protected
credentials file. On Render, also set `PROOFPATCH_DB_PATH` to a file on the
persistent disk so incidents created by webhook deliveries survive restarts.

### Correlate GitHub changes with incidents

ProofPatch can receive GitHub pushes, merged pull requests, and completed
deployment statuses at `POST /api/webhooks/github`. Set
`PROOFPATCH_GITHUB_WEBHOOK_SECRET` in `backend/.env` and in the backend host's
environment. GitHub signs each delivery with this secret; unsigned or invalid
requests are rejected. The raw webhook payload is not retained.

To connect a repository to the service name used by your incidents, set
`PROOFPATCH_GITHUB_SERVICES` as comma-separated `owner/repository=service-name`
pairs. For this repository, for example:

```env
PROOFPATCH_GITHUB_SERVICES=mhdanaso/patchproof=demo-checkout
```

If no mapping is set, ProofPatch uses the repository's short name as its service
name. The mapped service must match the incident's **Service** field exactly
(the built-in demo uses `demo-checkout`).

In GitHub, open **Settings → Webhooks → Add webhook** and use the backend URL
with `/api/webhooks/github` appended. Choose `application/json`, paste the same
secret, and subscribe to **Pushes**, **Pull requests**, and **Deployments**.
ProofPatch records pushes, pull requests only after they are merged, and
deployment statuses after they finish. On the incident page, matched changes
appear in collected evidence and the incident timeline with links and commit or
deployment details. ProofPatch checks changes from the hour before an incident;
later changes for the same service can also be attached while an incident is
active. Matching uses service name and timing, so a change is shown as a clue,
not asserted to be the cause. Each GitHub delivery is processed once.

The SQLite database stores received change events and their incident links. On
Render, use a persistent disk and set `PROOFPATCH_DB_PATH` to a file on that disk
if this history should survive service restarts..

### Collect incident evidence

Attach a piece of evidence with `POST /api/incidents/{incident_id}/evidence`.
Each item has a `source`, an `observation`, and optional structured `details`.
Use `GET /api/incidents/{incident_id}/evidence` to retrieve the incident's
evidence. For the checkout demo, `POST
/api/incidents/{incident_id}/evidence/collect-demo` adds repeatable health-check,
application-log, and recent-change evidence fixtures without requiring external
services. Repeating the demo collection does not add duplicates. Evidence is
stored with its incident in SQLite and remains available after an API restart.

Example request body for manually attaching evidence:

```json
{
  "source": "application log",
  "observation": "KeyError: PAYMENT_TIMEOUT",
  "details": {"file": "demo-app/app.py", "line": 13}
}
```

### Triage and analyze an incident

Call `POST /api/incidents/{incident_id}/analyze` after collecting evidence.
The deterministic analysis returns a triage summary, severity, evidence sources,
a root-cause finding with confidence and supporting evidence IDs, remediation
recommendations, and next steps. The current rule recognizes the demo's missing
configuration setting when the application log and recent-change evidence agree.
If the evidence is incomplete or does not match that rule, the API reports the
cause as undetermined and recommends gathering more evidence. Recommendations
are advisory; the API does not apply changes and marks human approval as required.

### Record approval and verify a proposed fix

Record a human decision with `POST /api/incidents/{incident_id}/approvals`,
using `decision` (`approved` or `rejected`), `approver`, and an optional `note`.
`GET /api/incidents/{incident_id}/approvals` returns the approval history. An
approval record is an audit entry only; it does not apply a recommendation.
Verification endpoints require the latest approval to be `approved`.

`POST /api/incidents/{incident_id}/verify` checks a proposed demo configuration
against fixed rules: the application setting is supported, that setting appears
in the proposed configuration, and the timeout value is positive. This is a
deterministic contract check; it does not execute submitted code or modify the
demo service. For example:

```json
{
  "application_setting_name": "PAYMENT_TIMEOUT_MS",
  "configured_setting_names": ["PAYMENT_TIMEOUT_MS"],
  "timeout_value": 30000
}
```

Use `GET /api/incidents/{incident_id}/verifications` to view prior results.
These sandbox checks are available for the seeded checkout demo only.

### Record a manual service check

For a custom incident, run a project-specific test or health check yourself,
then record what happened with `POST
/api/incidents/{incident_id}/service-check`. The latest approval must be
`approved`. This endpoint records the result; it does not execute a command,
call a service, or verify the result independently.

Example request body:

```json
{
  "check_name": "GET /health",
  "outcome": "passed",
  "note": "Returned HTTP 200 after the configuration update."
}
```

Set `outcome` to `passed` or `failed`. `check_name` is required; `note` is
optional. The result is included in `GET /api/incidents/{incident_id}/report`
and the incident timeline.

### Generate an incident report

`GET /api/incidents/{incident_id}/report` combines the incident, collected
evidence, latest analysis, approval history, verification history, and a
chronological timeline, including incident status changes. Run analysis and
record any verification or approval first if you want those entries included.

### Review workspace analytics

The **Analytics** tab summarizes saved incident history. Select 7, 30, or 90
days to see new incidents by day, the severity mix and most affected services
for that period, the current open/investigating workload, resolutions recorded
during the period, and mean time from incident creation to each resolution.
Metrics are calculated from ProofPatch's SQLite incident and status history;
they do not require an external analytics service. The API endpoint is
`GET /api/analytics/overview?days=30` (the API accepts 7–90 days).

### Persistent storage

The API creates `backend/proofpatch.sqlite3` by default. To place the database
elsewhere, set `PROOFPATCH_DB_PATH` before starting the backend. For a hosted
deployment, point this variable at a mounted persistent volume (for example,
`/var/data/proofpatch.sqlite3`). A normal container filesystem may be cleared
when the host replaces the instance.

### 2. Open the dashboard

In a second terminal, from the repository root:

```bash
python -m http.server 5500 --directory frontend
```

Open <http://127.0.0.1:5500>. Choose **Start demo incident** for the guided
checkout example, or choose **Report a problem** to submit a title, affected
service, severity, description, and symptoms. A custom report is saved through
`POST /api/incidents`; its description and symptoms are attached as evidence
through `POST /api/incidents/{id}/evidence`; the dashboard then requests
`POST /api/incidents/{id}/analyze` and `GET /api/incidents/{id}/report`. With
`AI_API_KEY` configured, the optional model uses the supplied report and evidence
to suggest a likely cause and fix. Without the key, ProofPatch gives a cautious
evidence-based fallback and asks for more information rather than claiming an
unsupported root cause. Review the recommendation and record approval or
rejection.

For a custom incident, approve the recommendation, run a project-specific test
or health check outside ProofPatch, then record the check name, pass/fail result,
and optional note in the **Service check** panel. The report timeline records
that manual result. The seeded demo uses its built-in deterministic sandbox
checks.

The incident workspace supports incident intake, authenticated monitoring webhook
ingestion with 30-minute alert correlation, signed GitHub change ingestion with
incident correlation, workspace analytics, seeded evidence collection,
deterministic root-cause analysis, optional AI enrichment, reviewer
approval/rejection, seeded sandbox verification, manual service-check recording
for custom incidents, persistent SQLite history, an incident resolve/reopen
lifecycle with a review-and-check gate, status audit events, a workspace overview, searchable incident
queue with severity and status filters, GitHub issue draft actions, downloadable
Markdown reports, and a chronological incident report. GitHub issue handoff
prepares a draft only and does not create issues automatically. Copy
`backend/.env.example` to `backend/.env` and add your key
if you want AI enrichment:

```env
AI_API_URL=https://openrouter.ai/api/v1/chat/completions
AI_API_KEY=your_key_here
AI_MODEL=openrouter/free
# Required for authenticated Alertmanager webhook intake
PROOFPATCH_WEBHOOK_TOKEN=replace_with_a_long_random_secret
# Required for signed GitHub change webhooks
PROOFPATCH_GITHUB_WEBHOOK_SECRET=replace_with_a_long_random_secret
# Optional repository-to-service mapping
# PROOFPATCH_GITHUB_SERVICES=mhdanaso/patchproof=demo-checkout
# Optional hosted volume path; local default is backend/proofpatch.sqlite3
# PROOFPATCH_DB_PATH=/var/data/proofpatch.sqlite3
```

Restart Uvicorn after changing `.env`. The deterministic evidence analysis and workflow remain available if the provider is unavailable or returns an invalid response.

## Deploy the hosted demo

The hosted dashboard is a static site on Vercel and the API is a FastAPI service
on Render. The dashboard's `frontend/vercel.json` forwards `/api/*` requests to
the Render API, so browser requests stay on the dashboard's own domain.

### Render API

Create a **Web Service** from this repository and configure:

- **Root directory:** `backend`
- **Build command:** `pip install -r requirements.txt`
- **Start command:** `uvicorn main:app --host 0.0.0.0 --port $PORT`
- **Health check path:** `/api/health`

Add optional `AI_API_URL`, `AI_API_KEY`, and `AI_MODEL` environment variables if
you want AI enrichment. Add `PROOFPATCH_WEBHOOK_TOKEN` only when connecting
Alertmanager, and `PROOFPATCH_GITHUB_WEBHOOK_SECRET` only when connecting a
GitHub repository webhook. For GitHub correlation, also set
`PROOFPATCH_GITHUB_SERVICES` to the exact incident service mapping, such as
`mhdanaso/patchproof=demo-checkout`.

SQLite is the default store. If the Render service is restarted or replaced
without a persistent disk, saved incidents and workflow history may be lost.
To retain them, attach a persistent disk and set
`PROOFPATCH_DB_PATH=/var/data/proofpatch.sqlite3` (or the path for that disk).

After deployment, open `https://<your-render-service>.onrender.com/api/health`.
It should return `{"status":"ok","app":"ProofPatch"}`. The API's interactive
documentation is at `/docs`.

### Vercel dashboard

Import the same GitHub repository as a Vercel project and set its **Root
Directory** to `frontend`. No build command or framework preset is required;
ProofPatch is plain HTML, CSS, and JavaScript. The committed
`frontend/vercel.json` sends API calls to the configured Render hostname. If
your Render service URL changes, update the rewrite destination in that file
before redeploying the frontend.

Open the Vercel URL, choose **Load demo incident**, and check that evidence,
analysis, approval, verification, and the incident report load. The optional
`demo-app/` service is a local-only fixture; the hosted walkthrough uses the
repeatable API evidence and sandbox workflow instead. To use the AI section on
the hosted site, set the AI variables on Render and redeploy the backend.

## Final demo readiness checklist

- Open the Vercel dashboard in a private/incognito window and load a new demo
  incident.
- Confirm the report-an-incident flow accepts a custom service and description.
- Review the evidence and analysis, record a human decision, then run the
  sandbox checks for the seeded demo or record a manual check for a custom
  incident.
- Refresh the page and confirm the current incident and report history return.
- If presenting AI or GitHub change correlation, verify those integrations are
  configured on the hosted backend; otherwise present the deterministic
  analysis and explain that live GitHub activity is optional.
- Keep a local screenshot or short screen recording as a fallback in case the
  hosting provider is temporarily unavailable.

ProofPatch is a review workflow demonstration, not a production incident
platform: it has no user accounts or access control, the database is SQLite,
and it does not execute arbitrary fixes or automatically change services.

### 3. Run the controlled failure (optional)

In another terminal, from the repository root:

```bash
python demo-app/app.py
```

Open <http://127.0.0.1:8080/health>. It returns an intentional 500 until `PAYMENT_TIMEOUT` is configured. This gives the team a simple reproducible incident to improve during the hackathon.

## Four-person starting split

1. **Backend and AI:** API shape, evidence, optional free-model integration.
2. **Frontend:** dashboard, incident view, evidence and approval experience.
3. **Demo and verification:** controlled failure, repeatable checks, patch workflow.
4. **Integration and demo lead:** coordinate branches, connect the pieces, prepare the walkthrough.

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch and review guidance.

## GitHub branches and contributor credit

- Keep `main` as the stable demo branch.
- Use `integration` as the shared branch for combining and reviewing team work.
- Create task branches from `integration`, then open pull requests into
  `integration`. When the combined work is ready, merge `integration` into
  `main`.
- Merging a branch does not grant repository access. The repository owner adds
  teammates under **Settings → Collaborators**.
- GitHub can attribute commits in the repository's Contributors view when the
  original author email is linked to that person's GitHub account and the
  commit reaches the repository's default branch. Ask each teammate to commit
  their own changes or preserve their original commit authorship. The merge
  commit itself does not count as a contributor commit; GitHub's contributor
  data can take up to 24 hours to refresh. See [GitHub's contributor graph
  documentation](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-a-projects-contributors).

## Safety boundary

This is a demo, not a production incident-response system. Do not connect it to production credentials or let it apply changes automatically. A human must review proposed changes before any pull request or remediation action.

## Team Members

mhdanaso
HariNandvv
nihad-777
albin8620
