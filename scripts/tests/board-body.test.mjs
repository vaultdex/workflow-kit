import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, issue, test } from './board-fixture.mjs';


test('body writes an issue body only on top of the one it is based on and proves the write', t => {
  const { checkout, run } = fixture(t);
  const file = (name, text) => { writeFileSync(join(checkout, name), text); return name; };
  const server = (body, extra = {}) => writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0, body, ...extra }));
  const stored = () => JSON.parse(readFileSync(join(checkout, 'backlink-1.json'), 'utf8')).body;
  const patches = () => existsSync(join(checkout, 'patches')) ? readFileSync(join(checkout, 'patches'), 'utf8').split('\n').filter(Boolean).length : 0;
  const reset = () => { rmSync(join(checkout, 'patches'), { force: true }); rmSync(join(checkout, 'body-overwritten'), { force: true }); };
  const change = file('change.md', 'neu\nzeile\n'), base = file('base.md', 'alt\nzeile\n');

  // Unchanged since it was read (GitHub may return CRLF): written once and read back.
  server('alt\r\nzeile');
  let result = run('body', '1', change, base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|neu\nzeile');

  // Changed by another session before the write: nothing is written, the difference is shown.
  reset();
  server('alt\nvon einer anderen Session ergänzt');
  result = run('body', '1', change, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED$/m);
  assert.match(result.stdout, /von einer anderen Session ergänzt/, 'The current text is part of the diff');
  assert.equal([patches(), stored()].join('|'), '0|alt\nvon einer anderen Session ergänzt');

  // Overwritten right after the write: the read-back reports it, and the write is not repeated.
  reset();
  server('alt\nzeile');
  writeFileSync(join(checkout, 'body-overwritten'), 'Fassung der anderen Session');
  result = run('body', '1', change, base);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /^FAILED$/m);
  assert.match(result.stdout, /Fassung der anderen Session/);
  assert.equal(patches(), 1);

  // A file named "-" must not be taken for stdin: the text that was read is written, never an empty body.
  reset();
  server('alt\nzeile');
  file('-', 'neu aus Datei namens minus\n');
  result = run('body', '1', '-', base);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|neu aus Datei namens minus');
  rmSync(join(checkout, '-'));

  // Already the wanted text: no write at all.
  reset();
  server('neu\nzeile');
  assert.equal(run('body', '1', change, change).status, 0);
  assert.equal(patches(), 0);

  // A pull request answers under its number as well (with a pull_request key): its description is never replaced.
  reset();
  server('alt\nzeile', { pull_request: { url: 'x' } });
  assert.equal(run('body', '1', change, base).status, 2);
  server('alt\nzeile', { number: 2 });
  assert.equal(run('body', '1', change, base).status, 2, 'A different number is not the requested issue');
  assert.equal(patches(), 0);

  // Unreadable input and API errors are errors, never a written body.
  reset();
  server('alt\nzeile');
  assert.equal(run('body', '1', 'missing.md', base).status, 2);
  assert.equal(run('body', '1', change).status, 2, 'The base the change rests on is required');
  writeFileSync(join(checkout, 'fail-rest'), '');
  assert.equal(run('body', '1', change, base).status, 2);
  assert.equal(patches(), 0);
});

test('body-replace replaces exactly one match of the text and writes nothing for none or several', t => {
  const { checkout, run } = fixture(t);
  const file = (name, text) => { writeFileSync(join(checkout, name), text); return name; };
  const server = body => writeFileSync(join(checkout, 'backlink-1.json'), JSON.stringify({ number: 1, state: 'open', comments: 0, body }));
  const stored = () => JSON.parse(readFileSync(join(checkout, 'backlink-1.json'), 'utf8')).body;
  const patches = () => existsSync(join(checkout, 'patches')) ? readFileSync(join(checkout, 'patches'), 'utf8').split('\n').filter(Boolean).length : 0;
  const replace = (from, to) => run('body-replace', '1', '--from', file('from.md', from), '--to', file('to.md', to));

  // One match (GitHub may return CRLF): only that place changes, "$&" in the new text stays literal.
  server('Satz eins.\r\nein Wort\r\nSatz drei.');
  let result = replace('ein Wort\n', 'ein $& Wort\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|Satz eins.\nein $& Wort\nSatz drei.');

  // No match: refused with the reason, nothing written.
  server('Satz eins.');
  result = replace('fehlt', 'x');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal([patches(), stored()].join('|'), '1|Satz eins.');

  // Two matches, also overlapping ones: refused, nothing written.
  for (const [text, from] of [['ein Wort\nanderes\nein Wort', 'ein Wort'], ['aaa', 'aa']]) {
    server(text);
    result = replace(from, 'x');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal([patches(), stored()].join('|'), `1|${text}`);
  }

  // Unusable input is an error, never a write: empty text, missing file, unknown order.
  assert.equal(replace('\n', 'x').status, 2);
  assert.equal(run('body-replace', '1', '--from', 'missing.md', '--to', 'to.md').status, 2);
  assert.equal(run('body-replace', '1', '--to', 'to.md', '--from', 'from.md').status, 2);
  assert.equal(patches(), 1);
});

test('body and body-replace refuse an unknown flag before any write', t => {
  const { refusesUnknownFlag } = fixture(t);
  refusesUnknownFlag('body', '1', 'change.md', 'base.md');
  refusesUnknownFlag('body-replace', '1', '--from', 'from.md', '--to', 'to.md');
});
