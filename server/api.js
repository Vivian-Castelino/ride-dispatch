import http from 'node:http';
import crypto from 'node:crypto';
import { openDb, tx, STATUS } from './db.js';
import { enqueue } from './queue.js';
import { publish } from './events.js';
import { audit } from './audit.js';

const PORT = Number(process.env.PORT || 3001);
const db = openDb();

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** POST /rides — create the ride, put it on the queue, return immediately. No dispatching here. */
function createRide(body) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const ride = {
    rider: String(body.rider || 'Anonymous').slice(0, 80),
    pickup: String(body.pickup || 'Unknown pickup').slice(0, 120),
    dropoff: String(body.dropoff || 'Unknown dropoff').slice(0, 120),
  };
  // Ride + queue job + REQUESTED event commit together or not at all.
  tx(db, () => {
    db.prepare(
      `INSERT INTO rides (id, rider, pickup, dropoff, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, ride.rider, ride.pickup, ride.dropoff, STATUS.REQUESTED, now, now);
    enqueue(db, id);
    publish(db, id, STATUS.REQUESTED);
  });
  return { rideId: id, status: STATUS.REQUESTED };
}

function withOffers(rides) {
  if (rides.length === 0) return rides;
  const rows = db
    .prepare(
      `SELECT ride_id, driver_id, response FROM offers
       WHERE ride_id IN (SELECT value FROM json_each(?)) ORDER BY id`
    )
    .all(JSON.stringify(rides.map((r) => r.id)));
  const byRide = new Map();
  for (const o of rows) {
    if (!byRide.has(o.ride_id)) byRide.set(o.ride_id, []);
    byRide.get(o.ride_id).push({ driverId: o.driver_id, response: o.response });
  }
  return rides.map((r) => ({
    id: r.id,
    rider: r.rider,
    pickup: r.pickup,
    dropoff: r.dropoff,
    status: r.status,
    driverId: r.driver_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    offers: byRide.get(r.id) || [],
  }));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (req.method === 'POST' && pathname === '/rides') {
      const body = await readJson(req);
      if (body === null) return send(res, 400, { error: 'Invalid JSON' });
      return send(res, 202, createRide(body));
    }

    if (req.method === 'GET' && pathname === '/rides') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 500);
      const rows = db.prepare('SELECT * FROM rides ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit);
      return send(res, 200, withOffers(rows));
    }

    const one = pathname.match(/^\/rides\/([\w-]+)$/);
    if (req.method === 'GET' && one) {
      const row = db.prepare('SELECT * FROM rides WHERE id = ?').get(one[1]);
      return row ? send(res, 200, withOffers([row])[0]) : send(res, 404, { error: 'Ride not found' });
    }

    if (req.method === 'GET' && pathname === '/events') {
      const after = Number(url.searchParams.get('after')) || 0;
      const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
      const rows = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?').all(after, limit);
      return send(
        res,
        200,
        rows.map((e) => ({ id: e.id, rideId: e.ride_id, status: e.status, driverId: e.driver_id, createdAt: e.created_at }))
      );
    }

    if (req.method === 'GET' && pathname === '/stats') {
      const byStatus = Object.fromEntries(
        db.prepare('SELECT status, COUNT(*) AS n FROM rides GROUP BY status').all().map((r) => [r.status, r.n])
      );
      const queued = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state != 'done'").get().n;
      const totalEvents = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM events').get().n;
      const consumers = db
        .prepare('SELECT consumer, last_event_id, processed FROM consumer_offsets ORDER BY consumer')
        .all()
        .map((c) => ({ name: c.consumer, offset: c.last_event_id, processed: c.processed, lag: totalEvents - c.last_event_id }));
      return send(res, 200, { byStatus, queued, totalEvents, consumers });
    }

    if (req.method === 'POST' && pathname === '/audit') {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.rideIds)) return send(res, 400, { error: 'rideIds[] required' });
      return send(res, 200, audit(db, body.rideIds));
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error('[api] error:', err);
    return send(res, 500, { error: 'Internal error' });
  }
});

server.listen(PORT, () => console.log(`[api] listening on http://localhost:${PORT}`));
