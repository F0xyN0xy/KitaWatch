import { readFile, writeFile } from 'node:fs/promises';

const statusUrl = process.env.STATUS_API_URL;
if (!statusUrl) throw new Error('STATUS_API_URL is required');

const response = await fetch(statusUrl, { signal: AbortSignal.timeout(20_000) });
if (!response.ok) {
  throw new Error('Status API returned HTTP ' + response.status);
}

const status = await response.json();
if (!Array.isArray(status.services) || status.services.length === 0) {
  throw new Error('Status API returned no services; refusing to record an empty sample.');
}

const sample = {
  timestamp: new Date().toISOString(),
  services: Object.fromEntries(status.services.map((service) => [
    String(service.id),
    {
      status: service.status || status.current?.[service.id]?.status || 'unknown',
      latencyMs: Number.isFinite(service.latencyMs) ? service.latencyMs : null,
    },
  ])),
};

const filePath = new URL('../data/history.json', import.meta.url);
let history = { generatedAt: null, samples: [] };
try {
  history = JSON.parse(await readFile(filePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const samples = Array.isArray(history.samples) ? history.samples : [];
const sampleHour = sample.timestamp.slice(0, 13);
const withoutSameHour = samples.filter((item) => String(item.timestamp || '').slice(0, 13) !== sampleHour);
withoutSameHour.push(sample);
withoutSameHour.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
const retained = withoutSameHour.filter((item) => {
  const timestamp = new Date(item.timestamp).getTime();
  return Number.isFinite(timestamp) && timestamp >= cutoff;
}).slice(-750);

const result = {
  generatedAt: sample.timestamp,
  samples: retained,
};

await writeFile(filePath, JSON.stringify(result, null, 2) + '\n');
console.log('Recorded status snapshot for ' + sample.timestamp + '; retained ' + retained.length + ' samples.');
