// Node.js test for parseAlcbV2Text — extracted directly from content.js.
// No build step, no dependencies. Non-zero exit code on failure.

const fs = require('fs');
const path = require('path');

const contentPath = path.join(__dirname, '..', 'content.js');
const src = fs.readFileSync(contentPath, 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf('function ' + name);
  if (start < 0) throw new Error(name + ' not found in content.js');
  let depth = 0;
  let started = false;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    const c = source[i];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') { depth--; if (started && depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error('closing brace for ' + name + ' not found');
}

const fnSrc = extractFunction(src, 'parseAlcbV2Text');
const parse = new Function(fnSrc + '\nreturn parseAlcbV2Text;')();

let passed = 0, failed = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.error('  FAIL ' + name + '\n         expected: ' + e + '\n         actual:   ' + a); }
}

function shape(r) {
  if (r === null) return null;
  return { kind: r.kind, id: r.id, complete: r.complete, code: r.code, error: r.error || null };
}

console.log('parseAlcbV2Text');

eq('plain bash complete',
  shape(parse('ALCB/2 kind=bash id=a1\necho hi\nALCB/END id=a1')),
  { kind:'bash', id:'a1', complete:true, code:'echo hi', error:null });

eq('plain python complete',
  shape(parse('ALCB/2 kind=python id=p1\nprint(1)\nALCB/END id=p1')),
  { kind:'python', id:'p1', complete:true, code:'print(1)', error:null });

eq('hash bash complete',
  shape(parse('#ALCB/2 kind=bash id=a2\necho hi\n#ALCB/END id=a2')),
  { kind:'bash', id:'a2', complete:true, code:'echo hi', error:null });

eq('hash+space complete',
  shape(parse('# ALCB/2 kind=bash id=a3\necho hi\n# ALCB/END id=a3')),
  { kind:'bash', id:'a3', complete:true, code:'echo hi', error:null });

eq('leading spaces + hash',
  shape(parse('   #ALCB/2 kind=bash id=a4\necho hi\n   #ALCB/END id=a4')),
  { kind:'bash', id:'a4', complete:true, code:'echo hi', error:null });

eq('python with hash',
  shape(parse('#ALCB/2 kind=python id=p2\nprint(2)\n#ALCB/END id=p2')),
  { kind:'python', id:'p2', complete:true, code:'print(2)', error:null });

eq('timeout seconds accepted',
  shape(parse('#ALCB/2 kind=bash id=t1 timeout=10s\nx\n#ALCB/END id=t1')).complete,
  true);

eq('timeout ms accepted',
  shape(parse('#ALCB/2 kind=bash id=t2 timeout=500ms\nx\n#ALCB/END id=t2')).complete,
  true);

eq('streaming without END -> null',
  parse('ALCB/2 kind=bash id=s1\necho hi'),
  null);

eq('hash streaming without END -> null',
  parse('#ALCB/2 kind=bash id=s2\necho hi'),
  null);

eq('prefix footer treated as streaming',
  shape(parse('ALCB/2 kind=bash id=pf-001\nx\nALCB/END id=pf')),
  { kind:'bash', id:'pf-001', complete:false, code:'', error:null });

eq('id mismatch',
  shape(parse('ALCB/2 kind=bash id=m1\nx\nALCB/END id=m2')).error,
  'ALCB/2 id mismatch: BEGIN=m1, END=m2');

eq('empty payload',
  shape(parse('ALCB/2 kind=bash id=e1\n   \nALCB/END id=e1')).error,
  'ALCB/2 payload is empty');

eq('plain text -> null',
  parse('just some markdown\nno alcb here'),
  null);

eq('unknown kind -> null',
  parse('ALCB/2 kind=ruby id=r1\nputs 1\nALCB/END id=r1'),
  null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
