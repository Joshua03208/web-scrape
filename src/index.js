import { openDb } from './db.js';
import { createApp } from './server/app.js';

const db = openDb();
const app = createApp(db);
const port = Number(process.env.PORT) || 3000;
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Price scraper dashboard: http://localhost:${port}`);
});

process.on('SIGINT', () => { db.close(); server.close(); process.exit(0); });
