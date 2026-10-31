import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSale, saleFigures, makeWarn, planogramCapacity } from '../netlify/functions/lib/haha-data.mjs';
import { buildStatement, validateHosts, validateSettings } from '../netlify/functions/lib/haha-statement.mjs';
import { evaluate, runAlerts, emailAlerts } from '../netlify/functions/lib/haha-alerts.mjs';
import { restock, salesRange, orders, summary } from '../netlify/functions/lib/haha-views.mjs';
import { memoryStore, sale, withEnv } from './helpers.mjs';

const norm = s => normalizeSale(s, makeWarn());
const byDay = list => {
  const out = {};
  for (const s of list.map(norm)) (out[s.day] ||= {})[s.id] = s;
  return out;
};

test('a fully refunded sale nets to zero; item refunds take only the refunded lines', () => {
  const whole = norm(sale({ id: 'R', at: '2026-10-05T15:00:00Z', status: 'REFUNDED', isRefund: true }));
  const f = saleFigures(whole);
  assert.equal(f.counted, true);
  assert.equal(f.gross - f.tax - f.refundNet, 0);
  const part = norm(sale({ id: 'P', at: '2026-10-05T15:00:00Z', items: [['p1', 'Coke', 1, '2.50', true], ['p2', 'Red Bull', 1, '3.75']] }));
  assert.equal(saleFigures(part).refundNet, 250);
  assert.equal(saleFigures(part).net, 375);
  const failed = norm(sale({ id: 'F', at: '2026-10-05T15:00:00Z', status: 'FAILED' }));
  assert.equal(saleFigures(failed).counted, false);
});

test('statement: every line of the formula, refunds and tax, integer cents', () => {
  const days = byDay([
    sale({ id: 'S1', at: '2026-10-03T15:00:00Z', items: [['p1', 'Coke 20oz', 2, '2.50']] }),          // 5.00 + .49
    sale({ id: 'S2', at: '2026-10-09T15:00:00Z', items: [['p2', 'Red Bull 12oz', 1, '3.75']] }),      // 3.75 + .37
    sale({ id: 'S3', at: '2026-10-12T15:00:00Z', status: 'REFUNDED', isRefund: true }),               // 2.50 + .24, refunded
    sale({ id: 'S4', at: '2026-10-20T15:00:00Z', items: [['p1', 'Coke 20oz', 1, '2.50', true], ['p2', 'Red Bull 12oz', 1, '3.75']] }), // 6.25 + .61
    sale({ id: 'S5', at: '2026-10-21T15:00:00Z', status: 'FAILED' }),
    sale({ id: 'S6', at: '2026-10-21T15:00:00Z', marketId: '440002' }),
    sale({ id: 'S7', at: '2026-11-01T15:00:00Z' }),
  ]);
  const host = { hostId: 'firestone', name: 'Firestone', marketIds: ['440001'], rate: '0.10', type: 'net_gross' };
  const st = buildStatement({ host, month: '2026-10', days, settings: { cardPercent: '2.9', cardFixed: '0.30', hahaMonthlyDefault: '5.00', hahaMonthly: {} } });
  const line = k => st.lines.find(l => l.key === k).cents;
  assert.equal(line('gross'), 549 + 412 + 274 + 686);
  assert.equal(line('tax'), -(49 + 37 + 24 + 61));
  assert.equal(line('refunds'), -500);
  assert.equal(line('card'), -(56 + 120)); // 2.9 % of 19.21 = 0.557 → 0.56, plus 0.30 × 4
  assert.equal(line('haha'), -500);
  assert.equal(st.net, 1921 - 171 - 500 - 176 - 500);
  assert.equal(st.net, st.lines.reduce((a, l) => a + l.cents, 0));
  assert.equal(st.payout, 57); // 10 % of 5.74
  assert.equal(st.tx, 4);
  assert.equal(st.refundCount, 2);
  assert.deepEqual(st.warnings, []);
  const coke = st.products.find(p => p.productId === 'p1');
  assert.deepEqual([coke.qty, coke.sales, coke.refundedQty, coke.refunds], [2, 500, 2, 500]);
  assert.equal(st.rateLabel, '10%');
});

