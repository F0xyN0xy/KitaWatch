import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_BASE = (process.env.UPTIMEROBOT_API_BASE || 'https://api.uptimerobot.com/v3').replace(/\/+$/, '');
const CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 300_000);
const MAX_PER_MONITOR_STATS = 8;
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

function unwrapObject(payload) {
  return payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
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

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = typeof value === 'number'
    ? new Date(value < 10_000_000_000 ? value * 1000 : value)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  const now = new Date();
  const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // The Free API limit is 10 requests/minute. Keep this refresh within that
  // limit: one monitor list, up to eight per-monitor uptime requests, and one
  // aggregate incident-log request. Cache the result for five minutes.
  const monitorsWithStats = monitors.slice(0, MAX_PER_MONITOR_STATS);
  const statsEntries = await Promise.all(monitorsWithStats.map(async (monitor) => {
    const id = monitor.id ?? monitor.monitorId;
    if (id === null || id === undefined) return [null, null];
    try {
      const query = new URLSearchParams({ from, to: now.toISOString() });
      const stats = unwrapObject(await uptimeRobotGet(
        '/monitors/' + encodeURIComponent(String(id)) + '/stats/uptime?' + query.toString()
      ));
      return [String(id), stats];
    } catch {
      return [String(id), null];
    }
  }));
  const statsById = new Map(statsEntries.filter(([id]) => id !== null));

  const services = monitors.map((monitor) => {
    const id = String(monitor.id ?? monitor.monitorId ?? monitor.uuid ?? monitor.friendlyName ?? monitor.name);
    const name = String(monitor.friendlyName ?? monitor.name ?? monitor.url ?? 'Unnamed monitor');
    const stats = statsById.get(id);
    return {
      id,
      name,
      description: String(monitor.url ?? monitor.description ?? 'Monitored by UptimeRobot'),
      status: normalizeStatus(monitor.status ?? monitor.state),
      latencyMs: numberOrNull(monitor.responseTime, monitor.averageResponseTime, monitor.response_time),
      uptime24h: null,
      uptime7d: null,
      uptime30d: numberOrNull(stats?.uptime, monitor.uptimeRatio, monitor.uptimePercentage),
      downtimeSeconds30d: numberOrNull(stats?.total_downtime_seconds, stats?.totalDowntimeSeconds),
      incidentCount30d: numberOrNull(stats?.incident_count, stats?.incidentCount),
      source: 'UptimeRobot',
    };
  });

  let incidents = [];
  try {
    const aggregate = unwrapObject(await uptimeRobotGet(
      '/monitors/uptime-stats?timeFrame=DAYS_30&logLimit=50'
    ));
    const logs = Array.isArray(aggregate.logs) ? aggregate.logs : [];
    incidents = logs
      .filter((log) => ['DOWN', 'OUTAGE', '9', 'FAIL'].includes(String(log.type ?? log.status ?? '').toUpperCase()))
      .map((log, index) => {
        const serviceId = String(log.monitorId ?? log.monitor?.id ?? '');
        const service = services.find((item) => item.id === serviceId);
        const startedAt = toIso(log.datetime ?? log.startedAt ?? log.timestamp ?? log.createdAt);
        const durationSeconds = numberOrNull(log.duration, log.durationSeconds);
        const resolvedAt = log.resolvedAt ?? (startedAt && durationSeconds > 0
          ? new Date(new Date(startedAt).getTime() + durationSeconds * 1000).toISOString()
          : null);
        return {
          id: String(log.id ?? serviceId + '-' + startedAt + '-' + index),
          serviceId,
          title: String(log.title ?? (service?.name || log.monitorName || 'Monitored service') + ' experienced an outage'),
          description: String(log.reason ?? log.description ?? 'UptimeRobot recorded a downtime event.'),
          startedAt,
          resolvedAt,
        };
      });
  } catch {
    // Monitor health and uptime remain available if aggregate logs are unavailable.
  }

  const statuses = services.map((service) => service.status);
  const overall = statuses.length === 0 ? 'unknown'
    : statuses.every((status) => status === 'operational') ? 'operational'
    : statuses.every((status) => status === 'outage') ? 'outage'
    : statuses.some((status) => status === 'unknown' || status === 'paused') ? 'unknown'
    : 'degraded';

  return {
    generatedAt: now.toISOString(),
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
