/**
 * Publish a ride status change to the event log.
 *
 * Call this INSIDE the same transaction that changes the ride's status
 * (transactional outbox): the status and its event either both exist or neither does.
 */
export function publish(db, rideId, status, driverId = null) {
  db.prepare(
    'INSERT INTO events (ride_id, status, driver_id, created_at) VALUES (?, ?, ?, ?)'
  ).run(rideId, status, driverId, Date.now());
}