test('statement: unset fees are flagged, never silent; negative net pays nothing', () => {
  const days = byDay([sale({ id: 'X', at: '2026-10-03T15:00:00Z' })]);
  const host = { hostId: 'h', name: 'H', marketIds: ['440001'], rate: '0.10' };
  const st = buildStatement({ host, month: '2026-10', days, settings: { hahaMonthlyDefault: '25.00' } });
  assert.match(st.warnings.join(' '), /Card processing fee is not configured/);
  assert.ok(st.net < 0);
  assert.equal(st.payout, 0);
  assert.match(st.warnings.join(' '), /negative/);
  assert.match(buildStatement({ host: { ...host, rate: null }, month: '2026-10', days }).error, /No commission rate/);
  assert.match(buildStatement({ host: { ...host, type: 'profit_split' }, month: '2026-10', days }).error, /not built yet/);
});

test('config validation', () => {
  assert.ok(validateHosts([{ hostId: 'firestone', name: 'Firestone', marketIds: ['1'], rate: '0.10' }]).hosts);
  assert.match(validateHosts([{ hostId: 'a', name: 'A', rate: '1.5' }]).error, /between 0 and 1/);
  assert.match(validateHosts([{ hostId: 'a', name: 'A', marketIds: ['9'] }, { hostId: 'b', name: 'B', marketIds: ['9'] }]).error, /both/);
  assert.match(validateHosts([{ hostId: 'Bad Id', name: 'A' }]).error, /bad hostId/);
  assert.equal(validateSettings({ cardPercent: '2.9', cardFixed: '0.30', restockPercent: 30, restockUnits: 2 }).settings.cardPercent, '2.9');
  assert.match(validateSettings({ cardFixed: '0.305' }).error, /dollars/);
  assert.match(validateSettings({ restockPercent: 0 }).error, /1–99/);
});

test('planogram capacity is summed per product; unknown shapes give nothing', () => {
  assert.deepEqual(planogramCapacity({ doors: [{ layers: [{ slots: [{ productId: 'p1', capacity: 6 }, { productId: 'p1', capacity: '4' }] }] }] }), { p1: 10 });
  assert.deepEqual(planogramCapacity({ shelves: [{ sku: 'p1', max: 6 }] }), {});
});

/* ---------- alerts ---------- */
const NOW = new Date('2026-10-28T15:00:00Z');
const minsAgo = m => new Date(NOW.getTime() - m * 60e3).toISOString();
function fleetState() {
  return {
    markets: { machines: {
      440001: { id: '440001', name: 'Firestone', status: 'ACTIVE', online: true, since: minsAgo(3000), firstSeen: minsAgo(4000) },
      440002: { id: '440002', name: 'TQC Spring Hill', status: 'ACTIVE', online: false, since: minsAgo(45), firstSeen: minsAgo(4000) },
      440003: { id: '440003', name: 'Returned unit', status: 'RETURNED', online: false, since: minsAgo(9000), firstSeen: minsAgo(9000) },
    } },
    inventory: { machines: { 440001: { products: { p1: { stock: 2 }, p2: { stock: 0 } } } } },
    planograms: { machines: { 440001: { capacity: { p1: 12, p2: 8 } } } },
    products: { products: { p2: { name: 'Red Bull 12oz' } } },
    days: byDay([1, 2, 3].map(i => sale({ id: `RF${i}`, marketId: '440002', at: minsAgo(60 + i), status: 'REFUNDED', isRefund: true }))),
    syncState: { lastOk: minsAgo(120), lastRun: { at: minsAgo(5), errors: ['sales: HTTP 502'] } },
  };
}

test('alert rules', () => {
  const keys = evaluate({ now: NOW, ...fleetState() }).map(c => c.key).sort();
  assert.deepEqual(keys, ['low:440001', 'offline:440002', 'oos:440001:p2', 'quiet:440001', 'refunds:440002:2026-10-28', 'sync:failing']);
  const s = fleetState();
  s.markets.machines['440002'].since = minsAgo(20); // offline only 20 min
  assert.ok(!evaluate({ now: NOW, ...s }).some(c => c.key === 'offline:440002'));
});

