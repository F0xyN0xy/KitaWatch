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

  const metrics = [
    ['24h', 24],
    ['7d', 24 * 7],
    ['30d', 24 * 30],
  ];
  document.querySelector('#uptime').innerHTML = services.map((service) =>
    `<div class="uptime-card"><span>${esc(service.name)}</span><div class="periods">${metrics.map(([label, hours]) =>
      `<div><small>${label}</small><strong>${uptime(data.history, service.id, hours)}</strong></div>`
    ).join('')}</div></div>`
  ).join('');

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
