import { openDb, tx, STATUS } from './db.js';
import { DRIVERS } from './drivers.js';
import { claim, complete, release } from './queue.js';
import { publish } from './events.js';

const MAX_REJECTIONS = 3;
const ACCEPT_PROB = Number(process.env.ACCEPT_PROB ?? 0.5);
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 5);
const DELAY_MIN = Number(process.env.DRIVER_DELAY_MIN_MS ?? 100); // fake "driver thinking" time
const DELAY_MAX = Number(process.env.DRIVER_DELAY_MAX_MS ?? 400);
const WORKER_ID = `worker-${process.pid}`;

const db = openDb();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/** Offer one ride to drivers, one at a time, until someone accepts or 3 have rejected. */
async function dispatch(rideId) {
  for (;;) {
    const ride = db.prepare('SELECT status FROM rides WHERE id = ?').get(rideId);
    if (!ride || ride.status !== STATUS.REQUESTED) return; // already finished (e.g. job reclaimed)

    const offers = db.prepare('SELECT driver_id, response FROM offers WHERE ride_id = ?').all(rideId);
    const tried = new Set(offers.map((o) => o.driver_id));
    const pool = DRIVERS.filter((d) => !tried.has(d.id));

    if (pool.length === 0) {
      // Can't happen with 10 drivers / 3 rejections, but never leave a ride hanging.
      tx(db, () => finish(rideId, STATUS.NO_DRIVER_FOUND, null));
      return;
    }

    const driver = pool[Math.floor(Math.random() * pool.length)];
    await sleep(rand(DELAY_MIN, DELAY_MAX)); // driver "decides"
    const accepted = Math.random() < ACCEPT_PROB; // fake driver response

    // Record the offer and apply its consequence atomically.
    const outcome = tx(db, () => {
      db.prepare(
        'INSERT OR IGNORE INTO offers (ride_id, driver_id, response, created_at) VALUES (?, ?, ?, ?)'
      ).run(rideId, driver.id, accepted ? 'ACCEPTED' : 'REJECTED', Date.now());

      if (accepted) return finish(rideId, STATUS.ASSIGNED, driver.id);

      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM offers WHERE ride_id = ? AND response = 'REJECTED'")
        .get(rideId);
      if (n >= MAX_REJECTIONS) return finish(rideId, STATUS.NO_DRIVER_FOUND, null);
      return 'continue';
    });

    log(rideId, driver.id, accepted ? 'accepted' : 'rejected', outcome);
    if (outcome !== 'continue') return;
  }
}

/**
 * Move a ride to a final status. The `WHERE status = 'REQUESTED'` guard makes this a
 * compare-and-set: a ride can be finalised exactly once, so it can never end up assigned
 * to two drivers, even if two workers ever raced on it.
 */
function finish(rideId, status, driverId) {
  const res = db
    .prepare("UPDATE rides SET status = ?, driver_id = ?, updated_at = ? WHERE id = ? AND status = 'REQUESTED'")
    .run(status, driverId, Date.now(), rideId);
  if (res.changes === 1) {
    publish(db, rideId, status, driverId);
    return status;
  }
  return 'continue';
}

function log(rideId, driverId, answer, outcome) {
  const tail = outcome === 'continue' ? '→ trying next driver' : `→ ${outcome}`;
  console.log(`[${WORKER_ID}] ride ${rideId.slice(0, 8)} · ${driverId} ${answer} ${tail}`);
}

let running = true;
async function slot() {
  while (running) {
    const job = claim(db, WORKER_ID);
    if (!job) {
      await sleep(100);
      continue;
    }
    try {
      await dispatch(job.ride_id);
      complete(db, job.id);
    } catch (err) {
      console.error(`[${WORKER_ID}] job ${job.id} failed:`, err.message);
      release(db, job.id);
      await sleep(250);
    }
  }
}

console.log(`[${WORKER_ID}] started · concurrency=${CONCURRENCY} · accept=${ACCEPT_PROB}`);
const slots = Array.from({ length: CONCURRENCY }, slot);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    running = false;
    Promise.allSettled(slots).then(() => process.exit(0));
  });
}
