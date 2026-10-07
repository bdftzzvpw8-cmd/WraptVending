/* WRAPT PHOTO READER — Claude vision over a lead's photos, or a receipt before it's logged.
     POST {pids:[...], lead:{...}}   → reads up to 3 stored photos (fetched server-side by id with the dash key)
                                      → {readings:[...], lines:[...], patch:{note?, email?, phone?}}
     POST {image:"data:image/jpeg;base64,...", mode:"receipt"}  → {readings:[{type:'receipt', receipt:{vendor,date,total,category,items}}]}
   Nothing is written — Command applies the patch through saveMeta, or fills the expense form. */
import { CFG, authOk, json, useSite } from './lib/wrapt-agents.mjs';
import { readPhotos, photoPatch, leadFromClient, llmReady } from './lib/notes.mjs';

async function fetchPhoto(pid) {
  const r = await fetch(`${CFG.site}/.netlify/functions/photo?id=${encodeURIComponent(pid)}`, { headers: { 'X-Dash-Key': CFG.dashKey } });
  if (!r.ok) throw new Error(`photo ${pid}: HTTP ${r.status}`);
  const ct = (r.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (ct.includes('json') || buf.subarray(0, 5).toString() === 'data:') { // some builds return the data URL
    const s = buf.toString(); const m = /data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)/.exec(s);
    if (!m) throw new Error(`photo ${pid}: unreadable`);
    return { media_type: m[1], data: m[2] };
  }
  return { media_type: ct.startsWith('image/') ? ct.split(';')[0] : 'image/jpeg', data: buf.toString('base64') };
}
function fromDataUrl(s) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) throw new Error('image must be a base64 data URL');
  return { media_type: m[1], data: m[2] };
}

export default async (req, context) => {
  if (!authOk(req)) return json({ error: 'unauthorized' }, 401);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!llmReady()) return json({ error: 'ANTHROPIC_API_KEY is not set on the site — photo reading needs it.' }, 503);
  useSite(context);
  let b = {}; try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  try {
    let images = [];
    if (b.image) images = [fromDataUrl(b.image)];
    else images = await Promise.all((b.pids || []).slice(0, 3).map(fetchPhoto));
    if (!images.length) return json({ error: 'no photos' }, 400);
    const lead = b.lead ? leadFromClient(b.lead) : null;
    const readings = await readPhotos(images, { lead, now: new Date() });
    if (b.mode === 'receipt' || !lead) return json({ readings });
    const { patch, lines } = photoPatch(lead, readings, { now: new Date() });
    return json({ readings, lines, patch });
  } catch (e) { return json({ error: e.message }, 502); }
};
