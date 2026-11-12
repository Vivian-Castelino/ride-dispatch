async function call(path, options) {
  const res = await fetch(`/api${path}`, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const post = (path, body) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export const bookRide = (ride) => post('/rides', ride);
export const getRides = () => call('/rides?limit=60');
export const getEvents = () => call('/events?limit=40');
export const getStats = () => call('/stats');
export const auditRides = (rideIds) => post('/audit', { rideIds });
