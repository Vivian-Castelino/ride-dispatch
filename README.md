# Ride Dispatch — simple ride booking system

A simplified Ola/Uber-style dispatcher: a rider books a ride, a queue + worker offers it to fake drivers, every status change is published as an event, and two independent programs (billing, ops) each read every event. A small React dashboard sits on top.

**Stack:** Node 22 (built-in `node:sqlite`, no native builds) · React + Vite · zero other backend dependencies, no Docker/Redis/Kafka to install.

## Run it

Needs Node ≥ 22.5.

```bash
npm install
npm run dev        # api + worker + billing + ops + React UI, together
```

- UI: http://localhost:5173
- API: http://localhost:3001

Then, in another terminal, the Task 3 script:

```bash
npm run load       # books 100 rides at once and prints the report
```

Or click **Book 100 rides** in the UI — same checks, shown in a table.
Each program can also be run alone: `npm run api | worker | billing | ops`. `npm run reset` wipes the data.

## How it works

```
POST /rides ──► rides + jobs(queue) + event(REQUESTED)   one transaction, returns rideId (202)
                                │
                  worker claims job ──► offer to driver ──► accept?  yes → ASSIGNED
                                              ▲                │ no (×3) → NO_DRIVER_FOUND
                                              └── next driver ◄┘
                                │
              every status change ──► events table (append-only log)
                                           ├── billing  (own offset) → "charging rider for ride X"
                                           └── ops      (own offset) → "ride X is now in status Y"
```

### Task 1 — book & offer
- `POST /rides` (`{rider, pickup, dropoff}`, all optional) inserts the ride and a queue job and returns `{rideId, status: "REQUESTED"}` immediately. No dispatching happens in the request.
- `server/worker.js` is a separate process. It claims jobs, offers the ride to a random not-yet-tried driver from the 10 hardcoded ones (`server/drivers.js`), and fakes the answer with a 50% coin flip (plus a short delay so the UI shows progress).
- Accept → `ASSIGNED`. Reject → next driver. 3 rejections → `NO_DRIVER_FOUND`.
- Other endpoints (used by the UI): `GET /rides`, `GET /rides/:id`, `GET /events`, `GET /stats`, `POST /audit`.

### Task 2 — events with fan-out
- Status changes are written to an append-only `events` table **in the same transaction** as the status change, so a status can never change without its event (transactional outbox).
- `server/consumers/billing.js` and `ops.js` each keep their **own offset** in `consumer_offsets` — the same idea as Kafka consumer groups. So both see all events; neither takes a share. A restarted consumer resumes from its offset, and a brand-new one replays from the start.
- Billing prints a line for every event it sees (including its status) to make the fan-out visible; a real billing service would filter to `ASSIGNED`.

### Task 3 — 100 rides
`server/loadtest.js` fires 100 `POST /rides` concurrently, waits until nothing is non-final, then prints the table below (plus consumer processed counts vs total events as a bonus fan-out check). Exit code is non-zero if any check fails.

Sample run:

| Check | Expected | Actual |
|---|---|---|
| Total rides created | 100 | 100 |
| ASSIGNED + NO_DRIVER_FOUND | 100 | 100 |
| Any ride assigned to 2 drivers? | 0 | 0 |
| Any ride stuck with no final status? | 0 | 0 |

(~12% of rides end `NO_DRIVER_FOUND` by chance: 0.5³.)

## Why these guarantees hold

- **No double assignment:** finalising a ride is a compare-and-set (`UPDATE … WHERE status = 'REQUESTED'`), so it succeeds at most once even if two workers raced. A driver also can't be offered the same ride twice (`UNIQUE(ride_id, driver_id)`).
- **No job claimed twice:** `claim()` runs in a `BEGIN IMMEDIATE` transaction, so you can run several `npm run worker` processes safely.
- **No stuck rides:** if a worker dies mid-ride, its job is reclaimed after 30s (`JOB_STALE_MS`) and resumes from the offers already recorded. Handler errors put the job straight back in the queue.

## Design choices & trade-offs

- **SQLite as queue + log** keeps the project runnable with one `npm install`. In production I'd swap the pieces for a real broker: Redis/SQS/BullMQ for the queue and Kafka/Redis Streams/SNS+SQS for the events. The shape stays the same (job claim, outbox write, per-consumer offsets).
- Consumers are **at-least-once**: an event is processed, then its offset is saved, so a crash in between would re-deliver it. Real consumers should be idempotent.
- Drivers are not marked busy after accepting (the task keeps drivers fake and simple), so one driver can accept many rides.
- Tunables via env vars: `ACCEPT_PROB`, `WORKER_CONCURRENCY`, `DRIVER_DELAY_MIN_MS`, `DRIVER_DELAY_MAX_MS`, `JOB_STALE_MS`, `PORT`, `DB_PATH`.

## Layout

```
server/
  api.js            HTTP API
  worker.js         queue worker + fake drivers
  queue.js          enqueue / claim / complete
  events.js         publish()
  consumers/        consumer.js (runner), billing.js, ops.js
  audit.js          Task 3 checks
  loadtest.js       Task 3 script
  db.js, drivers.js
web/                React dashboard (Vite)
```
