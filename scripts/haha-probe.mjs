#!/usr/bin/env node
// First contact with the HAHA Open Platform: call each READ endpoint the sync uses once and save the raw
// responses to .haha-samples/ (git-ignored), then list the field names the sync relies on that came back missing.
// Run it against TEST before trusting the dashboard:
//   HAHA_ENV=test HAHA_APPKEY=... HAHA_APPSECRET=... node scripts/haha-probe.mjs
// Read-only: it goes through hahaFetch, which refuses every write. The token and secret are never printed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { hahaFetch, centralDay, addDays, baseUrl } from '../netlify/functions/lib/haha.mjs';

const mem = new Map(); // token cache for this run only
const store = { get: async k => (mem.has(k) ? JSON.parse(mem.get(k)) : null), setJSON: async (k, v) => { mem.set(k, JSON.stringify(v)); } };
const OUT = '.haha-samples';
mkdirSync(OUT, { recursive: true });

const today = centralDay(), yday = addDays(today, -1);
const EXPECT = {
  markets: ['marketId', 'marketName', 'marketLocation', 'timeZone', 'status', 'isOnline', 'deviceType', 'activationDate'],
  products: ['productId', 'productName', 'price', 'cost'],
  inventory: ['productId', 'totalStock', 'markets'],
  sales: ['saleId', 'marketId', 'saleDtm', 'saleTotal', 'saleGrossTotal', 'saleTaxes', 'saleTenders', 'saleItems', 'isRefund', 'status', 'transactions'],
  restocks: ['opLogId', 'marketId'],
};
const missing = (list, keys) => keys.filter(k => !list.some(x => x && Object.prototype.hasOwnProperty.call(x, k)));

async function probe(name, path, query) {
  try {
    const data = await hahaFetch(path, { store, query: { page_size: 5, ...query } });
    writeFileSync(`${OUT}/${name}.json`, JSON.stringify(data, null, 2));
    const list = Array.isArray(data?.list) ? data.list : [];
    const listKeys = data && typeof data === 'object' ? Object.keys(data) : [];
    console.log(`✓ ${name}: ${list.length} item(s) on the first page; envelope data keys: ${listKeys.join(', ')}`);
    if (EXPECT[name] && list.length) { const m = missing(list, EXPECT[name]); if (m.length) console.log(`  ! fields the sync expects but did not see: ${m.join(', ')}`); }
    if (list[0]) console.log(`  first item keys: ${Object.keys(list[0]).join(', ')}`);
    return data;
  } catch (e) { console.log(`✗ ${name}: ${e.message}`); return null; }
}

console.log(`HAHA ${baseUrl()} — samples go to ${OUT}/`);
const markets = await probe('markets', '/markets');
await probe('products', '/products');
await probe('inventory', '/inventory/products');
await probe('sales', '/sales', { start_time: yday, end_time: today, sort: 'pay_time_asc' });
await probe('restocks', '/restock/records', { start_time: addDays(today, -6), end_time: today });
const first = markets?.list?.[0]?.marketId;
if (first) {
  await probe('market-detail', `/markets/${encodeURIComponent(first)}`);
  await probe('online-status', `/markets/${encodeURIComponent(first)}/online-status`);
  const p = await probe('planograms', `/markets/${encodeURIComponent(first)}/planograms`);
  if (p && !JSON.stringify(p).includes('"capacity"')) console.log('  ! no "capacity" field in the planogram — update planogramCapacity() in lib/haha-data.mjs');
}
console.log('\nCompare these files with lib/haha-data.mjs (normalize*) before relying on the numbers.');
