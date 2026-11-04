import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSale, saleFigures, makeWarn } from '../netlify/functions/lib/haha-data.mjs';
import { buildStatement } from '../netlify/functions/lib/haha-statement.mjs';
import { salesRange, orders } from '../netlify/functions/lib/haha-views.mjs';
import { sale } from './helpers.mjs';

const norm = s => normalizeSale(s, makeWarn());
// A sale as HAHA has really sent them since Oct 31, 2026: PAID, a real card tender, sale-level totals all 0.
const zeroed = (over = {}, edit = r => r) => {
  const raw = sale({ id: 'Z', at: '2026-11-03T18:34:00Z', items: [['p1', 'Mountain Dew', 1, '2.50']], ...over });
  raw.saleTotal = '0.00'; raw.saleTaxes = '0.00'; raw.saleGrossTotal = '0.00';
  return norm(edit(raw));
};
const byDay = list => {
  const out = {};
  for (const s of list) (out[s.day] ||= {})[s.id] = s;
  return out;
};

test('zero sale totals with a paid card tender: gross is the tender, net the list price, tax the difference, marked derived', () => {
  const f = saleFigures(zeroed());
  assert.equal(f.counted, true);
  assert.equal(f.gross, 274);      // fixture tender = 2.50 + 9.75% tax
  assert.equal(f.net, 250);
  assert.equal(f.tax, 24);
  assert.equal(f.derived, true);
  assert.equal(f.gross - f.tax, f.net);
});

test('a sale HAHA fills in is used exactly as sent and is not marked derived', () => {
  const s = norm(sale({ id: 'N', at: '2026-11-03T18:34:00Z' }));
  const f = saleFigures(s);
  assert.equal(f.derived, false);
  assert.equal(f.gross, s.gross);
  assert.equal(f.net, s.net);
  assert.equal(f.tax, s.tax);
});

test('partly filled totals are not touched (only all-zero totals trigger the fallback)', () => {
  const s = zeroed({}, r => { r.saleTotal = '2.50'; return r; });
  const f = saleFigures(s);
  assert.equal(f.derived, false);
  assert.equal(f.gross, 0);
  assert.equal(f.net, 250);
});

test('zero totals and no tender stay zero (a free vend is not invented into revenue)', () => {
  const f = saleFigures(zeroed({}, r => { r.saleTenders = []; return r; }));
  assert.equal(f.counted, true);
  assert.deepEqual([f.gross, f.net, f.tax, f.derived], [0, 0, 0, false]);
  const free = saleFigures(zeroed({}, r => { r.saleTenders = [{ type: 'CARD', amount: '0.00' }]; return r; }));
  assert.deepEqual([free.gross, free.net, free.tax, free.derived], [0, 0, 0, false]);
});

test('a failed sale counts for nothing even with a tender', () => {
  const f = saleFigures(zeroed({ status: 'FAILED' }));
  assert.equal(f.counted, false);
  assert.deepEqual([f.gross, f.net, f.tax, f.derived], [0, 0, 0, false]);
});

test('a discount: net never exceeds the tender, so tax is never negative', () => {
  const f = saleFigures(zeroed({}, r => { r.saleTenders = [{ type: 'CARD', amount: '2.00' }]; return r; }));
  assert.equal(f.gross, 200);
  assert.equal(f.net, 200);
  assert.equal(f.tax, 0);
});

test('no readable item prices: the whole tender is net, no tax is invented', () => {
  const f = saleFigures(zeroed({ items: [['p1', 'Mystery', 1, '0.00']] }, r => { r.saleTenders = [{ type: 'CARD', amount: '2.74' }]; return r; }));
  assert.deepEqual([f.gross, f.net, f.tax], [274, 274, 0]);
});

test('a refunded derived sale nets to zero', () => {
  const f = saleFigures(zeroed({ status: 'REFUNDED', isRefund: true }));
  assert.equal(f.derived, true);
  assert.equal(f.gross - f.tax - f.refundNet, 0);
});

test('statement: Net Gross Revenue and the host payout are no longer $0.00 for zero-total sales', () => {
  const days = byDay([
    zeroed({ id: 'A', at: '2026-11-03T18:34:00Z' }),
    zeroed({ id: 'B', at: '2026-11-03T18:51:00Z', items: [['p2', 'Doritos', 1, '2.00'], ['p3', 'Sprite', 1, '2.50']] }),
  ]);
  const host = { hostId: 'firestone', name: 'Firestone', marketIds: ['440001'], rate: '0.10', type: 'net_gross' };
  const st = buildStatement({ host, month: '2026-11', days, settings: { cardPercent: '0', cardFixed: '0', hahaMonthlyDefault: '0', hahaMonthly: {} } });
  const line = k => st.lines.find(l => l.key === k).cents;
  assert.equal(line('gross'), 274 + 494);   // each tender is the fixture's net plus 9.75% tax: 2.50 -> 2.74, 4.50 -> 4.94
  assert.equal(line('tax'), -(24 + 44));
  assert.equal(st.net, 274 + 494 - 24 - 44);
  assert.equal(st.payout, Math.round((274 + 494 - 24 - 44) * 0.10), `payout should be 10% of net, got ${st.payout}`);
});

test('sales range and orders show the derived totals and flag them', () => {
  const days = byDay([zeroed({ id: 'A', at: '2026-11-03T18:34:00Z' })]);
  const r = salesRange({ from: '2026-11-03', to: '2026-11-03', days, markets: null });
  assert.equal(r.totals.gross, 274);
  assert.equal(r.totals.net, 250);
  assert.equal(r.totals.tax, 24);
  assert.equal(r.totals.tx, 1);
  const o = orders({ day: '2026-11-03', days })[0];
  assert.equal(o.figures.derived, true);
  // the order record itself agrees with the totals, so nothing downstream still sees a $0 order
  assert.deepEqual([o.gross, o.net, o.tax], [274, 250, 24]);
});

test('an order HAHA filled in keeps its own gross, net and tax in the order list', () => {
  const s = norm(sale({ id: 'N', at: '2026-11-03T18:34:00Z' }));
  const o = orders({ day: s.day, days: byDay([s]) })[0];
  assert.equal(o.figures.derived, false);
  assert.deepEqual([o.gross, o.net, o.tax], [s.gross, s.net, s.tax]);
});