test('alerts fire once per condition, clear, and email only what is new', async () => withEnv({ HAHA_ALERT_TO: 'ops@example.com' }, async () => {
  const store = memoryStore(), s = fleetState();
  await store.setJSON('markets/latest', s.markets);
  await store.setJSON('inventory/latest', s.inventory);
  await store.setJSON('planograms/latest', s.planograms);
  await store.setJSON('products/latest', s.products);
  for (const [d, sales] of Object.entries(s.days)) await store.setJSON(`sales/${d}`, { day: d, sales });

  const a1 = await runAlerts({ store, now: NOW, syncState: s.syncState });
  assert.equal(a1.raised.length, 6);
  const sent = [];
  const transport = { sendMail: async m => { sent.push(m); } };
  const m1 = await emailAlerts({ store, now: NOW, events: a1.events, transport, from: 'alerts@example.com' });
  assert.equal(m1.sent, true);
  assert.match(sent[0].text, /TQC Spring Hill offline/);

  const a2 = await runAlerts({ store, now: new Date(NOW.getTime() + 15 * 60e3), syncState: s.syncState });
  assert.equal(a2.raised.length, 0, 'an open condition notified again');
  assert.equal((await emailAlerts({ store, events: a2.events, transport })).skipped, 'nothing new');

  const back = structuredClone(s.markets);
  back.machines['440002'].online = true;
  await store.setJSON('markets/latest', back);
  const a3 = await runAlerts({ store, now: new Date(NOW.getTime() + 30 * 60e3), syncState: { ...s.syncState, lastOk: new Date(NOW.getTime() + 30 * 60e3).toISOString() } });
  const texts = a3.events.map(e => e.text);
  assert.ok(texts.some(t => /TQC Spring Hill back online/.test(t)));
  assert.ok(texts.includes('HAHA sync recovered'));
  assert.equal(store.json('alerts/feed').events.length, a1.events.length + a3.events.length);
}));

/* ---------- views ---------- */
test('restock: percent of capacity when known, units rule otherwise; combined shopping list', () => {
  const r = restock({
    markets: { machines: { a: { id: 'a', name: 'A', online: true }, b: { id: 'b', name: 'B', online: true } } },
    inventory: { machines: { a: { products: { p1: { stock: 2 }, p2: { stock: 7 } } }, b: { products: { p1: { stock: 2 }, p3: { stock: 9 } } } } },
    planograms: { machines: { a: { capacity: { p1: 12, p2: 8 } } } },
    products: { products: { p1: { name: 'Coke' }, p2: { name: 'Water' }, p3: { name: 'Chips' } } },
    settings: { restockPercent: 30, restockUnits: 2 },
  });
  const a = r.machines.find(m => m.id === 'a');
  assert.equal(a.due, true);
  assert.deepEqual(a.items.map(i => [i.name, i.low, i.need]), [['Coke', true, 10], ['Water', false, 1]]);
  const b = r.machines.find(m => m.id === 'b');
  assert.deepEqual(b.items.filter(i => i.low).map(i => i.name), ['Coke']);
  const coke = r.shopping.find(s => s.productId === 'p1');
  assert.deepEqual([coke.units, coke.unknown], [10, 1]);
  assert.equal(r.shopping.find(s => s.productId === 'p2').units, 1); // topping up a due machine fully
});

test('every sales number traces back to its orders', () => {
  const list = [
    sale({ id: 'T1', at: '2026-10-27T15:00:00Z' }), sale({ id: 'T2', at: '2026-10-28T15:00:00Z', items: [['p2', 'Red Bull', 2, '3.75']] }),
    sale({ id: 'T3', at: '2026-10-28T16:00:00Z', marketId: '440002', isRefund: true, status: 'REFUNDED' }),
  ];
  const days = byDay(list);
  const r = salesRange({ from: '2026-10-27', to: '2026-10-28', days, markets: null });
  assert.equal(r.totals.net, r.machines.reduce((a, m) => a + m.total.net, 0));
  for (const d of r.days) {
    const o = orders({ day: d, days });
    assert.equal(r.byDay[d].net, o.reduce((a, s) => a + s.figures.net, 0));
    assert.equal(r.byDay[d].gross, o.filter(s => s.figures.counted).reduce((a, s) => a + s.gross, 0));
  }
  assert.equal(r.totals.refunds, 1);
  assert.equal(r.top[0].productId, 'p2');
  const s = summary({ now: NOW, markets: { machines: { 440001: { id: '440001', name: 'F', status: 'ACTIVE', online: true } } }, days, syncState: { lastOk: NOW.toISOString() } });
  assert.equal(s.totals.today.net, 750);
  assert.equal(s.totals.week.net, 1000);
  assert.equal(s.sync.stale, false);
});
