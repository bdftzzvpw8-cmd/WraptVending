/* =====================================================================
   HAHA data shapes — what the sync stores and the dashboard reads
   ---------------------------------------------------------------------
   Field names follow the REST responses as listed in the build roadmap
   (GET /markets, /products, /inventory/products, /sales, /restock/records,
   /markets/{id}/planograms). Anything that arrives in a shape we don't
   recognise is skipped and reported through `warn` — it lands in
   sync/state.warnings so a first run against TEST shows every mismatch
   instead of silently storing zeros.

   Blobs keys (store "haha"):
     markets/latest          { updated, machines: { [marketId]: machine } }
     markets/online-log      { events: [{ at, marketId, online }] }        newest last, 500 kept
     products/latest         { updated, products: { [productId]: product } }
     inventory/latest        { updated, machines: { [marketId]: { name, products: { [productId]: { stock, racks } } } } }
     planograms/latest       { updated, machines: { [marketId]: { capacity: { [productId]: n }, raw } } }
     sales/YYYY-MM-DD        { day, updated, sales: { [saleId]: sale } }    Central day of saleDtm; upserted
     restocks/YYYY-MM        { month, updated, records: { [id]: { id, marketId, firstSeen, raw } } }
   ===================================================================== */
import { money, centralDay, readJSON, writeIfChanged } from './haha.mjs';
import { createHash } from 'node:crypto';

export function makeWarn() {
  const list = [], seen = new Set();
  const warn = msg => { if (!seen.has(msg) && list.length < 60) { seen.add(msg); list.push(msg); } };
  warn.list = list;
  return warn;
}
const cents = (v, warn, label) => {
  try { return money(v); } catch { warn(`${label}: unreadable amount ${JSON.stringify(v)?.slice(0, 40)}`); return 0; }
};
const int = v => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const yes = v => v === true || v === 1 || v === 'true' || v === '1';
const str = v => (v == null ? '' : String(v));

/* ---------- markets ---------- */
export function normalizeMarket(m, warn) {
  const id = str(m?.marketId);
  if (!id) { warn('markets: record without marketId skipped'); return null; }
  if (m.isOnline === undefined) warn('markets: isOnline missing — online status unknown');
  return {
    id, name: str(m.marketName) || id, location: m.marketLocation ?? null, timeZone: m.timeZone ?? null,
    status: str(m.status).toUpperCase(), online: yes(m.isOnline), deviceType: m.deviceType ?? null,
    activationDate: m.activationDate ?? null, networkCard: m.networkCard ?? null,
    doors: m.doors ?? null, layers: m.layers ?? null,
  };
}
/* fold a fresh machine list into the stored one: keep firstSeen/lastSeenOnline, stamp online/offline transitions */
export function mergeMarkets(prev, list, nowISO) {
  const old = prev?.machines || {}, machines = {}, events = [];
  for (const m of list) {
    const o = old[m.id] || {};
    const firstSeen = o.firstSeen || nowISO;
    let since = o.since || nowISO;
    if (o.online !== undefined && o.online !== m.online) { since = nowISO; events.push({ at: nowISO, marketId: m.id, online: m.online }); }
    machines[m.id] = { ...m, firstSeen, since, lastSeenOnline: m.online ? nowISO : (o.lastSeenOnline || null) };
  }
  return { machines, events };
}

/* ---------- products ---------- */
export function normalizeProduct(p, warn) {
  const id = str(p?.productId);
  if (!id) { warn('products: record without productId skipped'); return null; }
  return {
    id, name: str(p.productName ?? p.name) || id,
    price: p.price != null ? cents(p.price, warn, 'products.price') : null,
    cost: p.cost != null ? cents(p.cost, warn, 'products.cost') : null,
    raw: p,
  };
}

/* ---------- inventory: GET /inventory/products is grouped by product → pivot to per machine ---------- */
export function pivotInventory(list, warn) {
  const machines = {};
  for (const p of list) {
    const pid = str(p?.productId);
    if (!pid) { warn('inventory: product without productId skipped'); continue; }
    if (!Array.isArray(p.markets)) { warn('inventory: product without markets[] skipped'); continue; }
    for (const mk of p.markets) {
      const mid = str(mk?.marketId);
      if (!mid) { warn('inventory: markets[] entry without marketId skipped'); continue; }
      const m = (machines[mid] ||= { name: str(mk.marketName) || mid, products: {} });
      m.products[pid] = {
        stock: int(mk.stock), name: str(p.productName) || null,
        racks: Array.isArray(mk.racks) ? mk.racks.map(r => ({ name: str(r?.name), stock: int(r?.stock) })) : [],
      };
    }
  }
  return machines;
}

/* ---------- planograms: slot capacity per product, when the layout carries one ----------
   Looks for objects holding both `productId` and a numeric `capacity` anywhere in the layout and sums them per product.
   Shape not yet confirmed against TEST — if nothing matches, the restock list falls back to the "≤ N units" rule. */
export function planogramCapacity(raw) {
  const cap = {};
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 8) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    if (node.productId != null && Number.isFinite(Number(node.capacity))) {
      const id = str(node.productId);
      cap[id] = (cap[id] || 0) + int(node.capacity);
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(raw, 0);
  return cap;
}

