/** Compute the Task-3 checks for a given set of ride ids. */
export function audit(db, rideIds) {
  const ids = JSON.stringify(rideIds);
  const count = (extra) =>
    db
      .prepare(`SELECT COUNT(*) AS n FROM rides WHERE id IN (SELECT value FROM json_each(?)) ${extra}`)
      .get(ids).n;

  const total = count('');
  const assigned = count("AND status = 'ASSIGNED'");
  const noDriver = count("AND status = 'NO_DRIVER_FOUND'");
  const stuck = count("AND status NOT IN ('ASSIGNED', 'NO_DRIVER_FOUND')");

  // A ride counts as "double assigned" if >1 driver accepted it OR it emitted >1 ASSIGNED event.
  const doubleAssigned = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT ride_id FROM offers
          WHERE response = 'ACCEPTED' AND ride_id IN (SELECT value FROM json_each(?1))
          GROUP BY ride_id HAVING COUNT(*) > 1
         UNION
         SELECT ride_id FROM events
          WHERE status = 'ASSIGNED' AND ride_id IN (SELECT value FROM json_each(?1))
          GROUP BY ride_id HAVING COUNT(*) > 1
       )`
    )
    .get(ids).n;

  return { total, assigned, noDriver, stuck, doubleAssigned };
}
