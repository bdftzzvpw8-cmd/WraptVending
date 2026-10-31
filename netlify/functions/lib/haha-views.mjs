/* =====================================================================
   HAHA views — what haha-api hands the dashboard, Command and JARVIS
   ---------------------------------------------------------------------
   Pure functions over what the sync stored. Revenue figures:
     net    = ex-tax sales after refunds (Σ saleTotal − refunds) — the headline number
     gross  = what customers paid, incl. sales tax (Σ saleGrossTotal)
   Every figure can be traced to its orders via view=orders.
   ===================================================================== */
import { centralDay, addDays, dayRange, fmt } from './haha.mjs';
import { saleFigures } from './haha-data.mjs';
import { stockPercent, ALERT_RULES } from './haha-alerts.mjs';
import { DEFAULT_SETTINGS } from './haha-statement.mjs';

const blank = () => ({ net: 0, gross: 0, tax: 0, tx: 0, refunds: 0, refundNet: 0 });
function add(t, s) {
  const f = saleFigures(s);
  if (!f.counted) return t;
  t.net += f.net; t.gross += f.gross; t.tax += f.tax; t.tx++;
  if (f.refunded) { t.refunds++; t.refundNet += f.refundNet; }
  return t;
}
const machineList = markets => Object.values(markets?.machines || {}).sort((a, b) => a.name.localeCompare(b.name));
const productName = (products, inventory, pid) => products?.products?.[pid]?.name
  || Object.values(inventory?.machines || {}).map(m => m.products?.[pid]?.name).find(Boolean) || pid;

/* the days a summary needs: month-to-date ∪ last 7 */
export function summaryDays(now) {
  const today = centralDay(now);
  const first = `${today.slice(0, 8)}01`, week = addDays(today, -6);
  return dayRange(first < week ? first : week, today);
}

export function summary({ now = new Date(), markets, inventory, planograms, days, alerts, syncState, env }) {
  const today = centralDay(now), week = addDays(today, -6), first = `${today.slice(0, 8)}01`;
  const per = {}, totals = { today: blank(), week: blank(), mtd: blank() };
  const lastSale = {};
  for (const [day, sales] of Object.entries(days || {})) {
    for (const s of Object.values(sales)) {
      const p = (per[s.marketId] ||= { today: blank(), week: blank(), mtd: blank() });
      if (day === today) { add(p.today, s); add(totals.today, s); }
      if (day >= week) { add(p.week, s); add(totals.week, s); }
      if (day >= first) { add(p.mtd, s); add(totals.mtd, s); }
      if (saleFigures(s).counted && (!lastSale[s.marketId] || s.at > lastSale[s.marketId])) lastSale[s.marketId] = s.at;
    }
  }
  const lastOk = syncState?.lastOk || null;
  return {
    generated_at: now.toISOString(), env: env || syncState?.env || null, day: today,
    sync: {
      lastOk, minutesAgo: lastOk ? Math.max(0, Math.round((now - new Date(lastOk)) / 60e3)) : null,
      stale: !lastOk || now - new Date(lastOk) > ALERT_RULES.syncStaleMin * 60e3,
      lastRun: syncState?.lastRun ? { at: syncState.lastRun.at, mode: syncState.lastRun.mode, ok: syncState.lastRun.ok, errors: syncState.lastRun.errors || [], warnings: syncState.lastRun.warnings || [] } : null,
    },
    totals,
    machines: machineList(markets).map(m => {
      const inv = inventory?.machines?.[m.id];
      const items = Object.values(inv?.products || {});
      return {
        id: m.id, name: m.name, location: m.location, status: m.status, online: m.online, since: m.since, lastSeenOnline: m.lastSeenOnline,
        lastSale: lastSale[m.id] || null,
        stockPct: stockPercent(inv, planograms?.machines?.[m.id]?.capacity),
        units: items.reduce((a, p) => a + Math.max(0, p.stock), 0),
        outOfStock: items.filter(p => p.stock <= 0).length,
        ...(per[m.id] || { today: blank(), week: blank(), mtd: blank() }),
      };
    }),
    alerts: Object.values(alerts?.active || {}).sort((a, b) => (a.level === b.level ? 0 : a.level === 'red' ? -1 : 1)),
  };
}

/* plain text for JARVIS / a quick read */
export function summaryText(s) {
  const L = [`WRAPT MACHINES — ${s.day}`, `Net sales: today ${fmt(s.totals.today.net)} · 7 days ${fmt(s.totals.week.net)} · month ${fmt(s.totals.mtd.net)}`];
  const off = s.machines.filter(m => m.status === 'ACTIVE' && !m.online);
  L.push(`${s.machines.length} machines, ${off.length} offline${off.length ? `: ${off.map(m => m.name).join(', ')}` : ''}`);
  if (s.alerts.length) { L.push('', 'Alerts:'); s.alerts.forEach(a => L.push(`- ${a.text}`)); }
  L.push('', s.sync.lastOk ? `Synced ${s.sync.minutesAgo} min ago${s.sync.stale ? ' (STALE)' : ''}.` : 'Never synced.');
  return L.join('\n');
}

