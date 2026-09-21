// Wrapt Command patch — Sept 21 2026. Each edit: exact find -> replace. `all:true` replaces every occurrence.
module.exports = [
{ name: '1. Prospect cards keep their saved email after reload',
  find: "metaPhone:meta[p.id]?.phone||'',",
  replace: "metaPhone:meta[p.id]?.phone||'',metaEmail:meta[p.id]?.email||''," },

{ name: '2. Decision-maker, contact-quality and reach helpers; greeting uses decision-maker first name',
  find: "function firstOf(d){return firstName(d.name||'')||'there';}",
  replace: [
"function dmOf(l){const m=/Decision-makers: ([^\\n]+)/.exec((l&&l.note)||'');if(!m||/^none/i.test(m[1]))return null;const first=m[1].split('; ')[0];const k=first.indexOf(' (');const name=(k>0?first.slice(0,k):first).trim();const title=k>0?first.slice(k+2).replace(/\\)$/,''):'';return name?{name,title}:null;}",
"function cqOf(l){if(!l||!l.prospect)return 0;const em=!!(l.metaEmail||l.data.email||/Emails: (?!none)/.test(l.note||''));return (em?2:0)+(dmOf(l)?1:0)+((l.metaPhone||l.data.phone)?1:0);}",
"function reachOf(l){return (l.fit||0)+cqOf(l)*8;}",
"function firstOf(d,l){return (d.name?firstName(d.name):'')||(l&&dmOf(l)?firstName(dmOf(l).name):'')||'there';}"
  ].join('\n') },

{ name: '3. Proposal + follow-up emails greet the decision-maker by name',
  find: "const body=`Hi ${firstOf(d)},", replace: "const body=`Hi ${firstOf(d,l)},", all: true },

{ name: '4. Venue-specific cold intro email (mailIntro)',
  find: "/* ---------- door scripts ---------- */",
  replace: `function introLine(vt){
  vt=vt||'';
  if(/Gym|fitness|Pickleball|Ice/i.test(vt))return 'Members can grab a protein shake, electrolyte drink or a cold water on the way out: tap a card, grab it, walk off. No front-desk time, no cash, no coins.';
  if(/Apartment|Senior/i.test(vt))return 'It works as a 24/7 resident amenity for the lobby or clubroom: tap a card, grab a drink or snack, done. Your team never handles money or restocking.';
  if(/Hotel/i.test(vt))return 'Guests can grab drinks and snacks any hour: tap a card, grab, auto-checkout. It reads as your amenity, and the front desk never has to touch it.';
  if(/Office|Corporate|coworking/i.test(vt))return 'Employees and tenants get cold drinks and snacks without leaving the building: tap a card, grab, auto-checkout. Nothing for your team to manage.';
  if(/Dealership|Auto repair|Laundromat|Health clinic|Veterinary|Medical|Beauty|Salon|Tattoo/i.test(vt))return 'Customers waiting on you can grab a drink or snack themselves: tap a card, grab, auto-checkout. It makes the wait better and costs you nothing.';
  if(/Church|College|Youth|Public|Entertainment|Golf/i.test(vt))return 'Visitors and families can grab a drink or snack anytime: tap a card, grab, auto-checkout. No staff time, no cash handling.';
  return 'Customers and staff can grab a cold drink or snack anytime: tap a card, grab, auto-checkout.';
}
function mailIntro(l){
  const d=l.data,co=d.company||'your location';const em=d.email||l.metaEmail||'';
  const subj='A free smart cooler for '+co;
  const body=\`Hi \${firstOf(d,l)},

I'm Paige, owner of Wrapt, a local company here in Franklin. We place AI smart coolers in businesses around Middle Tennessee at no cost.

\${introLine(d.venue_type)}

How it works: we install it, stock it and service it every week. \${co} keeps 15% of every sale, paid monthly with a statement. There's nothing to buy and nothing to manage.

Would you be open to a quick 10-minute look? I'm happy to stop by or send details.

Paige Fryer
Owner, Wrapt
615.948.2976 · wraptvending.com\`;
  return 'mailto:'+encodeURIComponent(em)+'?cc='+encodeURIComponent(WRAPT_EMAIL)+'&subject='+encodeURIComponent(subj)+'&body='+encodeURIComponent(body);
}
/* ---------- door scripts ---------- */` },

{ name: '5. "Email intro" button on untouched prospects that have an email',
  find: "${(d.email||l.metaEmail)?`<a class=\"act\" href=\"${mailProposal(l,pd)}\">Email proposal</a>",
  replace: "${l.prospect&&l.status==='prospect'&&(d.email||l.metaEmail)?`<a class=\"act primary\" href=\"${mailIntro(l)}\">Email intro</a>`:''}\n          ${(d.email||l.metaEmail)?`<a class=\"act\" href=\"${mailProposal(l,pd)}\">Email proposal</a>" },

{ name: '6. "Ask for" decision-maker line on prospect cards',
  find: "<div class=\"l-tags\">${tags.join('')}</div>",
  replace: "${l.prospect&&dmOf(l)?`<div class=\"l-meta\" style=\"margin-top:2px\">Ask for <b>${esc(dmOf(l).name)}</b>${dmOf(l).title?' · '+esc(dmOf(l).title):''}</div>`:''}\n        <div class=\"l-tags\">${tags.join('')}</div>" },

{ name: '7. "Best contact first" sort option',
  find: '<option value="near">Nearest first</option>',
  replace: '<option value="near">Nearest first</option>\n        <option value="reach">Best contact first</option>' },

{ name: '8. Best-contact sort logic (fit + contact quality)',
  find: "else if(SORT==='near')",
  replace: "else if(SORT==='reach')arr.sort((a,b)=>(reachOf(b)-reachOf(a))||((b.fit||0)-(a.fit||0)));\n  else if(SORT==='near')" },

{ name: '9. Today suggestions weigh contact quality, not just distance',
  find: "cand.sort((a,b)=>((distOf(a)??1e9)-(distOf(b)??1e9))||((b.fit||0)-(a.fit||0)));",
  replace: "const _k=l=>reachOf(l)-Math.min(distOf(l)??15,30)*1.5;cand.sort((a,b)=>_k(b)-_k(a));" },

// ---- 10. Remove the discontinued 30-day out from the follow-up email and door scripts ----
{ name: '10a. Follow-up email: no 30-day out', find: "how the 15% works, or the 30-day out if it ever isn't a fit.", replace: "how the 15% works, or how the two-page agreement works." },
{ name: '10b. Gym pitch', find: "Costs you nothing, and there's a 30-day out if you ever want it gone.", replace: "Costs you nothing." },
{ name: '10c. Hotel pitch', find: "No cost, 30-day out.", replace: "No cost to the hotel." },
{ name: '10d. Apartment pitch', find: "There's a 30-day out. ", replace: "" },
{ name: '10e. "zero cost, 30-day out." (2 pitches)', find: "zero cost, 30-day out.", replace: "zero cost.", all: true },
{ name: '10f. "Free, with a 30-day out." (2 pitches)', find: "Free, with a 30-day out.", replace: "Free.", all: true },
{ name: '10g. Salon pitch', find: "costs you nothing, 30-day out anytime.", replace: "costs you nothing." },
{ name: '10h. Office pitch', find: "at no cost, with a 30-day out.", replace: "at no cost." },
{ name: '10i. Medical pitch', find: "and there's no cost and a 30-day out.", replace: "and there's no cost." },
{ name: '10j. Entertainment pitch', find: "No cost, no contract lock — 30-day out.", replace: "No cost to you." },
{ name: '10k. Default pitch', find: "It costs you nothing and there's a 30-day out.", replace: "It costs you nothing." },
{ name: '11. Display current names for rebranded prospects',
  find: "function buildFrom(j){",
  replace: "const RENAMES={'pros-a35':'Camden Gulch (fka Harlowe)','pros-x14':'Franklin Bridge Golf Club (fka Forrest Crossing)','pros-l04':'Nashville Laundry (fka Bellevue Coin Laundry)','pros-h29':'Comfort Suites Columbia I-65 (fka Comfort Inn)'};\nfunction buildFrom(j){" },
{ name: '11b. Use RENAMES when building prospect rows',
  find: "data:{name:'',company:p.company,",
  replace: "data:{name:'',company:(RENAMES[p.id]||p.company)," },
];
