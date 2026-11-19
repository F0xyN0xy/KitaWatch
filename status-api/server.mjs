import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_BASE = (process.env.UPTIMEROBOT_API_BASE || 'https://api.uptimerobot.com/v3').replace(/\/+$/, '');
const CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 60_000);
const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=30, stale-while-revalidate=60' };

let cachedPayload = null;
let cachedAt = 0;
let refreshInFlight = null;

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function unwrapCollection(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.monitors)) return payload.monitors;
  return [];
}

function normalizeStatus(value) {
  const status = String(value ?? '').toUpperCase();
  if (['UP', 'OPERATIONAL', '2'].includes(status)) return 'operational';
  if (['DOWN', 'OUTAGE', '9'].includes(status)) return 'outage';
  if (['LOOKS_DOWN', 'SEEMS_DOWN', 'DEGRADED', '8'].includes(status)) return 'degraded';
  if (['PAUSED', '0'].includes(status)) return 'paused';
  if (['STARTED', 'PENDING', 'NOT_CHECKED', '1'].includes(status)) return 'unknown';
  return 'unknown';
}

function numberOrNull(...values) {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (value !== null && value !== undefined && value !== '' && Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeUptime(monitor, period) {
  const candidates = [
    monitor?.uptime?.[period],
    monitor?.uptimeRatio?.[period],
    monitor?.uptimePercent?.[period],
    monitor?.uptimePercentage?.[period],
    monitor?.stats?.uptime?.[period],
    period === '30d' ? monitor?.uptimeRatio : undefined,
    period === '30d' ? monitor?.uptimePercentage : undefined,
  ];
  const value = numberOrNull(...candidates);
  if (value === null) return null;
  return Math.max(0, Math.min(100, value <= 1 ? value * 100 : value));
}

async function uptimeRobotGet(path) {
  const token = process.env.UPTIMEROBOT_API_KEY;
  if (!token) {
    const error = new Error('UPTIMEROBOT_API_KEY is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(API_BASE + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    const error = new Error('UptimeRobot API returned HTTP ' + response.status);
    error.statusCode = response.status === 429 ? 503 : 502;
    throw error;
  }
  return response.json();
}

async function loadStatus() {
  const monitorPayload = await uptimeRobotGet('/monitors?limit=200');
  const monitors = unwrapCollection(monitorPayload);

  const services = monitors.map((monitor) => {
    const id = String(monitor.id ?? monitor.monitorId ?? monitor.uuid ?? monitor.friendlyName ?? monitor.name);
    const name = String(monitor.friendlyName ?? monitor.name ?? monitor.url ?? 'Unnamed monitor');
    const status = normalizeStatus(monitor.status ?? monitor.state);
    return {
      id,
      name,
      description: String(monitor.url ?? monitor.description ?? 'Monitored by UptimeRobot'),
      status,
      latencyMs: numberOrNull(monitor.responseTime, monitor.averageResponseTime, monitor.response_time),
      uptime24h: normalizeUptime(monitor, '24h'),
      uptime7d: normalizeUptime(monitor, '7d'),
      uptime30d: normalizeUptime(monitor, '30d'),
      source: 'UptimeRobot',
    };
  });

  let incidents = [];
  try {
    const incidentPayload = await uptimeRobotGet('/incidents?limit=50');
    incidents = unwrapCollection(incidentPayload).map((incident) => ({
      id: String(incident.id ?? incident.incidentId ?? ''),
      serviceId: String(incident.monitorId ?? incident.monitor?.id ?? ''),
      title: String(incident.title ?? incident.name ?? 'Monitoring incident'),
      description: String(incident.description ?? incident.reason ?? incident.message ?? ''),
      startedAt: incident.startedAt ?? incident.started_at ?? incident.createdAt ?? incident.created_at ?? null,
      resolvedAt: incident.resolvedAt ?? incident.resolved_at ?? incident.closedAt ?? incident.closed_at ?? null,
    }));
  } catch {
    // Incident history is optional; monitor status remains available if this endpoint
    // is unavailable to the current API key or account plan.
  }

  const statuses = services.map((service) => service.status);
  const overall = statuses.length === 0 ? 'unknown'
    : statuses.every((status) => status === 'operational') ? 'operational'
    : statuses.every((status) => status === 'outage') ? 'outage'
    : statuses.some((status) => status === 'unknown' || status === 'paused') ? 'unknown'
    : 'degraded';

  return {
    generatedAt: new Date().toISOString(),
    overall,
    source: 'UptimeRobot',
    services,
    current: Object.fromEntries(services.map((service) => [service.id, service])),
    history: [],
    incidents,
  };
}

async function getStatus() {
  if (cachedPayload && Date.now() - cachedAt < CACHE_TTL_MS) return cachedPayload;
  if (!refreshInFlight) {
    refreshInFlight = loadStatus()
      .then((payload) => {
        cachedPayload = payload;
        cachedAt = Date.now();
        return payload;
      })
      .finally(() => {
        refreshInFlight = null;
      });
  }
  return refreshInFlight;
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    response.end();
    return;
  }

  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (request.method === 'GET' && pathname === '/health') {
    sendJson(response, 200, { status: 'healthy', service: 'kitawatch-status-api' });
    return;
  }

  if (request.method === 'GET' && pathname === '/api/status') {
    try {
      const payload = await getStatus();
      sendJson(response, 200, payload, CACHE_HEADERS);
    } catch (error) {
      sendJson(response, error.statusCode || 502, {
        error: 'status_data_unavailable',
        message: error.message,
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('KitaWatch Status API listening on port ' + PORT);
});
