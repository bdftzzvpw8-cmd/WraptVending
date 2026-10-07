/* =====================================================================
   WRAPT — the one place that talks to the Claude API
   ---------------------------------------------------------------------
   • Daily call budget shared by every caller (inbox extraction, smart notes,
     photo reads, morning drafts): AGENT_DAILY_LLM_MAX, default 200 calls per
     Central day, counted in Blobs ("wrapt-agents" → llm/day/<YYYY-MM-DD>).
     Over budget → throws err.code = 'BUDGET'; callers fall back or return 429.
   • One retry on 429 / 503 / 529, honoring retry-after (capped at 5s), only if
     the deadline leaves room for it.
   • Refusals and truncated replies are errors, never parsed.
   ===================================================================== */
const API = 'https://api.anthropic.com/v1/messages';
const RETRY = new Set([429, 503, 529]);

let budgetStore = null;
export function setBudgetStore(s) { budgetStore = s; } // tests
async function getBudgetStore() {
  if (budgetStore) return budgetStore;
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'wrapt-agents', consistency: 'strong' });
}
const centralDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const dailyMax = () => Math.max(0, +(process.env.AGENT_DAILY_LLM_MAX || 200));

export async function budgetLeft(now = new Date()) {
  try { const s = await getBudgetStore(); return Math.max(0, dailyMax() - ((await s.get(`llm/day/${centralDay(now)}`, { type: 'json' }))?.n || 0)); }
  catch { return dailyMax(); }
}
export async function takeBudget(now = new Date()) {
  const max = dailyMax(), key = `llm/day/${centralDay(now)}`;
  let s; try { s = await getBudgetStore(); } catch { return; } // no store (local run) → don't block
  let n = 0; try { n = (await s.get(key, { type: 'json' }))?.n || 0; } catch { /* unreadable → count from 0 */ }
  if (n >= max) { const e = new Error(`Daily AI limit reached (${max} calls, AGENT_DAILY_LLM_MAX) — it resets at midnight Central.`); e.code = 'BUDGET'; throw e; }
  try { await s.setJSON(key, { n: n + 1 }); } catch { /* best effort */ }
}

export const isHaiku = model => /haiku/i.test(String(model || ''));

// Synchronous endpoints (note-ai, photo-ai) must answer before Netlify's default 10s sync limit, or the phone
// gets a bare timeout page instead of JSON. If the site's function timeout is raised, raise this with
// CLAUDE_SYNC_TIMEOUT_MS. Background callers (inbox extraction, drafts) pass their own longer timeoutMs.
export const syncTimeoutMs = () => Math.max(1000, +(process.env.CLAUDE_SYNC_TIMEOUT_MS || 9500));

/* body: a Messages API request body. Returns the parsed response JSON. */
export async function claudeCall(body, { apiKey, timeoutMs = syncTimeoutMs(), now = new Date() } = {}) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  await takeBudget(now);
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), Math.max(1000, deadline - Date.now()));
    let r, j;
    try {
      r = await fetch(API, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
      j = await r.json().catch(() => null);
    } catch (e) { throw new Error(e.name === 'AbortError' ? `claude: timed out after ${Math.round(timeoutMs / 1000)}s` : `claude: ${e.message}`); }
    finally { clearTimeout(t); }
    if (!r.ok) {
      const wait = Math.min(5000, Math.max(500, (+r.headers.get('retry-after') || 1) * 1000));
      if (attempt === 0 && RETRY.has(r.status) && deadline - Date.now() > wait + 4000) { await new Promise(res => setTimeout(res, wait)); continue; }
      throw new Error(`claude: HTTP ${r.status} ${j?.error?.message || ''}`.trim());
    }
    if (j?.stop_reason === 'refusal' || j?.stop_reason === 'max_tokens') throw new Error(`claude: stopped (${j.stop_reason})`);
    return j;
  }
}
export const textOf = j => (j?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