export function salesRange({ from, to, days, markets, marketId = '' }) {
  const list = dayRange(from, to), rows = {}, byDay = Object.fromEntries(list.map(d => [d, blank()]));
  const top = new Map(), totals = blank();
  for (const d of list) {
    for (const s of Object.values(days[d] || {})) {
      if (marketId && s.marketId !== marketId) continue;
      const f = saleFigures(s);
      if (!f.counted) continue;
      const r = (rows[s.marketId] ||= { id: s.marketId, name: markets?.machines?.[s.marketId]?.name || s.marketId, byDay: {}, total: blank() });
      add((r.byDay[d] ||= blank()), s); add(r.total, s); add(byDay[d], s); add(totals, s);
      const wholeRefund = s.refund && !s.items.some(i => i.refund);
      for (const i of s.items) {
        if (i.refund || wholeRefund) continue;
        const p = top.get(i.productId) || { productId: i.productId, name: i.name || i.productId, qty: 0, net: 0 };
        p.qty += i.qty; p.net += i.final;
        top.set(i.productId, p);
      }
    }
  }
  return {
    from, to, marketId: marketId || null, days: list, byDay, totals,
    machines: Object.values(rows).sort((a, b) => b.total.net - a.total.net),
    top: [...top.values()].sort((a, b) => b.net - a.net || b.qty - a.qty).slice(0, 25),
  };
}

export function orders({ day, days, marketId = '', productId = '', refundsOnly = false }) {
  const out = [];
  for (const s of Object.values(days[day] || {})) {
    if (marketId && s.marketId !== marketId) continue;
    if (productId && !s.items.some(i => i.productId === productId)) continue;
    const f = saleFigures(s);
    if (refundsOnly && !f.refunded) continue;
    out.push({ ...s, figures: f });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/* Below threshold: < restockPercent of planogram capacity, or ≤ restockUnits when capacity is unknown.
   A machine with anything below threshold is due; for a due machine every item is topped up to capacity. */
export function restock({ markets, inventory, planograms, products, settings = DEFAULT_SETTINGS }) {
  const pct = settings.restockPercent ?? DEFAULT_SETTINGS.restockPercent, units = settings.restockUnits ?? DEFAULT_SETTINGS.restockUnits;
  const shop = new Map(), out = [];
  for (const m of machineList(markets)) {
    const inv = inventory?.machines?.[m.id];
    if (!inv) continue;
    const cap = planograms?.machines?.[m.id]?.capacity || {};
    const items = Object.entries(inv.products || {}).map(([pid, p]) => {
      const c = cap[pid] ?? null;
      const low = c ? p.stock < Math.ceil((c * pct) / 100) : p.stock <= units;
      return { productId: pid, name: productName(products, inventory, pid), stock: p.stock, capacity: c, low, need: c ? Math.max(0, c - Math.max(0, p.stock)) : null };
    }).sort((a, b) => Number(b.low) - Number(a.low) || a.stock - b.stock);
    const due = items.some(i => i.low);
    if (due) {
      for (const i of items) {
        if (!(i.need > 0) && !(i.need == null && i.low)) continue;
        const s = shop.get(i.productId) || { productId: i.productId, name: i.name, units: 0, unknown: 0, machines: [] };
        if (i.need > 0) s.units += i.need; else s.unknown++;
        s.machines.push(m.name);
        shop.set(i.productId, s);
      }
    }
    out.push({ id: m.id, name: m.name, online: m.online, due, low: items.filter(i => i.low).length, items });
  }
  return {
    rule: { percent: pct, units, capacityKnown: out.some(m => m.items.some(i => i.capacity)) },
    machines: out.sort((a, b) => Number(b.due) - Number(a.due) || b.low - a.low),
    shopping: [...shop.values()].sort((a, b) => b.units - a.units || a.name.localeCompare(b.name)),
  };
}

export function machine({ id, now = new Date(), markets, inventory, planograms, products, days, restocks, onlineLog }) {
  const m = markets?.machines?.[id];
  if (!m) return null;
  const inv = inventory?.machines?.[id];
  const racks = new Map();
  for (const [pid, p] of Object.entries(inv?.products || {})) {
    const name = productName(products, inventory, pid);
    if (!p.racks?.length) { const r = racks.get('—') || []; r.push({ productId: pid, name, stock: p.stock }); racks.set('—', r); continue; }
    for (const rk of p.racks) { const r = racks.get(rk.name || '—') || []; r.push({ productId: pid, name, stock: rk.stock }); racks.set(rk.name || '—', r); }
  }
  const recent = [];
  const totals = { today: blank(), week: blank() }, today = centralDay(now);
  for (const [day, sales] of Object.entries(days || {})) {
    for (const s of Object.values(sales)) {
      if (s.marketId !== id) continue;
      if (day === today) add(totals.today, s);
      add(totals.week, s);
      recent.push({ ...s, figures: saleFigures(s) });
    }
  }
  return {
    machine: m, totals,
    stockPct: stockPercent(inv, planograms?.machines?.[id]?.capacity),
    racks: [...racks.entries()].map(([rack, items]) => ({ rack, items: items.sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.rack.localeCompare(b.rack, undefined, { numeric: true })),
    recent: recent.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 60),
    restocks: restocks.filter(r => r.marketId === id).sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1)).slice(0, 30),
    online: (onlineLog?.events || []).filter(e => e.marketId === id).slice(-50).reverse(),
  };
}
