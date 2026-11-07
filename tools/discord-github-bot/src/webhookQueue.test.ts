import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createWebhookQueue, initializeWebhookQueue } from "./webhookQueue.js";

function setup() {
  const db = new Database(":memory:");
  initializeWebhookQueue(db);
  return { db, queue: createWebhookQueue(db) };
}

test("queues a delivery once and ignores duplicate delivery IDs", () => {
  const { db, queue } = setup();
  const payload = { action: "created", comment: { id: 123 } };

  assert.equal(queue.enqueue("delivery-1", "issue_comment", payload, 1_000), true);
  assert.equal(queue.enqueue("delivery-1", "issue_comment", payload, 1_000), false);
  assert.equal(queue.claimDue(1_000).length, 1);
  assert.equal(queue.claimDue(1_000).length, 0);
  db.close();
});

test("marks successful deliveries as processed and does not retry them", () => {
  const { db, queue } = setup();

  queue.enqueue("delivery-2", "issues", { action: "closed" }, 1_000);
  const [delivery] = queue.claimDue(1_000);
  queue.markProcessed(delivery.deliveryId);

  assert.equal(queue.claimDue(10_000).length, 0);
  db.close();
});

test("schedules failed deliveries with increasing backoff", () => {
  const { db, queue } = setup();
  const now = 10_000;

  queue.enqueue("delivery-3", "issue_comment", { action: "created" }, now);
  const [delivery] = queue.claimDue(now);
  const nextAttemptAt = queue.markFailed(delivery.deliveryId, delivery.attempts, "Discord unavailable", now);

  assert.equal(nextAttemptAt, now + 30_000);
  assert.equal(queue.claimDue(nextAttemptAt - 1).length, 0);

  const [retry] = queue.claimDue(nextAttemptAt);
  assert.equal(retry.attempts, 2);
  const secondRetryAt = queue.markFailed(retry.deliveryId, retry.attempts, "Still unavailable", nextAttemptAt);
  assert.equal(secondRetryAt, nextAttemptAt + 60_000);
  db.close();
});

test("recovers a delivery left processing by a crashed worker", () => {
  const { db, queue } = setup();
  const now = 1_000_000;

  queue.enqueue("delivery-4", "issues", { action: "reopened" }, now);
  queue.claimDue(now);

  assert.equal(queue.claimDue(now + 5 * 60_000 - 1).length, 0);
  const [recovered] = queue.claimDue(now + 5 * 60_000);
  assert.equal(recovered.deliveryId, "delivery-4");
  assert.equal(recovered.attempts, 2);
  db.close();
});

test("migrates the previous delivery table without reprocessing old IDs", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE webhook_deliveries (
      delivery_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO webhook_deliveries (delivery_id) VALUES ('legacy-delivery');
  `);

  initializeWebhookQueue(db);
  const queue = createWebhookQueue(db);

  assert.equal(queue.enqueue("legacy-delivery", "issues", { action: "closed" }), false);
  assert.equal(queue.claimDue().length, 0);
  db.close();
});
