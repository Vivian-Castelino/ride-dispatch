// Task 3 — book N rides at once, wait for them to settle, print the report.
const API = process.env.API_URL || 'http://localhost:3001';
const COUNT = Number(process.argv[2] || 100);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 60_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`Booking ${COUNT} rides at once against ${API} ...`);
  const t0 = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: COUNT }, (_, i) =>
      post('/rides', { rider: `Rider ${i + 1}`, pickup: `Pickup ${i + 1}`, dropoff: `Dropoff ${i + 1}` })
    )
  );
  const rideIds = [
    ...new Set(results.filter((r) => r.status === 'fulfilled').map((r) => r.value.rideId)),
  ];
  const failed = results.length - rideIds.length;
  console.log(`Created ${rideIds.length} rides in ${Date.now() - t0}ms${failed ? ` (${failed} requests failed)` : ''}.`);
  console.log('Waiting for the worker to finish them ...');

  let report;
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    report = await post('/audit', { rideIds });
    if (report.stuck === 0 || Date.now() > deadline) break;
    process.stdout.write(`\r  ${report.assigned + report.noDriver}/${rideIds.length} finished   `);
    await sleep(500);
  }
  process.stdout.write('\r' + ' '.repeat(40) + '\r');

  const stats = await (await fetch(`${API}/stats`)).json();
  const finished = report.assigned + report.noDriver;
  const rows = [
    { Check: 'Total rides created', Expected: COUNT, Actual: rideIds.length, Pass: rideIds.length === COUNT },
    { Check: 'ASSIGNED + NO_DRIVER_FOUND', Expected: COUNT, Actual: finished, Pass: finished === COUNT },
    { Check: 'Rides assigned to 2+ drivers', Expected: 0, Actual: report.doubleAssigned, Pass: report.doubleAssigned === 0 },
    { Check: 'Rides stuck with no final status', Expected: 0, Actual: report.stuck, Pass: report.stuck === 0 },
  ].map((r) => ({ ...r, Pass: r.Pass ? '✅' : '❌' }));

  console.log();
  console.table(rows);
  console.log(`Breakdown: ASSIGNED=${report.assigned}  NO_DRIVER_FOUND=${report.noDriver}  (took ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  if (stats.consumers.length) {
    console.log('\nEvent consumers (each should have read every event; lag 0 once caught up):');
    console.table(stats.consumers.map((c) => ({ consumer: c.name, processed: c.processed, offset: c.offset, 'total events': stats.totalEvents, lag: c.lag })));
  }

  process.exit(rows.every((r) => r.Pass === '✅') ? 0 : 1);
}

main().catch((err) => {
  console.error('Load test failed:', err.message, '\nIs the API running? (npm run api)');
  process.exit(1);
});
