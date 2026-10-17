/* ProofPatch frontend: plain browser JavaScript calling the FastAPI workflow. */
const isLocalFrontend = ['localhost', '127.0.0.1'].includes(window.location.hostname);
const API_BASE = (window.PROOFPATCH_API_URL || (isLocalFrontend ? 'http://127.0.0.1:8000' : '')).replace(/\/$/, '');
const GITHUB_REPOSITORY = 'mhdanaso/patchproof';
const state = {
  incident: null,
  evidence: [],
  analysis: null,
  githubContext: null,
  incidents: [],
  incidentQuery: '',
  severityFilter: 'all',
  statusFilter: 'all',
  showAllIncidents: false,
  analytics: null,
  approvals: [],
  verifications: [],
  statusHistory: [],
  approvalFormOpen: false,
  report: null,
  busy: false,
  error: '',
  manualCheckFormOpen: false,
};

const incidentArea = document.querySelector('#incident');
const recentIncidentsPanel = document.querySelector('#recent-incidents');
const recentIncidentsList = document.querySelector('#recent-incidents-list');
const overviewStats = document.querySelector('#overview-stats');
const toast = document.querySelector('#toast');
let toastTimer;
let revealedIncidentId = null;
const revealObserver = !window.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window
  ? new IntersectionObserver((entries, observer) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -24px 0px' })
  : null;

function attachScrollEffects(root = document) {
  if (!revealObserver) return;
  root.querySelectorAll('.surface:not(.hidden), .stepper, .incident-toolbar, .flow-cards article').forEach((element) => {
    if (element.dataset.revealReady) return;
    element.dataset.revealReady = 'true';
    element.classList.add('reveal-on-scroll');
    revealObserver.observe(element);
  });
}

document.querySelector('#new-incident').addEventListener('click', startDemo);
document.querySelector('#banner-start').addEventListener('click', startDemo);
document.querySelector('#toggle-report-form').addEventListener('click', () => {
  const panel = document.querySelector('#report-problem-panel');
  panel.classList.remove('hidden');
  document.querySelector('#problem-title').focus();
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('#cancel-report-form').addEventListener('click', () => {
  document.querySelector('#report-problem-panel').classList.add('hidden');
});
document.querySelector('#report-problem-form').addEventListener('submit', submitProblem);
document.querySelector('#refresh-button').addEventListener('click', restoreLatestIncident);
document.querySelector('#refresh-incidents').addEventListener('click', () => loadRecentIncidents(true));
document.querySelector('#analytics-window').addEventListener('change', loadAnalytics);
document.querySelector('#refresh-analytics').addEventListener('click', loadAnalytics);
document.querySelector('#incident-search').addEventListener('input', (event) => {
  state.incidentQuery = event.target.value.trim().toLowerCase();
  state.showAllIncidents = false;
  renderRecentIncidents();
});
document.querySelector('#incident-severity').addEventListener('change', (event) => {
  state.severityFilter = event.target.value;
  state.showAllIncidents = false;
  renderRecentIncidents();
});
document.querySelector('#incident-status-filter').addEventListener('change', (event) => {
  state.statusFilter = event.target.value;
  state.showAllIncidents = false;
  renderRecentIncidents();
});
recentIncidentsList.addEventListener('click', handleRecentIncidentAction);
document.querySelectorAll('.site-nav .nav-link').forEach((link) => {
  link.addEventListener('click', (event) => {
    const section = document.querySelector(link.getAttribute('href'));
    if (!section || section.classList.contains('hidden')) {
      event.preventDefault();
      showToast('Start or report an incident to open this section.');
      return;
    }
    document.querySelectorAll('.site-nav .nav-link').forEach((item) => item.classList.remove('active'));
    link.classList.add('active');
  });
});
incidentArea.addEventListener('click', handleIncidentAction);
incidentArea.addEventListener('submit', handleIncidentSubmit);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    if (!contentType.includes('json')) {
      if (response.status === 502 || response.status === 503) {
        throw new Error(`The API service is unavailable (${response.status}). Wait a minute and retry; check the backend deployment if it continues.`);
      }
      throw new Error(`The API returned a webpage instead of JSON (${response.status}). Check the Vercel API rewrite and backend status.`);
    }
    const detail = data && typeof data === 'object' ? data.detail : data;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  if (typeof data === 'string') {
    throw new Error('The API returned a webpage instead of incident data. Check the Vercel API rewrite and backend status.');
  }
  return data;
}

function jsonBody(value) { return { method: 'POST', body: JSON.stringify(value) }; }

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function setBusy(busy) {
  state.busy = busy;
  renderIncident();
  renderRecentIncidents();
  renderOverview();
}

async function perform(action, successMessage) {
  if (state.busy) return;
  state.error = '';
  setBusy(true);
  try {
    await action();
    if (successMessage) showToast(successMessage);
  } catch (error) {
    state.error = error.message || 'Something went wrong while contacting the API.';
    showToast(state.error);
  } finally {
    state.busy = false;
    renderIncident();
  }
}

async function startDemo() {
  if (state.busy) return;
  state.error = '';
  state.manualCheckFormOpen = false;
  setBusy(true);
  document.querySelector('#welcome-banner').classList.add('hidden');
  incidentArea.classList.remove('hidden');
  try {
    state.incident = await api('/api/incidents', jsonBody({
      title: 'Checkout errors are increasing',
      service: 'demo-checkout',
      severity: 'high',
      description: 'Checkout health checks began returning HTTP 500 after a payment timeout configuration change.',
      symptoms: ['HTTP 500 responses', 'Checkout health check failing'],
      source: 'seeded-demo',
    }));
    state.evidence = await api(`/api/incidents/${state.incident.id}/evidence/collect-demo`, { method: 'POST' });
    state.analysis = await api(`/api/incidents/${state.incident.id}/analyze`, { method: 'POST' });
    state.githubContext = null;
    state.approvals = [];
    state.verifications = [];
    state.statusHistory = [];
    state.approvalFormOpen = false;
    state.report = null;
    await loadRecentIncidents();
    showToast('Demo incident created and analyzed. Review the evidence below.');
  } catch (error) {
    state.error = error.message || 'Could not start the demo incident.';
    showToast(state.error);
  } finally {
    state.busy = false;
    renderIncident();
    incidentArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function submitProblem(event) {
  event.preventDefault();
  if (state.busy) return;

  const form = event.currentTarget;
  const values = new FormData(form);
  const title = String(values.get('title') || '').trim();
  const service = String(values.get('service') || '').trim();
  const description = String(values.get('description') || '').trim();
  const symptoms = String(values.get('symptoms') || '')
    .split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 30);

  if (!title || !service || !description) {
    form.reportValidity();
    return;
  }

  state.incident = null;
  state.evidence = [];
  state.analysis = null;
  state.approvals = [];
  state.verifications = [];
  state.statusHistory = [];
  state.approvalFormOpen = false;
  state.report = null;
  state.error = '';
  state.manualCheckFormOpen = false;
  setBusy(true);
  try {
    state.incident = await api('/api/incidents', jsonBody({
      title,
      service,
      severity: values.get('severity'),
      description,
      symptoms,
      source: 'user-reported',
    }));

    await api(`/api/incidents/${state.incident.id}/evidence`, jsonBody({
      source: 'user report',
      observation: description,
      details: { kind: 'description' },
    }));
    for (const symptom of symptoms) {
      await api(`/api/incidents/${state.incident.id}/evidence`, jsonBody({
        source: 'reported symptom',
        observation: symptom,
        details: { kind: 'symptom' },
      }));
    }

    state.evidence = await api(`/api/incidents/${state.incident.id}/evidence`);
    state.analysis = await api(`/api/incidents/${state.incident.id}/analyze`, { method: 'POST' });
    state.githubContext = null;
    state.report = await api(`/api/incidents/${state.incident.id}/report`);
    state.approvals = state.report.approvals || [];
    state.verifications = state.report.verifications || [];
    form.reset();
    document.querySelector('#report-problem-panel').classList.add('hidden');
    document.querySelector('#welcome-banner').classList.add('hidden');
    incidentArea.classList.remove('hidden');
    await loadRecentIncidents();
    showToast('Problem saved and analyzed. Review the suggested solution below.');
  } catch (error) {
    state.error = error.message || 'Could not save and analyze this problem.';
    showToast(state.error);
  } finally {
    state.busy = false;
    renderIncident();
    if (state.incident) incidentArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function restoreLatestIncident() {
  if (state.busy) return;
  await perform(async () => {
    const incidents = await api('/api/incidents');
    if (!incidents.length) {
      state.incident = null;
      state.evidence = [];
      state.analysis = null;
      state.approvals = [];
      state.verifications = [];
      state.statusHistory = [];
      state.approvalFormOpen = false;
      state.report = null;
      document.querySelector('#welcome-banner').classList.remove('hidden');
      incidentArea.classList.add('hidden');
      showToast('No incidents found yet. Start the demo walkthrough.');
      return;
    }
    await loadIncidentDetails(incidents[0]);
    document.querySelector('#welcome-banner').classList.add('hidden');
    incidentArea.classList.remove('hidden');
  }, 'Latest incident refreshed.');
}

async function loadIncidentDetails(incident) {
  const report = await api(`/api/incidents/${incident.id}/report`);
  state.report = report;
  state.incident = report.incident || incident;
  state.evidence = state.report.evidence || [];
  state.analysis = state.report.analysis;
  state.githubContext = null;
  state.approvals = state.report.approvals || [];
  state.verifications = state.report.verifications || [];
  state.statusHistory = await api(`/api/incidents/${incident.id}/status-history`);
  state.approvalFormOpen = false;
  state.error = '';
  document.querySelector('#welcome-banner').classList.add('hidden');
  incidentArea.classList.remove('hidden');
  renderIncident();
}

async function loadRecentIncidents(showMessage = false) {
  try {
    state.incidents = await api('/api/incidents');
    renderRecentIncidents();
    renderOverview();
    await loadAnalytics();
    if (showMessage) showToast(`${state.incidents.length} incident${state.incidents.length === 1 ? '' : 's'} found.`);
  } catch (error) {
    if (showMessage) showToast(error.message || 'Could not load recent incidents.');
  }
}

async function loadAnalytics() {
  const days = Number(document.querySelector('#analytics-window').value || 30);
  const message = document.querySelector('#analytics-message');
  message.textContent = '';
  try {
    state.analytics = await api(`/api/analytics/overview?days=${days}`);
    renderAnalytics();
  } catch (error) {
    state.analytics = null;
    message.textContent = `Analytics could not be loaded. ${error.message || 'Check the backend connection and retry.'}`;
    document.querySelector('#analytics-kpis').innerHTML = '<div class="analytics-empty">No metrics available.</div>';
    document.querySelector('#analytics-trend').innerHTML = '';
    document.querySelector('#analytics-severity').innerHTML = '';
    document.querySelector('#analytics-services').innerHTML = '';
  }
}

function renderAnalytics() {
  const data = state.analytics;
  if (!data) return;
  const meanTime = data.mean_resolution_hours == null
    ? '—'
    : formatDuration(data.mean_resolution_hours);
  const metrics = [
    ['<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6M9 15h6"/>', data.created_count, `New in ${data.window_days} days`, 'is-indigo'],
    ['<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', data.active_count, 'Active now', 'is-amber'],
    ['<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>', data.resolved_count, 'Resolutions in period', 'is-green'],
    ['<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>', meanTime, 'Mean time to resolve', 'is-blue'],
  ];
  document.querySelector('#analytics-kpis').innerHTML = metrics.map(([icon, value, label, tone]) => `
    <article class="analytics-kpi ${tone}"><span class="analytics-kpi-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></span><div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div></article>`).join('');

  const points = data.daily_incidents || [];
  const maxCount = Math.max(1, ...points.map((point) => point.count));
  const labelEvery = Math.max(1, Math.ceil(points.length / 7));
  document.querySelector('#analytics-window-total').textContent = `${data.created_count} total`;
  document.querySelector('#analytics-trend').innerHTML = points.length
    ? `<div class="trend-chart" style="grid-template-columns:repeat(${points.length},minmax(0,1fr))">${points.map((point, index) => {
      const height = point.count ? Math.max(6, Math.round((point.count / maxCount) * 100)) : 2;
      const showLabel = index % labelEvery === 0 || index === points.length - 1;
      return `<div class="trend-day" title="${escapeHtml(point.date)} · ${point.count} incident${point.count === 1 ? '' : 's'}"><div class="trend-track"><i style="height:${height}%"></i></div><small>${showLabel ? escapeHtml(point.date.slice(5)) : ''}</small></div>`;
    }).join('')}</div>`
    : '<div class="analytics-empty">No incidents in this period.</div>';

  const severityOrder = ['critical', 'high', 'medium', 'low'];
  const severityTotal = severityOrder.reduce((sum, severity) => sum + (data.severity_counts?.[severity] || 0), 0);
  document.querySelector('#analytics-severity').innerHTML = severityTotal
    ? severityOrder.map((severity) => {
      const count = data.severity_counts[severity] || 0;
      const width = Math.round((count / severityTotal) * 100);
      return `<div class="breakdown-row"><span class="breakdown-label"><i class="severity-dot severity-${severity}"></i>${severity}</span><span class="breakdown-track"><i class="severity-fill severity-${severity}" style="width:${width}%"></i></span><strong>${count}</strong></div>`;
    }).join('')
    : '<div class="analytics-empty">No severity data in this period.</div>';

  const services = data.top_services || [];
  const topServiceCount = Math.max(1, ...services.map((item) => item.count));
  document.querySelector('#analytics-services').innerHTML = services.length
    ? services.map((item, index) => `<div class="breakdown-row service-breakdown-row"><span class="breakdown-label">${escapeHtml(item.service)}</span><span class="breakdown-track"><i class="service-fill" style="width:${Math.round((item.count / topServiceCount) * 100)}%"></i></span><strong>${item.count}</strong></div>`).join('')
    : '<div class="analytics-empty">No affected services to show.</div>';
}

function formatDuration(hours) {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${hours.toFixed(1)} hr`;
  return `${(hours / 24).toFixed(1)} days`;
}

function incidentListStatus(incident) {
  const tone = incident.status === 'resolved' || incident.status === 'closed' ? 'is-good' : 'is-warn';
  return [incident.status || 'open', tone];
}

function renderOverview() {
  const currentVerification = state.verifications.at(-1);
  const verified = state.incidents.filter((incident) => incident.id === state.incident?.id && currentVerification?.status === 'passed').length;
  const evidenceCount = state.incident ? state.evidence.length : 0;
  const reviewCount = state.incident && !state.approvals.length ? 1 : 0;
  overviewStats.innerHTML = `
    <div class="overview-stat"><span class="overview-stat-icon">◉</span><div><strong>${state.incidents.length}</strong><span>Tracked incidents</span></div></div>
    <div class="overview-stat"><span class="overview-stat-icon is-green">E</span><div><strong>${evidenceCount}</strong><span>Evidence in focus</span></div></div>
    <div class="overview-stat"><span class="overview-stat-icon is-amber">!</span><div><strong>${reviewCount}</strong><span>Awaiting review</span></div></div>
    <div class="overview-stat"><span class="overview-stat-icon is-blue">✓</span><div><strong>${verified}</strong><span>Verified in focus</span></div></div>`;
}

function renderRecentIncidents() {
  recentIncidentsPanel.classList.remove('hidden');
  if (!state.incidents.length) {
    recentIncidentsList.innerHTML = '<div class="empty-inline">No incidents yet. Start the demo or report a problem to build your incident history.</div>';
    return;
  }
  const filtered = state.incidents.filter((incident) => {
    const matchesQuery = !state.incidentQuery
      || `${incident.title} ${incident.service}`.toLowerCase().includes(state.incidentQuery);
    const matchesSeverity = state.severityFilter === 'all' || incident.severity === state.severityFilter;
    const matchesStatus = state.statusFilter === 'all' || incident.status === state.statusFilter;
    return matchesQuery && matchesSeverity && matchesStatus;
  });
  if (!filtered.length) {
    recentIncidentsList.innerHTML = '<div class="empty-inline">No incidents match these filters.</div>';
    return;
  }
  const visibleIncidents = state.showAllIncidents ? filtered : filtered.slice(0, 3);
  const toggleLabel = state.showAllIncidents ? 'Show recent 3' : `Show all ${filtered.length} incidents`;
  const toggleButton = filtered.length > 3
    ? `<button class="button button-quiet incident-list-toggle" type="button" data-action="toggle-incidents" aria-expanded="${state.showAllIncidents}">${toggleLabel}</button>`
    : '';
  recentIncidentsList.innerHTML = `<div class="recent-incidents-list">${visibleIncidents.map((incident) => {
    const [label, tone] = incidentListStatus(incident);
    const selected = state.incident?.id === incident.id;
    const monitoringSource = incident.source === 'webhook:prometheus-alertmanager' ? ' · Monitoring alert' : '';
    return `<button class="recent-incident ${selected ? 'is-selected' : ''}" type="button" data-incident-id="${escapeHtml(incident.id)}" ${state.busy ? 'disabled' : ''}><span class="recent-incident-main"><strong>${escapeHtml(incident.title)}</strong><span>${escapeHtml(incident.service)}${monitoringSource} · Updated ${formatTime(incident.updated_at || incident.created_at)}</span></span><span class="recent-incident-meta"><span class="status-pill severity-${escapeHtml(incident.severity)}">${escapeHtml(incident.severity)}</span><span class="status-pill ${tone}">${escapeHtml(label)}</span></span></button>`;
  }).join('')}</div>${toggleButton}`;
}

function handleRecentIncidentAction(event) {
  const toggle = event.target.closest('[data-action="toggle-incidents"]');
  if (toggle) {
    state.showAllIncidents = !state.showAllIncidents;
    renderRecentIncidents();
    return;
  }
  const button = event.target.closest('[data-incident-id]');
  if (!button || state.busy) return;
  const incident = state.incidents.find((item) => item.id === button.dataset.incidentId);
  if (!incident) return;
  perform(async () => {
    await loadIncidentDetails(incident);
    incidentArea.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 'Incident loaded.');
}

function handleIncidentAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button || state.busy) return;
  if (button.dataset.action === 'analyze') {
    perform(async () => {
      state.evidence = await api(`/api/incidents/${state.incident.id}/evidence`);
      state.analysis = await api(`/api/incidents/${state.incident.id}/analyze`, { method: 'POST' });
      state.githubContext = null;
      state.report = null;
    }, 'Evidence analyzed.');
  } else if (button.dataset.action === 'collect') {
    perform(async () => {
      state.evidence = await api(`/api/incidents/${state.incident.id}/evidence/collect-demo`, { method: 'POST' });
      state.analysis = await api(`/api/incidents/${state.incident.id}/analyze`, { method: 'POST' });
      state.githubContext = null;
      state.report = null;
    }, 'Demo evidence refreshed and analyzed.');
  } else if (button.dataset.action === 'report') {
    perform(async () => {
      state.report = await api(`/api/incidents/${state.incident.id}/report`);
    }, 'Incident report updated.');
  } else if (button.dataset.action === 'refresh-changes') {
    const incident = state.incident;
    const approvalFormOpen = state.approvalFormOpen;
    const manualCheckFormOpen = state.manualCheckFormOpen;
    perform(async () => {
      await loadIncidentDetails(incident);
      state.approvalFormOpen = approvalFormOpen;
      state.manualCheckFormOpen = manualCheckFormOpen;
      state.incidents = await api('/api/incidents');
      renderRecentIncidents();
    }, 'Incident activity refreshed.');
  } else if (button.dataset.action === 'copy-github-issue') {
    perform(async () => {
      await navigator.clipboard.writeText(buildGithubIssueMarkdown());
    }, 'GitHub issue Markdown copied to your clipboard.');
  } else if (button.dataset.action === 'open-github-issue') {
    const title = `Incident: ${state.incident.title}`;
    const url = `https://github.com/${GITHUB_REPOSITORY}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(buildGithubIssueMarkdown())}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  } else if (button.dataset.action === 'download-report') {
    downloadIncidentReport();
  } else if (button.dataset.action === 'incident-status') {
    const targetStatus = button.dataset.status;
    perform(async () => {
      state.incident = await api(`/api/incidents/${state.incident.id}/status`, jsonBody({ status: targetStatus }));
      state.incidents = await api('/api/incidents');
      state.report = await api(`/api/incidents/${state.incident.id}/report`);
      state.statusHistory = await api(`/api/incidents/${state.incident.id}/status-history`);
    }, targetStatus === 'investigating'
      ? 'Incident moved to investigation.'
      : targetStatus === 'resolved'
        ? 'Incident resolved and added to its history.'
        : targetStatus === 'closed'
          ? 'Incident closed.'
          : 'Incident reopened for investigation.');
  } else if (button.dataset.action === 'reopen-approval') {
    state.approvalFormOpen = true;
    renderIncident();
    incidentArea.querySelector('#approver')?.focus();
  } else if (button.dataset.action === 'cancel-approval') {
    state.approvalFormOpen = false;
    renderIncident();
  } else if (button.dataset.action === 'new-service-check') {
    state.manualCheckFormOpen = true;
    renderIncident();
    incidentArea.querySelector('#service-check-name')?.focus();
  } else if (button.dataset.action === 'verify') {
    const form = incidentArea.querySelector('#verify-form');
    const values = new FormData(form);
    const setting = values.get('application_setting_name');
    const configured = values.get('configured_setting_name');
    const timeout = Number(values.get('timeout_value'));
    perform(async () => {
      const verification = await api(`/api/incidents/${state.incident.id}/verify`, jsonBody({
        application_setting_name: setting,
        configured_setting_names: [configured],
        timeout_value: timeout,
      }));
      state.verifications = [...state.verifications, verification];
      state.report = await api(`/api/incidents/${state.incident.id}/report`);
    }, 'Sandbox verification recorded.');
  }
}

function handleIncidentSubmit(event) {
  const form = event.target;
  if (form.id === 'service-check-form') {
    event.preventDefault();
    if (state.busy) return;
    const values = new FormData(form);
    const checkName = String(values.get('check_name') || '').trim();
    const outcome = String(values.get('outcome') || '');
    const note = String(values.get('note') || '').trim();
    if (!checkName || !['passed', 'failed'].includes(outcome)) {
      form.reportValidity();
      return;
    }
    perform(async () => {
      const record = await api(`/api/incidents/${state.incident.id}/service-check`, jsonBody({
        check_name: checkName,
        outcome,
        note,
      }));
      state.verifications = [...state.verifications, record];
      state.manualCheckFormOpen = false;
      state.report = await api(`/api/incidents/${state.incident.id}/report`);
    }, 'Service check recorded.');
    return;
  }
  if (form.id !== 'approval-form') return;
  event.preventDefault();
  if (state.busy) return;
  const values = new FormData(form);
  const decision = event.submitter?.value || values.get('decision');
  const approver = String(values.get('approver') || '').trim();
  const note = String(values.get('note') || '').trim();
  if (!approver) {
    form.querySelector('[name="approver"]').focus();
    showToast('Enter the name of the person reviewing this fix.');
    return;
  }
  perform(async () => {
    const record = await api(`/api/incidents/${state.incident.id}/approvals`, jsonBody({ decision, approver, note }));
    state.approvals = [...state.approvals, record];
    state.approvalFormOpen = false;
    state.report = await api(`/api/incidents/${state.incident.id}/report`);
  }, decision === 'approved' ? 'Approval recorded. You can now verify the proposal.' : 'Rejection recorded. Verification remains locked.');
}

function currentStage() {
  if (!state.evidence.length) return 0;
  if (!state.analysis) return 1;
  const decision = state.approvals.at(-1)?.decision;
  if (decision === 'rejected') return 2;
  if (decision !== 'approved') return 2;
  if (!hasCurrentApproval()) return 2;
  return hasCurrentVerification() ? 4 : 3;
}

function latestInvestigationStartedAt() {
  const event = [...state.statusHistory].reverse().find((item) => item.to_status === 'investigating');
  return event ? Date.parse(event.occurred_at) : 0;
}

function hasCurrentReview() {
  const approval = state.approvals.at(-1);
  return Boolean(approval) && Date.parse(approval.recorded_at) > latestInvestigationStartedAt();
}

function hasCurrentApproval() {
  return state.approvals.at(-1)?.decision === 'approved' && hasCurrentReview();
}

function hasCurrentVerification() {
  const approval = state.approvals.at(-1);
  const verification = state.verifications.at(-1);
  return hasCurrentApproval()
    && Boolean(verification)
    && Date.parse(verification.checked_at) > Date.parse(approval.recorded_at)
    && Date.parse(verification.checked_at) > latestInvestigationStartedAt();
}

function statusLabel() {
  if (state.incident?.status === 'resolved') return ['Resolved', 'is-good'];
  if (state.incident?.status === 'closed') return ['Closed', 'is-good'];
  const latestStatus = state.statusHistory.at(-1);
  if (state.approvals.at(-1)?.decision === 'rejected') return ['Rejected by reviewer', 'is-bad'];
  if (state.incident?.status === 'investigating' && latestStatus?.to_status === 'investigating' && !hasCurrentReview()) {
    return ['Awaiting fresh human review', 'is-warn'];
  }
  if (!state.evidence.length) return ['Evidence needed', 'is-warn'];
  if (!state.analysis) return ['Ready to analyze', 'is-warn'];
  const decision = state.approvals.at(-1)?.decision;
  if (!hasCurrentApproval()) return ['Awaiting human review', 'is-warn'];
  if (!decision) return ['Awaiting human review', 'is-warn'];
  const verification = state.verifications.at(-1);
  if (!hasCurrentVerification()) return ['Approved · Check pending', 'is-warn'];
  if (state.incident.source !== 'seeded-demo') {
    if (!verification) return ['Approved · Check pending', 'is-warn'];
    return verification.status === 'passed'
      ? ['Check recorded · Passed', 'is-good']
      : ['Check recorded · Failed', 'is-bad'];
  }
  if (!verification) return ['Approved · Ready to verify', 'is-good'];
  return verification.status === 'passed' ? ['Verified · Passed', 'is-good'] : ['Verification failed', 'is-bad'];
}

function stepperMarkup() {
  const active = currentStage();
  const labels = ['Evidence', 'Analysis', 'Human review', state.incident.source === 'seeded-demo' ? 'Verification' : 'Service check'];
  return `<div class="stepper" aria-label="Incident workflow progress">${labels.map((label, index) => {
    const failed = index === 3 && state.verifications.at(-1)?.status === 'failed';
    const done = index < active || (index === 3 && state.verifications.length > 0 && !failed);
    const current = index === active && !done && !failed;
    return `<div class="step ${done ? 'done' : ''} ${current ? 'current' : ''} ${failed ? 'failed' : ''}"><span class="step-bubble">${failed ? '×' : done ? '✓' : index + 1}</span><span>${label}</span></div>`;
  }).join('')}</div>`;
}

function isChangeEvidence(item) {
  const source = String(item.source || '').toLowerCase();
  return source === 'recent change' || source.startsWith('github ');
}

function evidenceItemMarkup(item, index) {
  const symbols = { 'health check': '⌁', 'application log': '≡', 'recent change': '↻', 'github push': '↑', 'github deployment': '↗', 'github merged pull request': '⑂' };
  const change = item.details?.github_event_id ? item.details : null;
  const isDemoSample = state.incident?.source === 'seeded-demo'
    && item.source?.toLowerCase() === 'recent change'
    && !change;
  const changeParts = [];
  if (change?.branch) changeParts.push(`Branch ${change.branch}`);
  if (change?.base_branch) changeParts.push(`Merged into ${change.base_branch}`);
  if (change?.environment) changeParts.push(`Environment ${change.environment}`);
  if (change?.state) changeParts.push(`Deployment ${change.state}`);
  if (change?.number) changeParts.push(`PR #${change.number}`);
  if (change?.commit) changeParts.push(`Commit ${String(change.commit).slice(0, 8)}`);
  if (change?.actor) changeParts.push(`By ${change.actor}`);
  const changeLink = safeExternalUrl(change?.url);
  const changeMarkup = change ? `<div class="evidence-change-meta">${changeParts.map(escapeHtml).join(' · ')}${changeLink ? `${changeParts.length ? ' · ' : ''}<a href="${escapeHtml(changeLink)}" target="_blank" rel="noopener noreferrer">View change ↗</a>` : ''}</div>` : '';
  const time = change?.occurred_at || item.collected_at;
  return `<article class="evidence-item" id="evidence-${escapeHtml(item.id)}"><span class="evidence-symbol">${symbols[item.source?.toLowerCase()] || '•'}</span><div><strong><span class="evidence-id">E${index + 1}</span>${escapeHtml(item.source)}${isDemoSample ? '<span class="evidence-sample-badge">DEMO SAMPLE</span>' : ''}</strong><p>${escapeHtml(item.observation)}</p>${changeMarkup}</div><span class="evidence-time">${time ? `${change ? 'Change' : ''}${change ? '<br>' : ''}${formatTime(time)}` : 'Demo source'}</span></article>`;
}

function evidenceMarkup() {
  const evidence = state.evidence.map((item, index) => ({ item, index })).filter(({ item }) => !isChangeEvidence(item));
  if (!evidence.length) return '<div class="empty-inline">No service, monitoring, or application-log evidence has been collected yet.</div>';
  return `<div class="evidence-list">${evidence.map(({ item, index }) => evidenceItemMarkup(item, index)).join('')}</div>`;
}

function recentChangesMarkup() {
  const changes = state.evidence.map((item, index) => ({ item, index })).filter(({ item }) => isChangeEvidence(item));
  const githubChanges = changes.filter(({ item }) => Boolean(item.details?.github_event_id));
  const hasDemoSample = changes.some(({ item }) => state.incident?.source === 'seeded-demo'
    && item.source?.toLowerCase() === 'recent change'
    && !item.details?.github_event_id);
  const setupTitle = hasDemoSample ? 'Sample event from the demo' : changes.length ? 'No live GitHub activity matched yet' : 'No recent change evidence matched this incident';
  const setupText = hasDemoSample
    ? 'This example shows how a related code change appears beside an incident. Live GitHub events can be connected optionally.'
    : 'After setup, matching pushes, merged pull requests, and completed deployments appear here automatically. ProofPatch checks the hour before the incident and later changes while it remains active.';
  const setup = `<div class="github-connection-note"><strong>${setupTitle}</strong><p>${setupText}</p><details class="changes-setup"><summary>Connect GitHub</summary><ol><li>Set <code>PROOFPATCH_GITHUB_WEBHOOK_SECRET</code> in the backend environment and use the same secret in GitHub.</li><li>Map the repository to this service with <code>PROOFPATCH_GITHUB_SERVICES=owner/repository=${escapeHtml(state.incident?.service || 'your-service')}</code>.</li><li>Add a repository webhook at your backend URL plus <code>/api/webhooks/github</code>. Choose JSON and subscribe to Pushes, Pull requests, and Deployments.</li></ol><a href="https://github.com/${GITHUB_REPOSITORY}/settings/hooks/new" target="_blank" rel="noopener noreferrer">Open repository webhook settings ↗</a></details></div>`;
  if (!changes.length) return `<div class="changes-empty"><span class="changes-empty-icon" aria-hidden="true">↗</span><p>Matching change activity will appear here once it is received.</p></div>${setup}`;
  return `<div class="evidence-list recent-change-list">${changes.map(({ item, index }) => evidenceItemMarkup(item, index)).join('')}</div>${githubChanges.length ? '<p class="change-correlation-note">Matched by service and timing. These changes are clues for review, not proof of cause.</p>' : setup}`;
}

function analysisMarkup() {
  if (!state.analysis) return `<div class="empty-inline">${state.busy ? 'Analyzing the incident…' : 'Collect evidence, then analyze this incident.'}</div><button class="button button-secondary" data-action="analyze" ${state.busy || !state.evidence.length ? 'disabled' : ''}>Analyze evidence</button>`;
  const finding = state.analysis.root_cause || {};
  const ai = state.analysis.ai_analysis;
  const supported = new Set(finding.supporting_evidence_ids || []);
  const evidenceLinks = state.evidence
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => supported.has(item.id))
    .map(({ item, index }) => `<a class="source-link" href="#evidence-${escapeHtml(item.id)}" aria-label="View evidence E${index + 1}: ${escapeHtml(item.source)}">E${index + 1} · ${escapeHtml(item.source)}</a>`)
    .join(' · ');
  const supportingEvidence = evidenceLinks
    ? `<div class="supporting-evidence"><strong>Why this conclusion?</strong><p>These evidence items support the root-cause finding:</p><div class="supporting-evidence-links">${evidenceLinks}</div></div>`
    : '';
  const recs = (state.analysis.recommendations || []).map((item, index) => `<div class="recommendation"><div class="recommendation-top"><strong>Recommendation ${index + 1}</strong><span class="risk ${escapeHtml(item.risk)}">${escapeHtml(item.risk)} risk</span></div><p>${escapeHtml(item.action)}</p><p style="margin-top:5px">${escapeHtml(item.rationale)}</p></div>`).join('');
  const hasAiAnalysis = ai?.provider === 'ai';
  const aiMarkup = hasAiAnalysis
    ? `<div class="ai-enrichment"><div class="ai-enrichment-heading"><span class="ai-badge">✦ AI analysis</span></div><h4>${escapeHtml(ai.summary)}</h4><p>${escapeHtml(ai.likely_cause)}</p><div class="ai-fix"><strong>Suggested solution</strong><p>${escapeHtml(ai.recommended_fix)}</p></div><div class="ai-meta"><span>${Math.round(Number(ai.confidence || 0) * 100)}% confidence</span></div><details><summary>View verification plan and unknowns</summary><ul>${(ai.verification_plan || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul><p>${escapeHtml((ai.unknowns || []).join(' '))}</p></details></div>`
    : '';
  return `<div class="analysis-pair ${hasAiAnalysis ? '' : 'single'}"><div class="analysis-box"><div class="analysis-top"><span class="confidence">${escapeHtml(finding.confidence || 'unknown')} confidence</span><span class="analysis-state">${finding.status === 'likely' ? 'Evidence supports this finding' : 'More evidence needed'}</span></div><h4>${escapeHtml(finding.summary || 'No root cause returned.')}</h4><ul class="rationale-list">${(finding.rationale || []).map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>${supportingEvidence}</div>${aiMarkup}</div><div class="recommendation-section"><div class="surface-heading"><div><h3>Suggested actions</h3></div><span class="subtle-count">Human approval required</span></div>${recs || '<div class="empty-inline">No recommendations returned.</div>'}</div>`;
}

function approvalMarkup() {
  const decision = state.approvals.at(-1);
  const needsFreshReview = state.incident.status === 'investigating'
    && state.statusHistory.at(-1)?.to_status === 'investigating'
    && !hasCurrentReview();
  if (decision && !state.approvalFormOpen && !needsFreshReview) {
    const rejected = decision.decision === 'rejected';
    const anotherReview = state.incident.status === 'investigating'
      ? '<button class="button button-secondary" type="button" data-action="reopen-approval">Record another review</button>'
      : '';
    return `<div class="decision-record"><strong>${rejected ? 'Rejected' : 'Approved'} by ${escapeHtml(decision.approver)}</strong>${escapeHtml(decision.note || 'No note added.')}${rejected ? '<p class="disabled-explanation">Verification is unavailable until a reviewer records a new approval.</p>' : ''}</div>${anotherReview}`;
  }
  const priorDecision = decision
    ? `<div class="decision-record"><strong>Previous decision: ${decision.decision === 'approved' ? 'Approved' : 'Rejected'} by ${escapeHtml(decision.approver)}</strong>${escapeHtml(decision.note || 'No note added.')}</div>`
    : '';
  const freshReviewMessage = needsFreshReview
    ? '<p class="approval-note">Review this proposal again after starting or reopening the investigation. A new check will be required before resolution.</p>'
    : '';
  const cancel = decision && !needsFreshReview ? '<button class="button button-secondary" type="button" data-action="cancel-approval">Cancel</button>' : '';
  return `${priorDecision}${freshReviewMessage}<form id="approval-form"><div class="approval-form"><div class="field full"><label for="approver">Reviewer name</label><input id="approver" name="approver" placeholder="Who is reviewing this?" maxlength="120" required /></div><div class="field full"><label for="approval-note">Decision note <span style="font-weight:400;color:#9aa39b">(optional)</span></label><textarea id="approval-note" name="note" maxlength="1000" placeholder="Reason for your decision"></textarea></div></div><div class="approval-actions">${cancel}<button class="button button-approve" name="decision" value="approved" ${state.busy || !state.analysis ? 'disabled' : ''}>Approve proposal</button><button class="button button-reject" name="decision" value="rejected" ${state.busy || !state.analysis ? 'disabled' : ''}>Reject</button></div><p class="approval-note">This records your decision. No changes are applied automatically.</p></form>`;
}

function verificationMarkup() {
  if (state.incident.source !== 'seeded-demo') {
    const decision = state.approvals.at(-1)?.decision;
    const latest = state.verifications.at(-1);
    const previousResult = latest
      ? `<div class="decision-record manual-check-result"><strong>${latest.status === 'passed' ? '✓ Check recorded as passed' : '× Check recorded as failed'}</strong><span>${escapeHtml(latest.check_name || 'Project check')}</span>${latest.note ? `<p>${escapeHtml(latest.note)}</p>` : ''}<time>${formatTime(latest.checked_at)}</time></div>`
      : '';
    if (!hasCurrentApproval()) {
      const message = decision === 'rejected'
        ? 'The proposal was rejected. A new approval is required before recording a service check.'
        : decision === 'approved'
          ? 'Record a fresh human review after starting or reopening the investigation.'
          : 'Approve the proposal above before recording a service check.';
      return `${previousResult}<div class="empty-inline">${message}</div>`;
    }
    const form = !latest || state.manualCheckFormOpen
      ? `<form id="service-check-form" class="service-check-form"><div class="field"><label for="service-check-name">Check performed</label><input id="service-check-name" name="check_name" maxlength="120" placeholder="e.g. GET /health or checkout test" required /></div><div class="field"><label for="service-check-outcome">Result</label><select id="service-check-outcome" name="outcome" required><option value="" selected disabled>Choose result</option><option value="passed">Passed</option><option value="failed">Failed</option></select></div><div class="field full"><label for="service-check-note">Result note <span style="font-weight:400;color:#9aa39b">(optional)</span></label><textarea id="service-check-note" name="note" maxlength="1000" rows="2" placeholder="What did the check show?"></textarea></div><button class="button button-primary" type="submit" ${state.busy ? 'disabled' : ''}>Record service check</button></form>`
      : `<button class="button button-secondary" type="button" data-action="new-service-check">Record another check</button>`;
    return `<p class="service-check-guidance">Run a project-specific test or health check yourself, then record its result here. ProofPatch does not execute the check.</p>${previousResult}${form}`;
  }
  const latest = state.verifications.at(-1);
  const decision = state.approvals.at(-1)?.decision;
  if (latest) {
    const canRunAgain = hasCurrentApproval();
    const freshReviewHint = canRunAgain ? '' : '<p class="approval-note">Record an approved review for this investigation before running another check.</p>';
    return `<div class="decision-record"><strong>${latest.status === 'passed' ? '✓ Checks passed' : '× Checks failed'}</strong>${escapeHtml(latest.summary)}<div class="verification-checks">${(latest.checks || []).map((check) => `<div class="check-row"><span class="check-icon ${check.passed ? '' : 'fail'}">${check.passed ? '✓' : '×'}</span><div><strong>${escapeHtml(check.name.replaceAll('_', ' '))}</strong><p>${escapeHtml(check.details)}</p></div></div>`).join('')}</div></div>${freshReviewHint}<button class="button button-secondary" data-action="verify" style="margin-top:10px" ${state.busy || !canRunAgain ? 'disabled' : ''}>Run checks again</button>`;
  }
  if (!hasCurrentApproval()) return `<div class="empty-inline">${decision === 'rejected' ? 'The proposal was rejected. Verification is locked.' : decision === 'approved' ? 'Record a fresh human review after starting or reopening the investigation.' : 'Approve the proposal above to unlock sandbox verification.'}</div>`;
  return `<form id="verify-form" class="verify-form"><p class="approval-note" style="margin-top:0">Choose the setting used by the demo service and the setting present in its proposed configuration. A mismatch produces a recorded failure.</p><div class="field"><label for="application-setting">Application reads</label><select id="application-setting" name="application_setting_name"><option>PAYMENT_TIMEOUT_MS</option><option>PAYMENT_TIMEOUT</option></select></div><div class="field"><label for="configured-setting">Proposed config contains</label><select id="configured-setting" name="configured_setting_name"><option>PAYMENT_TIMEOUT_MS</option><option>PAYMENT_TIMEOUT</option></select></div><div class="field"><label for="timeout-value">Timeout value (milliseconds)</label><input id="timeout-value" name="timeout_value" type="number" value="30000" step="1" required /></div><button type="button" class="button button-primary" data-action="verify" ${state.busy ? 'disabled' : ''}>Run deterministic checks</button><p class="approval-note">Checks: supported setting, setting present in config, positive timeout.</p></form>`;
}

function timelineMarkup() {
  const events = [...(state.report?.timeline || [])];
  if (!events.length) return '<div class="empty-inline">Load the incident report to see its event timeline.</div>';
  const labels = {
    incident_created: 'Incident reported',
    evidence_collected: 'Evidence collected',
    github_change_recorded: 'GitHub change recorded',
    analysis_completed: 'Analysis completed',
    approval_recorded: 'Human decision recorded',
    verification_completed: 'Verification completed',
    service_check_recorded: 'Service check recorded',
    incident_status_changed: 'Incident status updated',
  };
  const icons = {
    incident_created: '!',
    evidence_collected: 'E',
    github_change_recorded: '↗',
    analysis_completed: '?',
    approval_recorded: '✓',
    verification_completed: '✓',
    service_check_recorded: '✓',
    incident_status_changed: '↻',
  };
  return `<ol class="timeline">${events.map((event) => {
    const kind = event.kind || 'event';
    return `<li class="timeline-event-${escapeHtml(kind)}"><span class="timeline-dot">${escapeHtml(icons[kind] || '•')}</span><div><strong>${escapeHtml(labels[kind] || kind.replaceAll('_', ' '))}</strong><p>${escapeHtml(event.summary)}</p><time>${formatTime(event.occurred_at)}</time></div></li>`;
  }).join('')}</ol>`;
}

function buildGithubIssueMarkdown() {
  const incident = state.incident;
  const finding = state.analysis?.root_cause;
  const recommendation = state.analysis?.recommendations?.[0];
  const decision = state.approvals.at(-1);
  const verification = state.verifications.at(-1);
  const evidence = state.evidence
    .map((item, index) => `- E${index + 1}: ${item.source} — ${item.observation}`)
    .join('\n');
  return `## Incident: ${incident.title}\n\n**Service:** ${incident.service}\n**Severity:** ${incident.severity}\n**Status:** ${incident.status || 'open'}\n\n## Root cause\n${finding?.summary || 'Analysis is not available yet.'}\n\n## Evidence\n${evidence || '- No evidence collected yet.'}\n\n## Recommended fix\n${recommendation?.action || 'No recommendation is available yet.'}\n\n## Human approval\n${decision ? `${decision.decision === 'approved' ? 'Approved' : 'Rejected'} by ${decision.approver}${decision.note ? ` — ${decision.note}` : ''}` : 'Pending review'}\n\n## Verification\n${verification ? `${verification.status === 'passed' ? 'Passed' : 'Failed'} — ${verification.summary || verification.note || verification.check_name}` : 'Not run yet.'}\n\n> Draft prepared by ProofPatch. Review the details before creating an issue.`;
}

function githubIssueActionsMarkup() {
  if (!state.report) return '';
  return `<div class="github-issue-actions"><div><strong>Share this incident</strong><p>Prepare a GitHub issue draft for review. ProofPatch does not create issues automatically.</p></div><div class="github-issue-buttons"><button class="button button-secondary" data-action="copy-github-issue" ${state.busy ? 'disabled' : ''}>Copy issue Markdown</button><button class="button button-primary" data-action="open-github-issue" ${state.busy ? 'disabled' : ''}>Open issue draft ↗</button></div></div>`;
}

function downloadIncidentReport() {
  const incident = state.incident;
  if (!incident) return;
  const report = state.report || {};
  const finding = state.analysis?.root_cause;
  const recommendations = state.analysis?.recommendations || [];
  const timeline = report.timeline || [];
  const approval = state.approvals.at(-1);
  const checks = state.verifications;
  const lines = [
    `# Incident report: ${incident.title}`, '',
    `- **Service:** ${incident.service}`, `- **Severity:** ${incident.severity}`, `- **Status:** ${incident.status || 'open'}`, `- **Incident ID:** ${incident.id}`, `- **Created:** ${formatTime(incident.created_at)}`, `- **Updated:** ${formatTime(incident.updated_at)}`, '',
    '## Summary', incident.description || 'No description provided.', '',
    '## Evidence', ...(state.evidence.length ? state.evidence.map((item, index) => `- **E${index + 1} · ${item.source}:** ${item.observation}`) : ['- No evidence collected.']), '',
    '## Analysis', finding?.summary || 'Analysis is not available yet.', '',
    ...(finding?.rationale?.length ? ['### Supporting rationale', ...finding.rationale.map((item) => `- ${item}`), ''] : []),
    '## Recommendations', ...(recommendations.length ? recommendations.map((item) => `- **${item.risk || 'Unspecified'} risk:** ${item.action}${item.rationale ? ` — ${item.rationale}` : ''}`) : ['- No recommendation available.']), '',
    '## Human review', approval ? `**${approval.decision}** by ${approval.approver}${approval.note ? ` — ${approval.note}` : ''}` : 'Pending review.', '',
    '## Verification / service checks', ...(checks.length ? checks.map((item) => `- **${item.status}:** ${item.summary || item.check_name || 'Check'}${item.note ? ` — ${item.note}` : ''}`) : ['- No checks recorded.']), '',
    '## Timeline', ...(timeline.length ? timeline.map((item) => `- ${formatTime(item.occurred_at)} · **${(item.kind || 'event').replaceAll('_', ' ')}:** ${item.summary}`) : ['- No timeline events available.']), '',
    '---', 'Generated by ProofPatch. Review this report before sharing.', '',
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const slug = incident.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'incident';
  link.href = objectUrl;
  link.download = `proofpatch-${slug}-report.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function incidentMetricsMarkup() {
  const finding = state.analysis?.root_cause;
  const confidence = finding?.confidence ? `${finding.confidence} confidence` : 'Not analyzed';
  const latestVerification = state.verifications.at(-1);
  const verification = !latestVerification
    ? 'Pending'
    : !hasCurrentVerification()
      ? 'Recheck required'
      : latestVerification.status === 'passed' ? 'Passed' : 'Failed';
  return `<div class="incident-metrics">
    <div class="metric-card"><span class="metric-icon metric-icon-evidence" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg></span><div><strong>${state.evidence.length}</strong><span>Evidence items</span></div></div>
    <div class="metric-card"><span class="metric-icon metric-icon-analysis" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z"/><path d="M5 3v4M3 5h4m14 11v5m-2.5-2.5h5"/></svg></span><div><strong>${escapeHtml(confidence)}</strong><span>Analysis confidence</span></div></div>
    <div class="metric-card"><span class="metric-icon metric-icon-review" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="5"/><path d="M1 21a8 8 0 0 1 14.8-4.2M16 19l2 2 4-4"/></svg></span><div><strong>${state.approvals.length ? 'Recorded' : 'Waiting'}</strong><span>Human review</span></div></div>
    <div class="metric-card"><span class="metric-icon metric-icon-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z"/><path d="m9 12 2 2 4-4"/></svg></span><div><strong>${verification}</strong><span>Verification</span></div></div>
  </div>`;
}

function incidentLifecycleActionsMarkup() {
  const status = state.incident.status || 'open';
  const latestCheck = state.verifications.at(-1);
  if (status === 'open') {
    return '<button class="button button-secondary" data-action="incident-status" data-status="investigating" type="button">Start investigation</button>';
  }
  if (status === 'investigating') {
    const latestApproval = state.approvals.at(-1);
    const approved = hasCurrentApproval();
    const checkIsFresh = latestCheck?.status === 'passed'
      && Date.parse(latestCheck.checked_at) > Date.parse(latestApproval?.recorded_at || '')
      && Date.parse(latestCheck.checked_at) > latestInvestigationStartedAt();
    const canResolve = approved && checkIsFresh;
    const message = !approved ? 'Latest human review must be approved after investigation begins' : 'Run a passed check after the latest review';
    const hint = canResolve ? '' : `title="${message}"`;
    return `<button class="button button-secondary" data-action="incident-status" data-status="resolved" type="button" ${hint} ${canResolve ? '' : 'disabled'}>Mark resolved</button>`;
  }
  if (status === 'resolved') {
    return '<button class="button button-secondary" data-action="incident-status" data-status="investigating" type="button">Reopen</button><button class="button button-quiet" data-action="incident-status" data-status="closed" type="button">Close incident</button>';
  }
  return '<button class="button button-secondary" data-action="incident-status" data-status="investigating" type="button">Reopen incident</button>';
}

function nextActionMarkup() {
  const decision = state.approvals.at(-1)?.decision;
  const verification = hasCurrentVerification() ? state.verifications.at(-1) : null;
  let title = 'Collect evidence to begin';
  let description = 'Gather signals from the service, logs, and recent changes before making a recommendation.';
  let action = '';
  if (state.evidence.length && !state.analysis) {
    title = 'Analyze the collected evidence';
    description = 'ProofPatch has the signals it needs to identify a likely cause.';
    action = `<button class="button button-primary" data-action="analyze" ${state.busy ? 'disabled' : ''}>Analyze evidence</button>`;
  } else if (state.analysis && !hasCurrentApproval()) {
    title = decision === 'rejected' ? 'Record a new human decision' : 'Review the recommended fix';
    description = 'A current human approval is required before a fresh check can run.';
    action = '<a class="next-action-link" href="#approval">Review approval →</a>';
  } else if (hasCurrentApproval() && !verification) {
    title = 'Run the verification checks';
    description = 'The proposal is approved and ready for a deterministic sandbox check.';
    action = '<a class="next-action-link" href="#verification">Run verification →</a>';
  } else if (verification?.status === 'passed') {
    title = 'Recovery verified';
    description = 'The checks passed. Export the result or prepare a GitHub handoff.';
    action = '<a class="next-action-link" href="#report">View incident report →</a>';
  }
  return `<section class="next-action-card"><div class="next-action-marker">Next</div><div class="next-action-copy"><span class="eyebrow">RECOMMENDED NEXT STEP</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>${action ? `<div class="next-action-control">${action}</div>` : ''}</section>`;
}

function reportMarkup() {
  if (!state.report) return `<div class="report-preview">The report combines the original alert, evidence, diagnosis, human decision, and verification result into one timeline.</div><button class="button button-secondary" data-action="report" ${state.busy ? 'disabled' : ''}>Generate incident report</button>`;
  return `<div class="report-preview"><strong>${escapeHtml(state.report.timeline?.length || 0)} events</strong> · Generated ${formatTime(state.report.generated_at)}</div><div class="report-actions"><button class="button button-secondary" data-action="report" ${state.busy ? 'disabled' : ''}>Refresh report</button><button class="button button-secondary" data-action="download-report">Download Markdown</button></div>${githubIssueActionsMarkup()}`;
}

function renderIncident() {
  if (!state.incident) return;
  const [label, tone] = statusLabel();
  const githubChangeCount = state.evidence.filter((item) => item.details?.github_event_id).length;
  incidentArea.classList.remove('hidden');
  document.querySelector('#welcome-banner').classList.add('hidden');
  const incident = state.incident;
  incidentArea.innerHTML = `
    <div class="incident-hero"><div class="incident-toolbar"><div class="incident-title-block"><div class="incident-kicker"><span class="incident-type-dot"></span> Incident · ${escapeHtml(incident.status || 'open')}</div><h2>${escapeHtml(incident.title)}</h2><p>${escapeHtml(incident.service)} <span>·</span> ID ${escapeHtml(String(incident.id).slice(0, 8))} <span>·</span> Created ${formatTime(incident.created_at)}</p></div><div class="incident-actions"><span class="status-pill is-bad">${escapeHtml(incident.severity || 'unknown')} severity</span><span class="status-pill ${tone}">${escapeHtml(label)}</span>${incidentLifecycleActionsMarkup()}${incident.source === 'seeded-demo' ? `<button class="button button-secondary" data-action="collect" ${state.busy ? 'disabled' : ''}>↻ Refresh evidence</button>` : ''}</div></div>${incidentMetricsMarkup()}</div>
    ${stepperMarkup()}
    ${state.error ? `<div class="error-inline"><strong>Could not complete that step.</strong> ${escapeHtml(state.error)} <span>Check that the FastAPI server is running at ${escapeHtml(API_BASE)}.</span></div>` : ''}
    ${nextActionMarkup()}
    <div class="dashboard-grid"><div class="column-stack">
      <section id="evidence" class="surface evidence-card"><div class="surface-heading"><div><h3>Collected evidence</h3><p>Service, monitoring, and application signals</p></div><span class="subtle-count">${state.evidence.filter((item) => !isChangeEvidence(item)).length} signals</span></div>${evidenceMarkup()}</section>
      <section id="recent-changes" class="surface changes-card"><div class="surface-heading"><div><h3>Recent changes</h3><p>Code and deployment activity near this incident</p></div><div class="changes-heading-actions"><span class="subtle-count">${githubChangeCount} live GitHub ${githubChangeCount === 1 ? 'event' : 'events'}</span><button class="button button-quiet" type="button" data-action="refresh-changes" ${state.busy ? 'disabled' : ''}>Refresh activity</button></div></div>${recentChangesMarkup()}</section>
      <section class="surface analysis-card"><div class="surface-heading"><div><h3>Root-cause analysis</h3><p>What the available evidence points to</p></div></div>${analysisMarkup()}</section>
    </div><div class="column-stack">
      <section id="approval" class="surface approval-card"><div class="surface-heading"><div><h3>Human approval</h3><p>A reviewer decides before verification</p></div><span class="subtle-count">Required</span></div>${approvalMarkup()}</section>
      <section id="verification" class="surface verification-card"><div class="surface-heading"><div><h3>${state.incident.source === 'seeded-demo' ? 'Sandbox verification' : 'Service check'}</h3><p>${state.incident.source === 'seeded-demo' ? 'Checks the proposed demo configuration; does not execute code' : 'Record a result from your project-specific check'}</p></div>${state.verifications.length ? `<span class="status-pill ${state.verifications.at(-1).status === 'passed' ? 'is-good' : 'is-bad'}">${state.verifications.at(-1).status === 'passed' ? 'Passed' : 'Failed'}</span>` : ''}</div>${verificationMarkup()}</section>
      <section id="report" class="surface report-card"><div class="surface-heading"><div><h3>Incident timeline</h3><p>Follow the incident from first signal to verified recovery</p></div></div>${reportMarkup()}<div class="section-divider"></div>${timelineMarkup()}</section>
    </div></div>`;
  if (revealedIncidentId !== incident.id) {
    attachScrollEffects(incidentArea);
    revealedIncidentId = incident.id;
  }
}

function formatTime(value) {
  if (!value) return 'Just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Just now';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

async function initialize() {
  // Load the newest incident and its persisted workflow records on page refresh.
  await loadAnalytics();
  try {
    const incidents = await api('/api/incidents');
    state.incidents = incidents;
    renderRecentIncidents();
    renderOverview();
    if (!incidents.length) return;
    await loadIncidentDetails(incidents[0]);
  } catch {
    // Keep the welcome screen visible until the user starts an incident.
  }
}

attachScrollEffects();
initialize();
