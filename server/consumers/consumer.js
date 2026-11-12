import { openDb } from '../db.js';

/**
 * Tiny "consumer group" runner over the events table.
 *
 * Each consumer has its OWN offset row, so Billing and Ops each read the full stream
 * independently — neither steals events from the other (pub/sub fan-out, like Kafka
 * consumer groups). The offset is saved after each event, so a restarted consumer resumes
 * where it left off (a brand-new consumer replays from the beginning).
 */
export async function runConsumer(name, onEvent) {
  const db = openDb();
  db.prepare('INSERT OR IGNORE INTO consumer_offsets (consumer) VALUES (?)').run(name);
  const getOffset = db.prepare('SELECT last_event_id FROM consumer_offsets WHERE consumer = ?');
  const next = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT 200');
  const commit = db.prepare(
    'UPDATE consumer_offsets SET last_event_id = ?, processed = processed + 1 WHERE consumer = ?'
  );

  console.log(`[${name}] started at offset ${getOffset.get(name).last_event_id}`);

  let running = true;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      running = false;
    });
  }

  while (running) {
    const { last_event_id } = getOffset.get(name);
    const batch = next.all(last_event_id);
    if (batch.length === 0) {
      await new Promise((r) => setTimeout(r, 200));
      continue;
    }
    for (const event of batch) {
      onEvent(event);
      commit.run(event.id, name);
    }
  }
  const { processed } = db.prepare('SELECT processed FROM consumer_offsets WHERE consumer = ?').get(name);
  console.log(`[${name}] stopped after ${processed} events`);
}
