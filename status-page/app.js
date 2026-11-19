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
  if (days) return days + 'd ' + hours + 'h';
  if (hours) return hours + 'h ' + minutes + 'm';
  return minutes + 'm';
}

function buildDailyHistory(serviceId, dailyHistory) {
  const entries = Array.isArray(dailyHistory?.[serviceId]) ? dailyHistory[serviceId] : [];
  const byDate = new Map(entries.map((entry) => [entry.date, entry]));
  const now = new Date();
  const days = [];

  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - offset
    ));
    const key = date.toISOString().slice(0, 10);
    const entry = byDate.get(key);
    const status = entry?.status || 'unknown';
    const sampleCount = Number.isFinite(entry?.sampleCount) ? entry.sampleCount : 0;
    const label = date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    const detail = sampleCount
      ? label + ': ' + sampleCount + ' recorded samples; ' + formatPercent(entry.uptime) + ' sampled uptime'
      : label + ': no recorded samples';

    days.push({ status, sampleCount, detail });
  }

  return days;
}

function render(data) {
  const services = Array.isArray(data.services) ? data.services : [];
  const current = data.current || {};
  const dailyHistory = data.dailyHistory || {};
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
    ? 'Last monitoring sample ' + fmtDate(data.generatedAt)
    : 'Waiting for the first monitoring sample';
  document.querySelector('#footer-check').textContent = 'Status updates automatically';

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
        <span>30-day uptime <strong>${formatPercent(service.uptime30d)}</strong></span>
      </div>
    </article>`;
  }).join('') : '<p class="empty">No monitors are available yet.</p>';

  document.querySelector('#uptime').innerHTML = services.length ? services.map((service) => {
    const daily = buildDailyHistory(service.id, dailyHistory);
    const hasSamples = daily.some((day) => day.sampleCount > 0);
    const incidentCount = Number.isFinite(service.incidentCount30d) ? service.incidentCount30d : '—';
    return `<article class="uptime-card">
      <div class="uptime-heading">
        <strong>${esc(service.name)}</strong>
        <span>${formatPercent(service.uptime30d)} <small>30-day sampled uptime</small></span>
      </div>
      <div class="uptime-bars" role="img" aria-label="Daily uptime history for ${esc(service.name)}">
        ${daily.map((day) => `<span class="uptime-bar ${day.status}" title="${esc(day.detail)}" aria-label="${esc(day.detail)}"></span>`).join('')}
      </div>
      <div class="uptime-range"><span>30 days ago</span><span>Today</span></div>
      <div class="uptime-periods">
        <span>Estimated downtime <strong>${formatDuration(service.downtimeSeconds30d)}</strong></span>
        <span>Incidents <strong>${esc(incidentCount)}</strong></span>
      </div>
      <p class="fine-print">${hasSamples
        ? 'Bars summarize five-minute status snapshots. Estimated downtime is based on recorded samples, not exact incident duration.'
        : 'Daily history will appear as monitoring samples are collected.'}</p>
    </article>`;
  }).join('') : '<p class="empty">Uptime history will appear after the first monitoring sample.</p>';

  const incidents = Array.isArray(data.incidents) ? data.incidents.slice(0, 12) : [];
  document.querySelector('#incidents').innerHTML = incidents.length ? incidents.map((incident) =>
    `<article class="incident">
      <div>
        <div class="incident-title">${esc(incident.title)}</div>
        <div class="incident-detail">${esc(incident.description)}</div>
      </div>
      <time class="incident-date">${fmtDate(incident.startedAt)}${incident.resolvedAt ? ' · Resolved ' + fmtDate(incident.resolvedAt) : ' · Ongoing'}</time>
    </article>`
  ).join('') : '<p class="empty">No recent incidents.</p>';
}

async function load() {
  try {
    const response = await fetch(STATUS_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error('Status API returned HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    document.querySelector('#overall').className = 'overall checking';
    document.querySelector('#overall-text').textContent = 'Could not load monitoring data';
    document.querySelector('#updated').textContent = 'The status service is temporarily unavailable.';
    document.querySelector('#services').innerHTML = '<p class="empty">Status data is temporarily unavailable. Please try again later.</p>';
    document.querySelector('#uptime').innerHTML = '<p class="empty">Uptime history is temporarily unavailable.</p>';
    document.querySelector('#incidents').innerHTML = '<p class="empty">Incident history is temporarily unavailable.</p>';
    console.error(error);
  }
}

load();
window.setInterval(load, 60_000);
