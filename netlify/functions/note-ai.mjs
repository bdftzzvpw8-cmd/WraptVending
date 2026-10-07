/* WRAPT SMART NOTE — dictated or typed field text → a proposed card update.
     POST /.netlify/functions/note-ai  {text, lead:{id, co, venue, city, status, note, followup, email, phone, coi}}
     → {lines:[...], patch:{note, followup?, coi?, email?, phone?, status?}, suggestion:{status, reason}|null, extract}
   Nothing is written here — Command shows the proposal and saves it through its own saveMeta when Paige taps Save. */
import { authOk, json } from './lib/wrapt-agents.mjs';
import { extractNote, buildPatch, leadFromClient, llmReady } from './lib/notes.mjs';

export default async (req) => {
  if (!authOk(req)) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!llmReady()) return json({ error: 'ANTHROPIC_API_KEY is not set on the site — smart notes need it.' }, 503);
  let b = {}; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const text = String(b.text || '').trim();
  if (text.length < 3) return json({ error: 'nothing to file' }, 400);
  const lead = leadFromClient(b.lead || {});
  try {
    const ex = await extractNote({ kind: 'dictation', text, lead, now: new Date() });
    const { patch, lines, suggestion } = buildPatch(lead, ex, { kind: 'dictation', now: new Date(), auto: false });
    return json({ lines, patch, suggestion, extract: ex });
  } catch (e) { return json({ error: e.message }, e.code === 'BUDGET' ? 429 : 502); }
};
