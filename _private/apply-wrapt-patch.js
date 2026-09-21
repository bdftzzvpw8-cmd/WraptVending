// Usage:  node apply-wrapt-patch.js path\to\command.html
// Writes command.patched.html next to it and prints which edits applied. Never touches the original.
const fs = require('fs'), path = require('path');
const file = process.argv[2]; if (!file) { console.error('usage: node apply-wrapt-patch.js command.html'); process.exit(1); }
let src = fs.readFileSync(file, 'utf8'); const edits = require('./edits.js');
let applied = 0, skipped = [];
for (const e of edits) {
  const n = src.split(e.find).length - 1;
  if (n === 0) { skipped.push(e.name + (src.includes(e.replace) ? '  (already applied)' : '  (anchor not found)')); continue; }
  if (n > 1 && !e.all) { skipped.push(e.name + `  (anchor found ${n}x, expected 1)`); continue; }
  src = src.split(e.find).join(e.replace); applied++; console.log('  applied  ' + e.name + (n > 1 ? ` (${n}x)` : ''));
}
skipped.forEach(s => console.log('  SKIPPED  ' + s));
const out = path.join(path.dirname(file), 'command.patched.html'); fs.writeFileSync(out, src);
console.log(`\n${applied}/${edits.length} edits applied -> ${out}`);
