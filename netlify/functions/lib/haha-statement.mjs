/* =====================================================================
   Host statements — a disbursement notice from Wrapt to the host
   ---------------------------------------------------------------------
   Net Gross Revenue = gross sales − sales tax − refunds − card processing fees − HAHA monthly machine fee
   Host payout       = Net Gross Revenue × host rate          (never below $0.00)
   Gross / tax / refunds come from the stored sales (see saleFigures). Card fees and the HAHA fee
   are not in the API: they come from config/settings. All math is integer cents.

   config/hosts     [{ hostId, name, marketIds: [sticker no.], rate: "0.10", type: "net_gross", contact, notes }]
   config/settings  { cardPercent: "2.9", cardFixed: "0.30", hahaMonthlyDefault: "0.00",
                      hahaMonthly: { [marketId]: "0.00" }, restockPercent: 30, restockUnits: 2 }
                    A blank fee is shown on the statement as "not configured", never silently as $0.
   ===================================================================== */
import { money, decimalToScaled, mulRate, monthDays, fmt } from './haha.mjs';
import { saleFigures } from './haha-data.mjs';

export const DEFAULT_HOSTS = [
  { hostId: 'firestone', name: 'Firestone', marketIds: [], rate: '0.10', type: 'net_gross', contact: '', notes: '' },
  { hostId: 'tqc-1', name: 'Tennessee Quick Cash #1', marketIds: [], rate: null, type: 'net_gross', contact: '', notes: 'Rate to be entered' },
  { hostId: 'tqc-2', name: 'Tennessee Quick Cash #2', marketIds: [], rate: null, type: 'net_gross', contact: '', notes: 'Rate to be entered' },
];
export const DEFAULT_SETTINGS = { cardPercent: null, cardFixed: null, hahaMonthlyDefault: null, hahaMonthly: {}, restockPercent: 30, restockUnits: 2 };
export const HOST_TYPES = ['net_gross', 'profit_split'];

const isBlank = v => v == null || v === '';
const okDecimal = (v, max) => { try { return decimalToScaled(String(v), 6) <= max * 1e6; } catch { return false; } };
const okMoney = v => { try { return money(v) >= 0 && /^\d+(\.\d{1,2})?$/.test(String(v).trim()); } catch { return false; } };

export function validateHosts(list) {
  if (!Array.isArray(list) || list.length > 50) return { error: 'hosts must be a list of at most 50' };
  const ids = new Set(), claimed = new Map(), hosts = [];
  for (const h of list) {
    const hostId = String(h?.hostId || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(hostId)) return { error: `bad hostId "${hostId}" (lowercase letters, digits, dashes)` };
    if (ids.has(hostId)) return { error: `duplicate hostId ${hostId}` };
    ids.add(hostId);
    const name = String(h.name || '').trim().slice(0, 80);
    if (!name) return { error: `${hostId}: name is required` };
    const type = h.type || 'net_gross';
    if (!HOST_TYPES.includes(type)) return { error: `${hostId}: unknown type ${type}` };
    if (!isBlank(h.rate) && !okDecimal(h.rate, 1)) return { error: `${hostId}: rate must be a decimal between 0 and 1, e.g. 0.10` };
    const marketIds = [...new Set((Array.isArray(h.marketIds) ? h.marketIds : []).map(s => String(s).trim()).filter(Boolean))];
    for (const m of marketIds) {
      if (claimed.has(m)) return { error: `machine ${m} is on both ${claimed.get(m)} and ${hostId}` };
      claimed.set(m, hostId);
    }
    hosts.push({ hostId, name, marketIds, rate: isBlank(h.rate) ? null : String(h.rate).trim(), type, contact: String(h.contact || '').slice(0, 200), notes: String(h.notes || '').slice(0, 500) });
  }
  return { hosts };
}

export function validateSettings(s) {
  if (!s || typeof s !== 'object') return { error: 'settings must be an object' };
  const out = { ...DEFAULT_SETTINGS };
  if (!isBlank(s.cardPercent)) { if (!okDecimal(s.cardPercent, 20)) return { error: 'cardPercent must be a percent like 2.9' }; out.cardPercent = String(s.cardPercent).trim(); }
  if (!isBlank(s.cardFixed)) { if (!okMoney(s.cardFixed)) return { error: 'cardFixed must be dollars like 0.30' }; out.cardFixed = String(s.cardFixed).trim(); }
  if (!isBlank(s.hahaMonthlyDefault)) { if (!okMoney(s.hahaMonthlyDefault)) return { error: 'hahaMonthlyDefault must be dollars like 25.00' }; out.hahaMonthlyDefault = String(s.hahaMonthlyDefault).trim(); }
  out.hahaMonthly = {};
  for (const [k, v] of Object.entries(s.hahaMonthly || {})) {
    if (isBlank(v)) continue;
    if (!okMoney(v)) return { error: `HAHA fee for ${k} must be dollars like 25.00` };
    out.hahaMonthly[String(k)] = String(v).trim();
  }
  const pct = Number(s.restockPercent ?? DEFAULT_SETTINGS.restockPercent), units = Number(s.restockUnits ?? DEFAULT_SETTINGS.restockUnits);
  if (!Number.isInteger(pct) || pct < 1 || pct > 99) return { error: 'restockPercent must be a whole number 1–99' };
  if (!Number.isInteger(units) || units < 0 || units > 50) return { error: 'restockUnits must be a whole number 0–50' };
  out.restockPercent = pct;
  out.restockUnits = units;
  return { settings: out };
}

