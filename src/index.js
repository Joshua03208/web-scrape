import { openDb } from './db.js';
import { createApp } from './server/app.js';

const db = openDb();
const app = createApp(db);
const port = 3000;
app.listen(port, () => {
  console.log(`Price scraper dashboard: http://localhost:${port}`);
});
