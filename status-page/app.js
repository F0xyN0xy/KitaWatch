const STATUS_URL = 'https://kitawatch-status-api.onrender.com/api/status';
const HISTORY_URL = './data/history.json';

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

function dayKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function buildDailyHistory(serviceId, samples) {
  const now = new Date();
  const days = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset);
    days.push({ key: dayKey(date), date, samples: [] });
  }

  const dayMap = new Map(days.map((day) => [day.key, day]));
  for (const sample of samples) {
    const date = new Date(sample.timestamp);
    if (Number.isNaN(date.getTime())) continue;
    const day = dayMap.get(dayKey(date));
    const status = sample.services?.[serviceId]?.status;
    if (day && ['operational', 'degraded', 'outage'].includes(status)) {
      day.samples.push(status);
    }
  }

  return days.map((day) => {
    const counts = day.samples.reduce((result, status) => {
      result[status] = (result[status] || 0) + 1;
      return result;
    }, {});
    const total = day.samples.length;
    const status = !total ? 'unknown'
      : counts.outage ? 'outage'
      : counts.degraded ? 'degraded'
      : 'operational';
    const uptime = total ? (counts.operational || 0) / total * 100 : null;
    const label = day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const detail = total
      ? `${label}: ${counts.operational || 0}/${total} operational samples; ${formatPercent(uptime)} sampled uptime`
      : `${label}: no recorded samples`;
    return { status, total, uptime, detail, label };
  });
}

function sampledUptime(serviceId, samples) {
  const relevant = samples
    .map((sample) => sample.services?.[serviceId]?.status)
    .filter((status) => ['operational', 'degraded', 'outage'].includes(status));
  if (!relevant.length) return null;
  return relevant.filter((status) => status === 'operational').length / relevant.length * 100;
}

function render(data, historyData) {
  const services = Array.isArray(data.services) ? data.services : [];
  const current = data.current || {};
  const samples = Array.isArray(historyData?.samples) ? historyData.samples : [];
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
    ? 'Last updated ' + fmtDate(data.generatedAt)
    : 'Waiting for the first monitoring result';
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
        <span>30-day uptime <strong>${formatPercent(sampledUptime(service.id, samples))}</strong></span>
      </div>
    </article>`;
  }).join('') : '<p class="empty">No services are configured yet.</p>';

  document.querySelector('#uptime').innerHTML = services.length ? services.map((service) => {
    const daily = buildDailyHistory(service.id, samples);
    const uptime = sampledUptime(service.id, samples);
    const hasSamples = daily.some((day) => day.total > 0);
    return `<article class="uptime-card">
      <div class="uptime-heading">
        <strong>${esc(service.name)}</strong>
        <span>${hasSamples ? formatPercent(uptime) : 'Collecting data'} <small>30-day sampled uptime</small></span>
      </div>
      <div class="uptime-bars" role="img" aria-label="Daily uptime history for ${esc(service.name)}">
        ${daily.map((day) => `<span class="uptime-bar ${day.status}" title="${esc(day.detail)}" aria-label="${esc(day.detail)}"></span>`).join('')}
      </div>
      <div class="uptime-range"><span>30 days ago</span><span>Today</span></div>
      <div class="uptime-periods">
        <span>Downtime <strong>${formatDuration(service.downtimeSeconds30d)}</strong></span>
        <span>Incidents <strong>${Number.isFinite(service.incidentCount30d) ? service.incidentCount30d : '—'}</strong></span>
      </div>
      <p class="fine-print">${hasSamples ? 'Bars are based on hourly status snapshots. Hover or tap a bar for that day’s details.' : 'Daily history will appear as status checks are collected.'}</p>
    </article>`;
  }).join('') : '<p class="empty">Uptime history will appear when services are available.</p>';

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
    const [statusResponse, historyResponse] = await Promise.all([
      fetch(STATUS_URL, { cache: 'no-store' }),
      fetch(HISTORY_URL, { cache: 'no-store' }),
    ]);
    if (!statusResponse.ok) throw new Error('Status API returned HTTP ' + statusResponse.status);
    const data = await statusResponse.json();
    const historyData = historyResponse.ok ? await historyResponse.json() : { samples: [] };
    render(data, historyData);
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
