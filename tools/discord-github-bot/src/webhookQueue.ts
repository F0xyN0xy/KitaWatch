import Database from "better-sqlite3";

export interface WebhookDelivery {
  deliveryId: string;
  event: string;
  payload: unknown;
  attempts: number;
}

interface DeliveryRow {
  delivery_id: string;
  event: string;
  payload_json: string;
  attempts: number;
}

const MAX_BACKOFF_MS = 15 * 60 * 1000;
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

export function initializeWebhookQueue(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      event TEXT,
      payload_json TEXT,
      status TEXT NOT NULL DEFAULT 'processed',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER,
      processing_started_at INTEGER,
      processed_at TEXT,
      last_error TEXT
    );
  `);

  const columns = new Set(
    (db.pragma("table_info(webhook_deliveries)") as Array<{ name: string }>).map((column) => column.name),
  );
  const migrations: Array<[string, string]> = [
    ["event", "TEXT"],
    ["payload_json", "TEXT"],
    ["status", "TEXT NOT NULL DEFAULT 'processed'"],
    ["attempts", "INTEGER NOT NULL DEFAULT 0"],
    ["next_attempt_at", "INTEGER"],
    ["processing_started_at", "INTEGER"],
    ["processed_at", "TEXT"],
    ["last_error", "TEXT"],
  ];

  for (const [name, definition] of migrations) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE webhook_deliveries ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function createWebhookQueue(db: Database.Database) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO webhook_deliveries
      (delivery_id, event, payload_json, status, attempts, next_attempt_at)
    VALUES (?, ?, ?, 'pending', 0, ?)
  `);
  const find = db.prepare("SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ?");
  const claim = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'processing', attempts = attempts + 1, processing_started_at = ?, next_attempt_at = NULL
    WHERE delivery_id = ?
      AND (
        (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
        OR (status = 'processing' AND processing_started_at <= ?)
      )
  `);
  const due = db.prepare(`
    SELECT delivery_id, event, payload_json, attempts
    FROM webhook_deliveries
    WHERE
      (status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
      OR (status = 'processing' AND processing_started_at <= ?)
    ORDER BY received_at ASC
    LIMIT ?
  `);
  const processed = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
        processing_started_at = NULL, last_error = NULL
    WHERE delivery_id = ? AND status = 'processing'
  `);
  const failed = db.prepare(`
    UPDATE webhook_deliveries
    SET status = 'pending', next_attempt_at = ?, processing_started_at = NULL, last_error = ?
    WHERE delivery_id = ? AND status = 'processing'
  `);

  const enqueueTransaction = db.transaction((deliveryId: string, event: string, payload: unknown, now: number) => {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("Webhook payload could not be serialized");
    insert.run(deliveryId, event, serialized, now);
    return find.get(deliveryId) !== undefined;
  });

  return {
    enqueue(deliveryId: string, event: string, payload: unknown, now = Date.now()): boolean {
      return enqueueTransaction(deliveryId, event, payload, now).changes === 1;
    },

    claimDue(now = Date.now(), limit = 10): WebhookDelivery[] {
      const rows = due.all(now, now - PROCESSING_LEASE_MS, limit) as DeliveryRow[];
      const claimed: WebhookDelivery[] = [];
      for (const row of rows) {
        const result = claim.run(now, row.delivery_id, now, now - PROCESSING_LEASE_MS);
        if (result.changes !== 1) continue;
        claimed.push({
          deliveryId: row.delivery_id,
          event: row.event,
          payload: JSON.parse(row.payload_json) as unknown,
          attempts: row.attempts + 1,
        });
      }
      return claimed;
    },

    markProcessed(deliveryId: string): void {
      processed.run(deliveryId);
    },

    markFailed(deliveryId: string, attempts: number, error: string, now = Date.now()): number {
      const delay = Math.min(30_000 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
      const nextAttemptAt = now + delay;
      failed.run(nextAttemptAt, error.slice(0, 1000), deliveryId);
      return nextAttemptAt;
    },

    has(deliveryId: string): boolean {
      return find.get(deliveryId) !== undefined;
    },
  };
}