const pctLabel = v => `${String(v).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;

export function buildStatement({ host, month, days, settings = DEFAULT_SETTINGS, machines = {} }) {
  if ((host.type || 'net_gross') !== 'net_gross') return { error: `${host.type} statements are not built yet` };
  if (isBlank(host.rate)) return { error: `No commission rate set for ${host.name} — add it under Settings → Hosts` };
  if (!host.marketIds?.length) return { error: `${host.name} has no machines assigned — add sticker numbers under Settings → Hosts` };
  const warnings = [], ids = new Set(host.marketIds.map(String));
  let gross = 0, tax = 0, refunds = 0, tx = 0, refundCount = 0;
  const products = new Map(), perMachine = Object.fromEntries([...ids].map(id => [id, { id, name: machines[id]?.name || id, gross: 0, tx: 0 }]));

  for (const day of monthDays(month)) {
    for (const s of Object.values(days[day] || {})) {
      if (!ids.has(s.marketId)) continue;
      const f = saleFigures(s);
      if (!f.counted) continue;
      tx++; gross += f.gross; tax += f.tax; refunds += f.refundNet;
      if (f.refunded) refundCount++;
      perMachine[s.marketId].gross += f.gross;
      perMachine[s.marketId].tx++;
      const wholeRefund = s.refund && !s.items.some(i => i.refund);
      for (const i of s.items) {
        const p = products.get(i.productId) || { productId: i.productId, name: i.name || i.productId, qty: 0, sales: 0, refundedQty: 0, refunds: 0 };
        if (i.refund || wholeRefund) { p.refundedQty += i.qty; p.refunds += i.final; } else { p.qty += i.qty; p.sales += i.final; }
        products.set(i.productId, p);
      }
    }
  }

  let card = 0, cardLabel = 'Card processing fees';
  if (isBlank(settings.cardPercent) && isBlank(settings.cardFixed)) warnings.push('Card processing fee is not configured — counted as $0.00. Set it under Settings.');
  else {
    const pct = isBlank(settings.cardPercent) ? 0 : decimalToScaled(settings.cardPercent, 6);
    const fixed = isBlank(settings.cardFixed) ? 0 : money(settings.cardFixed);
    card = mulRate(gross, pct, 8) + fixed * tx;
    cardLabel = `Card processing fees (${pctLabel(settings.cardPercent || 0)} of gross + ${fmt(fixed)} × ${tx} transactions)`;
  }
  let haha = 0;
  const missingFee = [];
  for (const id of ids) {
    const v = settings.hahaMonthly?.[id] ?? settings.hahaMonthlyDefault;
    if (isBlank(v)) missingFee.push(id); else haha += money(v);
  }
  if (missingFee.length) warnings.push(`HAHA monthly fee is not configured for ${missingFee.join(', ')} — counted as $0.00.`);

  const net = gross - tax - refunds - card - haha;
  const rateScaled = decimalToScaled(host.rate, 6);
  const payout = net > 0 ? mulRate(net, rateScaled, 6) : 0;
  if (net < 0) warnings.push('Net Gross Revenue is negative this month — no payout.');

  return {
    host: { hostId: host.hostId, name: host.name, contact: host.contact || '' },
    month, from: `${month}-01`, to: monthDays(month).at(-1),
    machines: Object.values(perMachine),
    lines: [
      { key: 'gross', label: 'Gross sales (incl. sales tax)', cents: gross },
      { key: 'tax', label: 'Sales tax', cents: -tax },
      { key: 'refunds', label: `Refunds (${refundCount} sale${refundCount === 1 ? '' : 's'}, ex-tax)`, cents: -refunds },
      { key: 'card', label: cardLabel, cents: -card },
      { key: 'haha', label: `HAHA machine fee (${ids.size} machine${ids.size === 1 ? '' : 's'})`, cents: -haha },
    ],
    net, rate: host.rate, rateLabel: pctLabel(decimalToScaled(host.rate, 6) / 1e4), payout, tx, refundCount,
    products: [...products.values()].sort((a, b) => b.sales - a.sales || b.qty - a.qty),
    warnings,
  };
}
