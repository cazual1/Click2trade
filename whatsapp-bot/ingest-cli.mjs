// ── INGEST FROM FILE ──
// For when the scraping agent drops a JSON file instead of calling the API:
//   node ingest-cli.mjs listings-2026-10-24.json
import fs from 'node:fs/promises';
import { ingest } from './acquisition.mjs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node ingest-cli.mjs <listings.json>');
  process.exit(1);
}
const payload = JSON.parse(await fs.readFile(file, 'utf8'));
const items = Array.isArray(payload) ? payload : payload.listings;
console.log(await ingest(items, payload.source || 'facebook_marketplace'));
