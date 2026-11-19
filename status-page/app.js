const STATUS_URL = 'https://kitawatch-status-api.onrender.com/api/status';
const labels = {
  operational: 'Operational',
  degraded: 'Degraded',
  outage: 'Major outage',
  paused: 'Paused',
  unknown: 'No data',
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function fmtDate(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'Unknown'
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatPercent(value) {
  return Number.isFinite(value) ? value.toFixed(2) + '%' : '—';
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function render(data) {
  const services = Array.isArray(data.services) ? data.services : [];
  const current = data.current || {};
  const states = services.map((service) => current[service.id]?.status || service.status || 'unknown');
  const overall = data.overall || (states.length && states.every((state) => state === 'operational')
    ? 'operational'
    : states.some((state) => state === 'outage') ? 'outage'
    : states.some((state) => state === 'degraded') ? 'degraded'
    : 'unknown');

  const overallEl = document.querySelector('#overall');
  overallEl.className = 'overall ' + (overall === 'unknown' ? 'checking' : overall);
  document.querySelector('#overall-text').textContent = overall === 'operational'
    ? 'All monitored systems are operational'
    : overall === 'outage' ? 'Major service disruption detected'
    : overall === 'degraded' ? 'Some services are experiencing issues'
    : 'Monitoring data is not available yet';

  document.querySelector('#updated').textContent = data.generatedAt
    ? 'UptimeRobot data retrieved ' + fmtDate(data.generatedAt)
    : 'Waiting for monitoring data';
  document.querySelector('#footer-check').textContent = 'Monitoring source: UptimeRobot';

  document.querySelector('#services').innerHTML = services.length ? services.map((service) => {
    const result = current[service.id] || service;
    const status = result.status || 'unknown';
    const latency = Number.isFinite(result.latencyMs) ? result.latencyMs + ' ms' : '—';
    return `<article class="service-card">
      <div class="service-top">
        <span class="service-name">${esc(service.name)}</span>
        <span class="pill ${esc(status)}"><i class="dot ${esc(status)}"></i>${labels[status] || labels.unknown}</span>
      </div>
      <p class="service-description">${esc(service.description)}</p>
      <div class="service-meta">
        <span>Response time <strong>${latency}</strong></span>
        <span>30-day uptime <strong>${formatPercent(result.uptime30d)}</strong></span>
      </div>
    </article>`;
  }).join('') : '<p class="empty">No monitors were returned by UptimeRobot.</p>';

  document.querySelector('#uptime').innerHTML = services.length ? services.map((service) => {
    const result = current[service.id] || service;
    const incidentCount = Number.isFinite(result.incidentCount30d)
      ? result.incidentCount30d
      : '—';
    return `<article class="uptime-card">
      <div class="uptime-heading"><strong>${esc(service.name)}</strong><span>${formatPercent(result.uptime30d)} <small>30-day uptime</small></span></div>
      <div class="uptime-periods">
        <span>Downtime <strong>${formatDuration(result.downtimeSeconds30d)}</strong></span>
        <span>Incidents <strong>${esc(incidentCount)}</strong></span>
      </div>
      <p class="service-description">30-day statistics are retrieved directly from UptimeRobot. The free API request limit means detailed uptime statistics are requested for up to eight monitors per refresh.</p>
    </article>`;
  }).join('') : '<p class="empty">Uptime statistics are unavailable.</p>';

  const incidents = Array.isArray(data.incidents) ? data.incidents.slice(0, 12) : [];
  document.querySelector('#incidents').innerHTML = incidents.length ? incidents.map((incident) =>
    `<article class="incident">
      <div>
        <div class="incident-title">${esc(incident.title)}</div>
        <div class="incident-detail">${esc(incident.description)}</div>
      </div>
      <time class="incident-date">${fmtDate(incident.startedAt)}${incident.resolvedAt ? ' · Resolved ' + fmtDate(incident.resolvedAt) : ' · Ongoing'}</time>
    </article>`
  ).join('') : '<p class="empty">No incident history was returned by UptimeRobot.</p>';
}

async function load() {
  try {
    const response = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Status API returned HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    document.querySelector('#overall').className = 'overall checking';
    document.querySelector('#overall-text').textContent = 'Could not load monitoring data';
    document.querySelector('#updated').textContent = 'The status API is temporarily unavailable.';
    document.querySelector('#services').innerHTML = '<p class="empty">Status data is temporarily unavailable. Please try again later.</p>';
    document.querySelector('#uptime').innerHTML = '<p class="empty">Uptime statistics are unavailable.</p>';
    document.querySelector('#incidents').innerHTML = '<p class="empty">Incident history is unavailable.</p>';
    console.error(error);
  }
}

load();
