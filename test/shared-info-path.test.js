const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

// Both "Read Startup Text" and "Write Startup Text" must funnel through the one
// shared INFO? transaction and parser. These structural guards keep that true and
// ensure the shared parser is still cache-busted (a stale startup-layout.js would
// leave isCompleteInfoResponse undefined and reinstate the full 2500 ms timeout).
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('the shared parser is loaded with a cache-busting version token', () => {
  assert.match(html, /<script src="startup-layout\.js\?v=[0-9a-f]+"><\/script>/);
});

test('INFO parsing and completion detection both delegate to the shared module', () => {
  assert.match(html, /function parseInfo\(text\) \{\s*return SyncItStartupLayout\.parseInfo\(text\);\s*\}/);
  assert.match(html, /APP_RESPONSE_TIMEOUT_MS,\s*SyncItStartupLayout\.isCompleteInfoResponse,/);
});

test('both read and write startup operations use the shared INFO transaction', () => {
  // Definition plus the two call sites (readStartupOverSerial and the write
  // path's readInfo callback).
  const callSites = html.match(/requestStartupInfo\(/g) || [];
  assert.ok(callSites.length >= 3, `expected >= 3 requestStartupInfo references, found ${callSites.length}`);
  assert.match(html, /async function requestStartupInfo\(writer, reader\)/);
  assert.match(html, /readInfo: \(\) => requestStartupInfo\(writer, reader\)/);
});
