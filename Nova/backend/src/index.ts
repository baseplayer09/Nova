import 'dotenv/config';
import { createApp } from './server.js';
import { startRoutineScheduler } from './routine-service.js';

const port = Number(process.env.PORT ?? 3000);
const server = createApp();

server.listen(port, () => {
  console.log(`Nova backend listening on port ${port}`);
  if (process.env.DATABASE_URL) {
    startRoutineScheduler();
  }
});
