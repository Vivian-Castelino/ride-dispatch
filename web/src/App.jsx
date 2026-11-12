import { useEffect, useRef, useState } from 'react';
import { bookRide, getRides, getEvents, getStats, auditRides } from './api.js';

const LABELS = { REQUESTED: 'Requested', ASSIGNED: 'Assigned', NO_DRIVER_FOUND: 'No Driver Found' };
const short = (id) => id.slice(0, 8);
const time = (ms) => new Date(ms).toLocaleTimeString([], { hour12: false });

/** Re-run `fn` every `ms`, keep the latest result. */
function usePolling(fn, ms) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const d = await fn();
        if (alive) {
          setData(d);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    tick();
    const t = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error };
}

function Pill({ status }) {
  return <span className={`pill ${status}`}>{LABELS[status] || status}</span>;
}

/* Icons for the stat tiles */
const svg = { width: 30, height: 30, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
const Icons = {
  REQUESTED: (
    <svg {...svg}><circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M9 18h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6" /></svg>
  ),
  ASSIGNED: (
    <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></svg>
  ),
  NO_DRIVER_FOUND: (
    <svg {...svg}><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></svg>
  ),
  QUEUE: (
    <svg {...svg}><path d="M3 12V4h8l9 9-8 8-9-9Z" /><circle cx="7.5" cy="8.5" r="1" /></svg>
  ),
};

function Stats({ stats }) {
  if (!stats) return null;
  const items = [
    { key: 'REQUESTED', label: 'Requested', value: stats.byStatus.REQUESTED || 0, tile: 'blue' },
    { key: 'ASSIGNED', label: 'Assigned', value: stats.byStatus.ASSIGNED || 0, tile: 'green' },
    { key: 'NO_DRIVER_FOUND', label: 'No Driver Found', value: stats.byStatus.NO_DRIVER_FOUND || 0, tile: 'red' },
    { key: 'QUEUE', label: 'In Queue', value: stats.queued, tile: 'purple' },
  ];
  return (
    <div className="stats">
      {items.map((s) => (
        <div key={s.key} className="stat">
          <div>
            <span className="label">{s.label}</span>
            <b>{s.value.toLocaleString()}</b>
          </div>
          <div className={`tile ${s.tile}`}>{Icons[s.key]}</div>
        </div>
      ))}
    </div>
  );
}

function BookForm() {
  const [form, setForm] = useState({ rider: 'Asha', pickup: 'Bandra Station', dropoff: 'Powai Lake' });
  const [last, setLast] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setLast(await bookRide(form));
    } catch (err) {
      setLast({ error: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Book a ride</h2>
      <form onSubmit={submit}>
        <label>Rider<input value={form.rider} onChange={set('rider')} /></label>
        <label>Pickup<input value={form.pickup} onChange={set('pickup')} /></label>
        <label>Drop-off<input value={form.dropoff} onChange={set('dropoff')} /></label>
        <button disabled={busy}>{busy ? 'Booking…' : 'Book ride'}</button>
      </form>
      {last && (
        <p className="hint">
          {last.error ? `Failed: ${last.error}` : <>Returned <code>rideId {short(last.rideId)}</code> · {last.status}</>}
        </p>
      )}
    </section>
  );
}

function LoadTest() {
  const [ids, setIds] = useState([]);
  const [report, setReport] = useState(null);
  const [running, setRunning] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearInterval(timer.current), []);

  async function run() {
    setRunning(true);
    setReport(null);
    const settled = await Promise.allSettled(
      Array.from({ length: 100 }, (_, i) => bookRide({ rider: `Rider ${i + 1}`, pickup: `Pickup ${i + 1}`, dropoff: `Dropoff ${i + 1}` }))
    );
    const created = [...new Set(settled.filter((r) => r.status === 'fulfilled').map((r) => r.value.rideId))];
    setIds(created);

    const started = Date.now();
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      try {
        const r = await auditRides(created);
        setReport({ ...r, created: created.length });
        if (r.stuck === 0 || Date.now() - started > 60000) {
          clearInterval(timer.current);
          setRunning(false);
        }
      } catch {
        /* keep polling */
      }
    }, 700);
  }

  const rows = report && [
    ['Total rides created', 100, report.created],
    ['ASSIGNED + NO_DRIVER_FOUND', 100, report.assigned + report.noDriver],
    ['Rides assigned to 2+ drivers', 0, report.doubleAssigned],
    ['Rides stuck with no final status', 0, report.stuck],
  ];

  return (
    <section className="card">
      <h2>Load test <span className="muted">· 100 rides at once</span></h2>
      <button onClick={run} disabled={running}>{running ? 'Running…' : 'Book 100 rides'}</button>
      {rows && (
        <div className="table-wrap checks">
          <table className="center">
            <thead><tr><th>Check</th><th>Expected</th><th>Actual</th><th /></tr></thead>
            <tbody>
              {rows.map(([name, exp, act]) => (
                <tr key={name}>
                  <td>{name}</td><td>{exp}</td><td>{act}</td>
                  <td>{act === exp ? '✅' : running ? '…' : '❌'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {report && (
        <p className="hint">ASSIGNED {report.assigned} · NO DRIVER FOUND {report.noDriver} · {ids.length} ids tracked</p>
      )}
    </section>
  );
}

function Offers({ offers }) {
  if (!offers.length) return <span className="muted">—</span>;
  return (
    <span className="offers">
      {offers.map((o) => (
        <span key={o.driverId} className={o.response === 'ACCEPTED' ? 'ok' : 'no'}>
          {o.driverId}{o.response === 'ACCEPTED' ? '✓' : '✗'}
        </span>
      ))}
    </span>
  );
}

function RidesTable({ rides }) {
  return (
    <section className="card">
      <h2>Rides <span className="muted">· latest 60</span></h2>
      <div className="table-wrap scroll">
        <table className="center">
          <thead><tr><th>Ride</th><th>Rider</th><th>Route</th><th>Offers</th><th>Driver</th><th>Status</th></tr></thead>
          <tbody>
            {(rides || []).map((r) => (
              <tr key={r.id}>
                <td><code>{short(r.id)}</code></td>
                <td>{r.rider}</td>
                <td>{r.pickup} → {r.dropoff}</td>
                <td><Offers offers={r.offers} /></td>
                <td>{r.driverId || <span className="muted">—</span>}</td>
                <td><Pill status={r.status} /></td>
              </tr>
            ))}
            {rides && rides.length === 0 && (
              <tr><td colSpan="6" className="empty">No rides yet — book one.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function EventFeed({ events, stats }) {
  return (
    <section className="card">
      <h2>Event stream</h2>
      {stats && (
        <div className="consumers">
          {stats.consumers.length === 0 && <span className="muted">No consumers running (npm run billing / npm run ops)</span>}
          {stats.consumers.map((c) => (
            <span key={c.name} className="chip">
              {c.name}: {c.processed}/{stats.totalEvents} {c.lag === 0 ? '· caught up' : `· lag ${c.lag}`}
            </span>
          ))}
        </div>
      )}
      <ul className="feed">
        {(events || []).map((e) => (
          <li key={e.id}>
            <span className="muted">#{e.id} {time(e.createdAt)}</span> ride <code>{short(e.rideId)}</code> → <Pill status={e.status} />
            {e.driverId && <span className="muted"> by {e.driverId}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Live view of one consumer program (billing / ops): the lines it has printed so far.
 * It shows only events up to that consumer's own saved offset, so it reflects what the
 * real program has actually processed (and stays empty if the program isn't running).
 */
function ConsumerLog({ title, name, command, format, events, stats }) {
  const c = stats && stats.consumers.find((x) => x.name === name);
  const lines = c ? (events || []).filter((e) => e.id <= c.offset) : [];
  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="consumers">
        {c ? (
          <span className="chip">
            {c.processed}/{stats.totalEvents} events {c.lag === 0 ? '· caught up' : `· lag ${c.lag}`}
          </span>
        ) : (
          <span className="muted">Not running — start it with <code>{command}</code></span>
        )}
      </div>
      <div className="console">
        {lines.length === 0 && <div className="console-empty">No output yet</div>}
        {lines.map((e) => (
          <div key={e.id}>
            <span className="tag">[{name}]</span> {format(e)}
          </div>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const rides = usePolling(getRides, 1000);
  const events = usePolling(getEvents, 1000);
  const stats = usePolling(getStats, 1000);
  const offline = rides.error && !rides.data;

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="18" r="3" /><circle cx="18" cy="6" r="3" /><path d="M9 18h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6" />
            </svg>
          </span>
          <h1>Ride Dispatch</h1>
        </div>
      </header>
      <main>
        {offline && <div className="banner">Can’t reach the API. Start the backend with <code>npm run dev</code>.</div>}
        <Stats stats={stats.data} />
        <div className="grid">
          <div className="col">
            <BookForm />
            <LoadTest />
            <EventFeed events={events.data} stats={stats.data} />
            <ConsumerLog
              title="Program A · Billing"
              name="billing"
              command="npm run billing"
              format={(e) => `charging rider for ride ${short(e.rideId)} (${e.status})`}
              events={events.data}
              stats={stats.data}
            />
            <ConsumerLog
              title="Program B · Ops"
              name="ops"
              command="npm run ops"
              format={(e) => `ride ${short(e.rideId)} is now in status ${e.status}`}
              events={events.data}
              stats={stats.data}
            />
          </div>
          <RidesTable rides={rides.data} />
        </div>
      </main>
    </>
  );
}
