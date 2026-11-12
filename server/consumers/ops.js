import { runConsumer } from './consumer.js';

// Program B — ops
runConsumer('ops', (e) => {
  console.log(`[ops] ride ${e.ride_id} is now in status ${e.status} (event #${e.id})`);
});
