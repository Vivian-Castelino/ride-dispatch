import { tx } from './db.js';

const STALE_MS = Number(process.env.JOB_STALE_MS || 30_000);

/** Add a ride to the queue. Call inside the same transaction that creates the ride. */
export function enqueue(db, rideId) {
  db.prepare("INSERT INTO jobs (ride_id, state) VALUES (?, 'queued')").run(rideId);
}

/**
 * Atomically claim the next job. BEGIN IMMEDIATE means only one worker at a time can run
 * this, so two workers can never claim the same job.
 *
 * Jobs stuck in 'processing' longer than STALE_MS (a worker crashed) are claimable again,
 * so no ride is ever stranded.
 */
export function claim(db, workerId) {
  return tx(db, () => {
    const job = db
      .prepare(
        `SELECT id, ride_id FROM jobs
         WHERE state = 'queued' OR (state = 'processing' AND locked_at < ?)
         ORDER BY id LIMIT 1`
      )
      .get(Date.now() - STALE_MS);
    if (!job) return null;
    db.prepare("UPDATE jobs SET state = 'processing', locked_by = ?, locked_at = ? WHERE id = ?").run(
      workerId,
      Date.now(),
      job.id
    );
    return job;
  });
}

export function complete(db, jobId) {
  db.prepare("UPDATE jobs SET state = 'done' WHERE id = ?").run(jobId);
}

/** Put a job back after a handler error so it is retried right away. */
export function release(db, jobId) {
  db.prepare("UPDATE jobs SET state = 'queued', locked_by = NULL WHERE id = ?").run(jobId);
}
