import { runConsumer } from './consumer.js';

// Program A — billing
runConsumer('billing', (e) => {
  console.log(`[billing] charging rider for ride ${e.ride_id} (event #${e.id}, ${e.status})`);
});
