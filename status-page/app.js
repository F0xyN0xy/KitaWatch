const STATUS_URL = './data/status.json';
const labels = { operational: 'Operational', degraded: 'Degraded', outage: 'Major outage', unknown: 'No data' };
const fmtDate = (value) => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function uptime(history, serviceId, hours) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const rows = (history || []).filter((row) => new Date(row.timestamp).getTime() >= since && row.services?.[serviceId]);
  if (!rows.length) return '—';
  const good = rows.filter((row) => row.services[serviceId].status === 'operational').length;
  return ((good / rows.length) * 100).toFixed(2) + '%';
}
function dayBars(history, serviceId, days = 30) {
  const now = new Date();
  const result = [];
  for (let offset = days - 1; offset >= 0; offset--) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - offset);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const samples = (history || []).filter((row) => {
      const time = new Date(row.timestamp).getTime();
      return time >= start.getTime() && time < end.getTime() && row.services?.[serviceId];
    });
    let status = 'unknown';
    if (samples.length) {
      const states = samples.map((row) => row.services[serviceId].status);
      status = states.includes('outage') ? 'outage'
        : states.includes('degraded') ? 'degraded'
        : states.every((state) => state === 'operational') ? 'operational' : 'unknown';
    }
    const dateLabel = start.toLocaleDateString(undefined, { dateStyle: 'medium' });
    const detail = samples.length
      ? `${dateLabel}: ${labels[status]} · ${samples.length} check${samples.length === 1 ? '' : 's'}`
      : `${dateLabel}: No check data`;
    result.push({ status, detail });
  }
  return result;
}
function render(data) {
  const services = data.services || [];
  const current = data.current || {};
  const states = services.map((s) => current[s.id]?.status || 'unknown');
  const overall = states.every((s) => s === 'operational') ? 'operational'
    : states.every((s) => s === 'outage') ? 'outage'
    : states.some((s) => s === 'unknown') ? 'unknown' : 'degraded';
  const overallEl = document.querySelector('#overall');
  overallEl.className = 'overall ' + (overall === 'unknown' ? 'checking' : overall);
  document.querySelector('#overall-text').textContent = overall === 'operational'
    ? 'All monitored systems are operational'
    : overall === 'outage' ? 'Major service disruption detected'
    : overall === 'degraded' ? 'Some services are experiencing issues'
    : 'Monitoring data is not available yet';
  document.querySelector('#updated').textContent = data.generatedAt ? 'Last updated ' + fmtDate(data.generatedAt) : 'Waiting for the first monitoring result';
  document.querySelector('#footer-check').textContent = 'Last check: ' + fmtDate(data.generatedAt);

  document.querySelector('#services').innerHTML = services.map((service) => {
    const result = current[service.id] || {};
    const status = result.status || 'unknown';
    const latency = Number.isFinite(result.latencyMs) ? result.latencyMs + ' ms' : '—';
    return `<article class="service-card">
      <div class="service-top"><span class="service-name">${esc(service.name)}</span><span class="pill ${esc(status)}"><i class="dot ${esc(status)}"></i>${labels[status] || labels.unknown}</span></div>
      <p class="service-description">${esc(service.description)}</p>
      <div class="service-meta"><span>Response time <strong>${latency}</strong></span><span>HTTP <strong>${esc(result.httpStatus ?? '—')}</strong></span></div>
    </article>`;
  }).join('');

  document.querySelector('#uptime').innerHTML = services.map((service) => {
    const bars = dayBars(data.history, service.id);
    return `<article class="uptime-card">
      <div class="uptime-heading"><strong>${esc(service.name)}</strong><span>${uptime(data.history, service.id, 24 * 30)} <small>30-day uptime</small></span></div>
      <div class="uptime-bars" role="img" aria-label="Daily uptime history for ${esc(service.name)}">${bars.map((bar) =>
        `<span class="uptime-bar ${bar.status}" title="${esc(bar.detail)}" aria-label="${esc(bar.detail)}"></span>`
      ).join('')}</div>
      <div class="uptime-range"><span>30 days ago</span><span>Today</span></div>
      <div class="uptime-periods">
        <span>24 hours <strong>${uptime(data.history, service.id, 24)}</strong></span>
        <span>7 days <strong>${uptime(data.history, service.id, 24 * 7)}</strong></span>
        <span>30 days <strong>${uptime(data.history, service.id, 24 * 30)}</strong></span>
      </div>
    </article>`;
  }).join('');

  const incidents = (data.incidents || []).slice(0, 12);
  document.querySelector('#incidents').innerHTML = incidents.length ? incidents.map((incident) =>
    `<article class="incident"><div><div class="incident-title">${esc(incident.title)}</div><div class="incident-detail">${esc(incident.description)}</div></div><time class="incident-date">${fmtDate(incident.startedAt)}${incident.resolvedAt ? ' · Resolved ' + fmtDate(incident.resolvedAt) : ' · Ongoing'}</time></article>`
  ).join('') : '<p class="empty">No incidents have been recorded.</p>';
}
async function load() {
  try {
    const response = await fetch(STATUS_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    render(await response.json());
  } catch (error) {
    document.querySelector('#overall-text').textContent = 'Could not load monitoring data';
    document.querySelector('#updated').textContent = 'The status data file could not be reached.';
    document.querySelector('#services').innerHTML = '<p class="empty">Status data is temporarily unavailable. Please try again later.</p>';
    document.querySelector('#incidents').innerHTML = '<p class="empty">Incident history is unavailable.</p>';
  }
}
load();