/* ---------- sales ---------- */
export function normalizeSale(s, warn) {
  const id = str(s?.saleId);
  if (!id) { warn('sales: record without saleId skipped'); return null; }
  const at = s.saleDtm;
  if (!at || Number.isNaN(Date.parse(at))) { warn(`sales: ${id} has no readable saleDtm — skipped`); return null; }
  if (s.saleTaxes != null && typeof s.saleTaxes === 'object') warn('sales: saleTaxes is not a decimal string — tax counted as 0 until mapped');
  const items = Array.isArray(s.saleItems) ? s.saleItems : [];
  if (!Array.isArray(s.saleItems)) warn('sales: saleItems missing — product totals incomplete');
  return {
    id, marketId: str(s.marketId), at: new Date(at).toISOString(), day: centralDay(at),
    status: str(s.status).toUpperCase(), refund: yes(s.isRefund),
    gross: cents(s.saleGrossTotal, warn, 'sales.saleGrossTotal'),
    net: cents(s.saleTotal, warn, 'sales.saleTotal'),
    tax: typeof s.saleTaxes === 'object' && s.saleTaxes !== null ? 0 : cents(s.saleTaxes, warn, 'sales.saleTaxes'),
    tenders: Array.isArray(s.saleTenders) ? s.saleTenders.map(t => ({ type: str(t?.type), amount: cents(t?.amount, warn, 'sales.saleTenders.amount') })) : [],
    items: items.map(i => ({
      productId: str(i?.productId), name: str(i?.productName), qty: int(i?.quantity),
      price: cents(i?.price, warn, 'sales.saleItems.price'),
      sub: cents(i?.itemSubTotal, warn, 'sales.saleItems.itemSubTotal'),
      final: cents(i?.itemFinalPrice ?? i?.itemSubTotal, warn, 'sales.saleItems.itemFinalPrice'),
      tax: typeof i?.saleTaxes === 'object' && i?.saleTaxes !== null ? 0 : cents(i?.saleTaxes, warn, 'sales.saleItems.saleTaxes'),
      refund: yes(i?.isRefund),
    })),
    tx: Array.isArray(s.transactions) ? s.transactions.map(t => ({ id: str(t?.providerTransactionID), amount: cents(t?.amount, warn, 'sales.transactions.amount'), at: t?.Date ?? null })) : [],
  };
}

/* What one sale contributes to revenue, the statement and the refund counts.
   Counted = PAID, or refunded (a refunded sale was paid first).
   Refund (ex-tax): the refunded items' itemFinalPrice when items carry the flag; else the whole sale's saleTotal.
   Gross and tax are the whole sale's, so a fully refunded sale nets to zero: gross − tax − saleTotal. */
export function saleFigures(s) {
  const itemRefund = s.items.some(i => i.refund);
  const refunded = s.refund || itemRefund;
  const counted = s.status === 'PAID' || refunded;
  const refundNet = !counted ? 0 : itemRefund ? s.items.filter(i => i.refund).reduce((a, i) => a + i.final, 0) : s.refund ? s.net : 0;
  return { counted, refunded, refundNet, gross: counted ? s.gross : 0, tax: counted ? s.tax : 0, net: counted ? s.net - refundNet : 0 };
}

/* ---------- restocks: records kept as HAHA sends them, keyed by opLogId / id ---------- */
export function restockId(r) {
  const id = r?.opLogId ?? r?.id;
  return id != null && id !== '' ? str(id) : 'h' + createHash('sha1').update(JSON.stringify(r)).digest('hex').slice(0, 16);
}

/* ---------- store writes ---------- */
// Upsert sales into their Central-day files. Unchanged files are not rewritten, so a repeat pull is a no-op.
export async function upsertSales(store, sales, nowISO) {
  const byDay = new Map();
  for (const s of sales) { if (!byDay.has(s.day)) byDay.set(s.day, []); byDay.get(s.day).push(s); }
  let added = 0, changed = 0, written = 0;
  for (const [day, list] of byDay) {
    const key = `sales/${day}`;
    const cur = await readJSON(store, key); // throws on a failed read: never rebuild a day from nothing
    const next = { day, updated: cur?.updated || nowISO, sales: { ...(cur?.sales || {}) } };
    let dirty = false;
    for (const s of list) {
      const old = next.sales[s.id];
      if (!old) added++;
      else if (JSON.stringify(old) !== JSON.stringify(s)) changed++;
      else continue;
      next.sales[s.id] = s;
      dirty = true;
    }
    if (dirty) { next.updated = nowISO; await store.setJSON(key, next); written++; }
  }
  return { days: byDay.size, added, changed, written };
}

export async function readDays(store, days) {
  const out = {};
  for (let i = 0; i < days.length; i += 12) {
    const chunk = days.slice(i, i + 12);
    const got = await Promise.all(chunk.map(d => readJSON(store, `sales/${d}`)));
    chunk.forEach((d, j) => { out[d] = got[j]?.sales || {}; });
  }
  return out;
}

export async function upsertRestocks(store, records, nowISO) {
  const month = centralDay(nowISO).slice(0, 7); // filed by the month the sync first saw it
  const key = `restocks/${month}`;
  const cur = await readJSON(store, key);
  // a record already filed in last month's file stays there
  const prevKey = `restocks/${prevMonth(month)}`;
  const prev = await readJSON(store, prevKey);
  const next = { month, updated: cur?.updated || nowISO, records: { ...(cur?.records || {}) } };
  let added = 0;
  for (const raw of records) {
    const id = restockId(raw);
    if (next.records[id] || prev?.records?.[id]) {
      if (next.records[id] && JSON.stringify(next.records[id].raw) !== JSON.stringify(raw)) next.records[id] = { ...next.records[id], raw };
      continue;
    }
    next.records[id] = { id, marketId: str(raw?.marketId), firstSeen: nowISO, raw };
    added++;
  }
  if (JSON.stringify(next.records) !== JSON.stringify(cur?.records || {})) next.updated = nowISO;
  const wrote = await writeIfChanged(store, key, next, cur ?? undefined);
  return { added, wrote };
}
export function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
