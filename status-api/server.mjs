import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT || 3000);
const API_BASE = (process.env.UPTIMEROBOT_API_BASE || 'https://api.uptimerobot.com/v3').replace(/[/]+$/, '');
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/[/]+$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const UPTIMEROBOT_API_KEY = process.env.UPTIMEROBOT_API_KEY || '';
const STATUS_COLLECTOR_TOKEN = process.env.STATUS_COLLECTOR_TOKEN || '';
const STATUS_CACHE_TTL_MS = Number(process.env.STATUS_CACHE_TTL_MS || 30_000);
const CACHE_HEADERS = { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=30' };

let cachedPayload = null;
let cachedAt = 0;
let refreshInFlight = null;
let collectionInFlight = null;

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...extraHeaders,
  });
  response.end(JSON.stringify(payload));
}

function unwrapStatusPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Supabase returned an invalid status payload');
  }

  // Monitor URLs are private configuration details. Never expose the URL
  // stored in historical database rows through the public status endpoint.
  return {
    ...payload,
    services: Array.isArray(payload.services)
      ? payload.services.map((service) => ({
          ...service,
          description: 'Availability and response-time monitoring.',
        }))
      : [],
  };
}

function normalizeStatus(value) {
  const status = String(
    value && typeof value === 'object' ? value.value ?? value.status ?? value.name ?? '' : value ?? ''
  ).toUpperCase();

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

function requireServerConfiguration() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    const error = new Error('Missing required server configuration: ' + missing.join(', '));
    error.statusCode = 503;
    throw error;
  }
}

async function supabaseRpc(functionName, body) {
  requireServerConfiguration();

  const response = await fetch(
    SUPABASE_URL + '/rest/v1/rpc/' + encodeURIComponent(functionName),
    {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const error = new Error('Supabase RPC ' + functionName + ' returned HTTP ' + response.status);
    error.statusCode = response.status >= 500 ? 503 : 502;
    throw error;
  }

  return response.json();
}

async function uptimeRobotGet(url) {
  if (!UPTIMEROBOT_API_KEY) {
    const error = new Error('UPTIMEROBOT_API_KEY is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: 'Bearer ' + UPTIMEROBOT_API_KEY,
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

async function loadMonitors() {
  const monitors = [];
  let nextUrl = new URL('monitors?limit=100', API_BASE + '/');
  let pageCount = 0;

  while (nextUrl && pageCount < 5) {
    const payload = await uptimeRobotGet(nextUrl);
    const items = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.items) ? payload.items : null;

    if (!items) throw new Error('UptimeRobot returned an unexpected monitor-list response');

    monitors.push(...items);
    nextUrl = payload.nextLink ? new URL(payload.nextLink, API_BASE + '/') : null;
    pageCount += 1;
  }

  if (nextUrl) throw new Error('UptimeRobot monitor pagination exceeded the safety limit');
  if (monitors.length === 0) {
    throw new Error('UptimeRobot returned no monitors; refusing to record an empty snapshot');
  }

  return monitors.map((monitor) => {
    const id = monitor.id ?? monitor.monitorId;
    if (id === null || id === undefined) {
      throw new Error('UptimeRobot returned a monitor without an id');
    }

    return {
      id: String(id),
      name: String(monitor.friendlyName ?? monitor.name ?? monitor.url ?? 'Unnamed monitor'),
      description: 'Availability and response-time monitoring.',
      status: normalizeStatus(monitor.status ?? monitor.state),
      latencyMs: numberOrNull(monitor.responseTime, monitor.averageResponseTime, monitor.response_time),
    };
  });
}

function hasValidCollectorToken(request) {
  if (!STATUS_COLLECTOR_TOKEN) return false;
  const authorization = request.headers.authorization || '';
  if (!authorization.startsWith('Bearer ')) return false;

  const supplied = Buffer.from(authorization.slice(7));
  const expected = Buffer.from(STATUS_COLLECTOR_TOKEN);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function collectSnapshot() {
  if (!collectionInFlight) {
    collectionInFlight = (async () => {
      const monitors = await loadMonitors();
      const result = await supabaseRpc('record_status_monitor_snapshot', {
        p_monitors: monitors,
      });
      cachedPayload = null;
      cachedAt = 0;
      return {
        ok: true,
        monitorCount: monitors.length,
        sampledAt: result?.sampledAt ?? new Date().toISOString(),
      };
    })().finally(() => {
      collectionInFlight = null;
    });
  }
  return collectionInFlight;
}

async function loadLegacyStatus() {
  const monitors = await loadMonitors();
  const services = monitors.map((monitor) => ({
    ...monitor,
    uptime30d: null,
    downtimeSeconds30d: null,
    incidentCount30d: null,
  }));
  const statuses = services.map((service) => service.status);
  const overall = statuses.length === 0 ? 'unknown'
    : statuses.every((status) => status === 'operational') ? 'operational'
    : statuses.some((status) => status === 'outage') ? 'outage'
    : statuses.some((status) => status === 'degraded') ? 'degraded'
    : 'unknown';

  return {
    generatedAt: new Date().toISOString(),
    overall,
    services,
    current: Object.fromEntries(services.map((service) => [service.id, {
      status: service.status,
      latencyMs: service.latencyMs,
    }])),
    dailyHistory: {},
    incidents: [],
  };
}

async function getStatus() {
  if (cachedPayload && Date.now() - cachedAt < STATUS_CACHE_TTL_MS) return cachedPayload;

  if (!refreshInFlight) {
    const statusRequest = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
      ? supabaseRpc('get_status_page_data', {})
      : loadLegacyStatus();
    refreshInFlight = statusRequest
      .then((payload) => {
        cachedPayload = unwrapStatusPayload(payload);
        cachedAt = Date.now();
        return cachedPayload;
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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
      sendJson(response, 200, await getStatus(), CACHE_HEADERS);
    } catch (error) {
      console.error('Status read failed:', error.message);
      sendJson(response, error.statusCode || 503, {
        error: 'status_data_unavailable',
        message: 'Monitoring data is temporarily unavailable.',
      });
    }
    return;
  }

  if (request.method === 'POST' && pathname === '/api/collect') {
    if (!STATUS_COLLECTOR_TOKEN) {
      sendJson(response, 503, { error: 'collector_not_configured' });
      return;
    }
    if (!hasValidCollectorToken(request)) {
      sendJson(response, 401, { error: 'unauthorized' });
      return;
    }

    try {
      sendJson(response, 200, await collectSnapshot(), { 'Cache-Control': 'no-store' });
    } catch (error) {
      console.error('Status collection failed:', error.message);
      sendJson(response, error.statusCode || 502, {
        error: 'status_collection_failed',
        message: 'The monitoring snapshot could not be collected.',
      });
    }
    return;
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('KitaWatch Status API listening on port ' + PORT);
});
