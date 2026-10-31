// Test doubles: an in-memory Blobs store and a fake HAHA Open Platform built from the roadmap's response shapes.
// The fake is only for exercising our code paths — it is not a statement of what HAHA actually returns.
import { centralDay } from '../netlify/functions/lib/haha.mjs';

export function memoryStore() {
  const m = new Map(), writes = [];
  return {
    data: m, writes, failGet: null,
    async get(k, opts) {
      if (this.failGet && this.failGet.test(k)) throw new Error(`simulated read failure: ${k}`);
      if (!m.has(k)) return null;
      return opts?.type === 'json' ? JSON.parse(m.get(k)) : m.get(k);
    },
    async setJSON(k, v) { writes.push(k); m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '' } = {}) { return { blobs: [...m.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
    json(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
  };
}

const ok = data => new Response(JSON.stringify({ code: 0, message: 'success', data }), { status: 200, headers: { 'content-type': 'application/json' } });

export function fixture() {
  return {
    markets: [
      { marketId: '440001', marketName: 'Firestone Franklin', marketLocation: 'Franklin, TN', timeZone: 'America/Chicago', status: 'ACTIVE', isOnline: true, deviceType: 'HAHA440', activationDate: '2026-09-01' },
      { marketId: '440002', marketName: 'TQC Spring Hill', marketLocation: 'Spring Hill, TN', timeZone: 'America/Chicago', status: 'ACTIVE', isOnline: false, deviceType: 'HAHA440', activationDate: '2026-09-15' },
    ],
    products: [
      { productId: 'p1', productName: 'Coke 20oz', price: '2.50', cost: '1.10' },
      { productId: 'p2', productName: 'Red Bull 12oz', price: '3.75', cost: '1.90' },
    ],
    inventory: [
      { productId: 'p1', productName: 'Coke 20oz', totalStock: 9, markets: [
        { marketId: '440001', marketName: 'Firestone Franklin', stock: 7, racks: [{ name: 'Door 1 · Shelf 2', stock: 7 }] },
        { marketId: '440002', marketName: 'TQC Spring Hill', stock: 2, racks: [{ name: 'Door 1 · Shelf 1', stock: 2 }] },
      ] },
      { productId: 'p2', productName: 'Red Bull 12oz', totalStock: 0, markets: [
        { marketId: '440001', marketName: 'Firestone Franklin', stock: 0, racks: [{ name: 'Door 1 · Shelf 3', stock: 0 }] },
      ] },
    ],
    planograms: {
      440001: { doors: [{ layers: [{ slots: [{ productId: 'p1', capacity: 12 }, { productId: 'p2', capacity: 8 }] }] }] },
      440002: { doors: [{ layers: [{ slots: [{ productId: 'p1', capacity: 10 }] }] }] },
    },
    sales: [],
    restocks: [{ opLogId: 'op-1', marketId: '440001', note: 'weekly' }],
  };
}

let saleSeq = 0;
// a sale in the roadmap's /sales shape: items [[productId, name, qty, price, refund?]]
export function sale({ id, marketId = '440001', at, status = 'PAID', isRefund = false, items = [['p1', 'Coke 20oz', 1, '2.50']], taxRate = '0.0975' }) {
  const lines = items.map(([productId, productName, quantity, price, refund]) => {
    const sub = (Math.round(Number(price) * 100) * quantity);
    return { productId, productName, quantity, price, itemSubTotal: (sub / 100).toFixed(2), itemFinalPrice: (sub / 100).toFixed(2), saleTaxes: '0.00', isRefund: !!refund };
  });
  const net = lines.reduce((a, l) => a + Math.round(Number(l.itemFinalPrice) * 100), 0);
  const tax = Math.round(net * Number(taxRate));
  return {
    saleId: id || `S${++saleSeq}`, marketId, saleDtm: at, status, isRefund,
    saleTotal: (net / 100).toFixed(2), saleTaxes: (tax / 100).toFixed(2), saleGrossTotal: ((net + tax) / 100).toFixed(2),
    saleTenders: [{ type: 'CARD', amount: ((net + tax) / 100).toFixed(2) }], saleItems: lines,
    transactions: [{ providerTransactionID: `T${saleSeq}`, amount: ((net + tax) / 100).toFixed(2), Date: at }],
  };
}

// fetchImpl for the fake platform. opts.endInclusive picks how end_time is read; opts.pageMode drops cursors.
export function mockHaha(data, opts = {}) {
  const calls = [], counters = { token: 0 };
  let tokenSeq = 0;
  const page = (list, q) => {
    const size = Math.min(100, Number(q.get('page_size')) || 20);
    const start = q.get('cursor') ? Number(q.get('cursor').slice(1)) : (Number(q.get('page') || 1) - 1) * size;
    const slice = list.slice(start, start + size);
    const more = start + size < list.length;
    return { list: slice, total: list.length, page: Math.floor(start / size) + 1, page_size: size, ...(more && !opts.pageMode ? { next_cursor: `c${start + size}` } : {}) };
  };
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input)), path = url.pathname, method = (init.method || 'GET').toUpperCase();
    calls.push({ method, path, query: Object.fromEntries(url.searchParams), auth: init.headers?.authorization || null });
    if (opts.fail) { const r = opts.fail({ method, path, query: url.searchParams, n: calls.length }); if (r) { if (r instanceof Error) throw r; return r; } }
    if (path === '/open/auth/token') {
      counters.token++;
      const body = JSON.parse(init.body);
      if (body.appkey !== process.env.HAHA_APPKEY || body.appsecret !== process.env.HAHA_APPSECRET) return new Response(JSON.stringify({ code: 401, message: 'bad credentials' }), { status: 401 });
      return ok({ token: `tok-${++tokenSeq}`, token_type: 'Bearer', expires_at: Math.floor((opts.now?.() ?? Date.now()) / 1000) + 15 * 86400 });
    }
    if (!init.headers?.authorization?.startsWith('Bearer tok-')) return new Response('{}', { status: 401 });
    if (opts.revoked && init.headers.authorization === `Bearer ${opts.revoked}`) return new Response('{}', { status: 401 });
    const p = path.replace('/open/api/v1', ''), q = url.searchParams;
    if (p === '/markets') return ok(page(data.markets, q));
    if (p === '/products') return ok(page(data.products, q));
    if (p === '/inventory/products') return ok(page(data.inventory, q));
    if (p === '/restock/records') return ok(page(data.restocks, q));
    let m;
    if ((m = /^\/markets\/([^/]+)\/planograms$/.exec(p))) return ok(data.planograms[decodeURIComponent(m[1])] || {});
    if (p === '/sales') {
      const s = q.get('start_time'), e = q.get('end_time');
      const list = data.sales.filter(x => { const d = centralDay(x.saleDtm); return d >= s && (opts.endInclusive ? d <= e : d < e); });
      return ok(page(list, q));
    }
    return new Response(JSON.stringify({ code: 404, message: 'not found' }), { status: 404 });
  };
  return { fetchImpl, calls, counters };
}

export const noSleep = async () => {};
export function withEnv(vars, fn) {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  const restore = () => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } };
  let r;
  try { r = fn(); } catch (e) { restore(); throw e; }
  return r && typeof r.then === 'function' ? r.finally(restore) : (restore(), r);
}
