import { readFile, writeFile } from 'node:fs/promises';

const API_BASE = (process.env.KITAWATCH_API_URL || 'https://api.kitawatch.free.nf').replace(/\/+$/, '');
const ANIVEXA_BASE = (process.env.ANIVEXA_BASE_URL || 'https://kitawatch-anivexa-yya5k.faable.link').replace(/\/+$/, '');
const TIMEOUT_MS = 12_000;
const DATA_PATH = new URL('../data/status.json', import.meta.url);

async function check(url, validate = () => true) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    const latencyMs = Math.round(performance.now() - started);
    if (!response.ok) return { status: 'outage', latencyMs, httpStatus: response.status };
    let payload;
    try { payload = await response.json(); } catch { return { status: 'degraded', latencyMs, httpStatus: response.status }; }
    return { status: validate(payload) ? 'operational' : 'degraded', latencyMs, httpStatus: response.status };
  } catch {
    return { status: 'outage', latencyMs: Math.round(performance.now() - started), httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

const services = [
  { id: 'api', name: 'KitaWatch API', description: 'Core API health and unified provider routing.' },
  { id: 'kuhi', name: 'Kuhi adapter', description: 'Kuhi adapter registration and configuration in the hosted KitaWatch API.' },
  { id: 'anivexa', name: 'Anivexa', description: 'Hosted Anivexa API reachability and valid JSON response.' },
];

const apiHealth = await check(API_BASE + '/health', (body) => body?.status === 'healthy');
// These are deliberately lightweight liveness/configuration probes. The episode
// endpoints fan out to external scrapers and can take longer than a health check;
// using them here caused false outages when provider extraction exceeded 12 seconds.
const kuhi = await check(API_BASE + '/providers/unified/status', (body) =>
  body?.adapters?.kuhi?.registered === true && body?.adapters?.kuhi?.configured === true);
// The hosted root route is the Anivexa process's lightweight liveness response.
// Do not couple this check to its informational JSON field names: those can change
// independently of whether the API process is healthy. A non-error JSON object
// plus HTTP 200 is enough for this process-level check; provider extraction is
// intentionally not tested by the status page.
const anivexa = await check(ANIVEXA_BASE + '/', (body) =>
  body !== null && typeof body === 'object' && !Array.isArray(body) && !('error' in body));

const current = { api: apiHealth, kuhi, anivexa };
const states = Object.values(current).map((item) => item.status);
const overall = states.every((state) => state === 'operational') ? 'operational'
  : states.every((state) => state === 'outage') ? 'outage' : 'degraded';
const now = new Date().toISOString();

let previous;
try { previous = JSON.parse(await readFile(DATA_PATH, 'utf8')); }
catch { previous = { history: [], incidents: [] }; }

const history = [...(Array.isArray(previous.history) ? previous.history : []), { timestamp: now, services: current }]
  .filter((row) => Date.now() - new Date(row.timestamp).getTime() <= 30 * 24 * 60 * 60 * 1000);

const incidents = Array.isArray(previous.incidents) ? [...previous.incidents] : [];
for (const service of services) {
  const before = previous.current?.[service.id]?.status || 'unknown';
  const after = current[service.id].status;
  if ((before === 'operational' || before === 'unknown') && after !== 'operational') {
    incidents.unshift({
      id: service.id + '-' + Date.now(),
      serviceId: service.id,
      title: service.name + ' is experiencing issues',
      description: 'The automated health check detected a service disruption or incomplete response.',
      startedAt: now,
      resolvedAt: null,
    });
  } else if (before !== 'operational' && after === 'operational') {
    const open = incidents.find((incident) => incident.serviceId === service.id && !incident.resolvedAt);
    if (open) open.resolvedAt = now;
  }
}

const output = {
  generatedAt: now,
  overall,
  services,
  current,
  history,
  incidents: incidents.slice(0, 50),
};
await writeFile(DATA_PATH, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ generatedAt: now, overall, current }, null, 2));
