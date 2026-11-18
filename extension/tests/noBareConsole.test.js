// Regression test: no bare console.* calls in content.js outside of
// the one-time "content.js loaded" banner and the ALCB_DEBUG helpers.
// Any new debug print must be wrapped with `if (ALCB_DEBUG)`.

const fs = require('fs');
const path = require('path');

const contentPath = path.join(__dirname, '..', 'content.js');
const src = fs.readFileSync(contentPath, 'utf8');
const lines = src.split('\n');

let failed = 0;
const offenders = [];

for (let i = 0; i < lines.length; i++) {
  const ln = lines[i];
  // строка содержит вызов console.<method>(
  if (!/console\.(log|info|debug|warn|error)\s*\(/.test(ln)) continue;

  // разрешаем: баннер загрузки
  if (ln.includes("[ALCB] content.js loaded")) continue;

  // разрешаем: уже обёрнуто в if (ALCB_DEBUG)
  if (ln.includes('if (ALCB_DEBUG)')) continue;

  // разрешаем: строки-хелперы alcbDebug/alcbInfo/alcbWarn (они сами проверяют флаг)
  if (/function alcb(Debug|Info|Warn)\b/.test(ln)) continue;

  offenders.push({ line: i + 1, text: ln.trim() });
}

if (offenders.length === 0) {
  console.log('  ok   no bare console.* in content.js (except banner/helpers)');
} else {
  failed = offenders.length;
  console.error('  FAIL bare console.* in content.js:');
  for (const o of offenders) {
    console.error('         line ' + o.line + ': ' + o.text);
  }
}

console.log('\n' + (failed === 0 ? '1 passed, 0 failed' : '0 passed, ' + failed + ' failed'));
process.exit(failed === 0 ? 0 : 1);
