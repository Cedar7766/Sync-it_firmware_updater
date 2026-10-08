const assert = require('node:assert/strict');
const test = require('node:test');
const { assessLayout, isCompleteInfoResponse, isExactlyOneOk, parseInfo, runStartupTextUpdate } = require('../startup-layout.js');

function info({ positions = [0, 2, 4, 6], cap, fw = '3.53', screen = 1, layoutVersion, includePositions = true, extra = '' } = {}) {
  const fields = [
    `FW=${fw}`, 'L1:ONE', 'L2:TWO', 'L3:THREE', 'L4:FOUR', `SCREEN=${screen}`,
    'FONT=1', 'S1=0', 'S2=0', 'S3=0', 'S4=0',
  ];
  if (includePositions) fields.push(...positions.map((position, index) => `P${index + 1}=${position}`));
  if (cap !== undefined) fields.push(`LAYOUT_CAP=${cap}`);
  if (layoutVersion !== undefined) fields.push(`LAYOUT_VER=${layoutVersion}`);
  if (extra) fields.push(extra);
  return `${fields.join('\r\n')}\r\nEND\r\n`;
}

test('standard 0,2,4,6 layouts from v3.53 and v3.54 are editable', () => {
  assert.equal(assessLayout(parseInfo(info({ fw: '3.53' }))).kind, 'standard');
  assert.equal(assessLayout(parseInfo(info({ fw: '3.54', cap: 'DEFAULT1' }))).kind, 'standard');
});

test('blank v3.54 layout can receive its first text, but markerless SCREEN=0 is blocked', () => {
  assert.equal(assessLayout(parseInfo(info({ fw: '3.54', screen: 0, cap: 'DEFAULT1', layoutVersion: 1 }))).kind, 'standard');
  assert.equal(assessLayout(parseInfo(info({ fw: '3.54', screen: 0, cap: 'DEFAULT1' }))).kind, 'invalid');
});

test('repairable 0,0,4,6 layout repairs only after confirmation then writes text', async () => {
  const commands = [];
  const responses = [parseInfo(info({ positions: [0, 0, 4, 6], cap: 'DEFAULT1' })), parseInfo(info())];
  const result = await runStartupTextUpdate({
    readInfo: async () => responses.shift(),
    confirmRepair: async () => true,
    repairLayout: async () => commands.push('LAYOUT=DEFAULT'),
    writeText: async () => commands.push('L1', 'L2', 'L3', 'L4', 'SAVE'),
  });
  assert.deepEqual(result, { repaired: true, cancelled: false });
  assert.deepEqual(commands, ['LAYOUT=DEFAULT', 'L1', 'L2', 'L3', 'L4', 'SAVE']);
});

test('cancelled overlap repair sends no EEPROM-changing commands', async () => {
  const commands = [];
  const result = await runStartupTextUpdate({
    readInfo: async () => parseInfo(info({ positions: [0, 0, 4, 6], cap: 'DEFAULT1' })),
    confirmRepair: async () => false,
    repairLayout: async () => commands.push('LAYOUT=DEFAULT'),
    writeText: async () => commands.push('L1', 'SAVE'),
  });
  assert.deepEqual(result, { repaired: false, cancelled: true });
  assert.deepEqual(commands, []);
});

test('overlap without repair capability and customised layouts are blocked', async () => {
  assert.equal(assessLayout(parseInfo(info({ positions: [0, 0, 4, 6] }))).kind, 'overlap-without-repair');
  assert.equal(assessLayout(parseInfo(info({ positions: [1, 3, 5, 6], cap: 'DEFAULT1' }))).kind, 'custom');
  const commands = [];
  await assert.rejects(runStartupTextUpdate({
    readInfo: async () => parseInfo(info({ positions: [1, 3, 5, 6] })),
    confirmRepair: async () => true,
    repairLayout: async () => commands.push('LAYOUT=DEFAULT'),
    writeText: async () => commands.push('L1'),
  }), /customised startup layout/);
  assert.deepEqual(commands, []);
});

test('missing, malformed, incomplete, and duplicated INFO fields are rejected', () => {
  assert.equal(assessLayout(parseInfo(info({ includePositions: false }))).kind, 'invalid');
  assert.throws(() => parseInfo(info({ extra: 'P2=two' })), /Duplicate P2/);
  assert.throws(() => parseInfo(info().replace('P4=6', 'P4=7')), /Invalid P4/);
  assert.throws(() => parseInfo(info().replace('END\r\n', '')), /terminal END/);
});

test('failed post-repair verification stops before staged text commands', async () => {
  const commands = [];
  const responses = [parseInfo(info({ positions: [0, 0, 4, 6], cap: 'DEFAULT1' })), parseInfo(info({ positions: [0, 0, 4, 6], cap: 'DEFAULT1' }))];
  await assert.rejects(runStartupTextUpdate({
    readInfo: async () => responses.shift(),
    confirmRepair: async () => true,
    repairLayout: async () => commands.push('LAYOUT=DEFAULT'),
    writeText: async () => commands.push('L1', 'SAVE'),
  }), /could not be verified/);
  assert.deepEqual(commands, ['LAYOUT=DEFAULT']);
});

test('layout repair accepts exactly one OK acknowledgement only', () => {
  assert.equal(isExactlyOneOk('OK\r\n'), true);
  assert.equal(isExactlyOneOk(''), false);
  assert.equal(isExactlyOneOk('ERR\r\n'), false);
  assert.equal(isExactlyOneOk('OK\r\nOK\r\n'), false);
  assert.equal(isExactlyOneOk('noise\r\nOK\r\n'), false);
});

// The physical Sync-it emits its INFO? block with a single NUL byte trailing the
// terminal END line, which the original preflight rejected. These tests use the
// exact observed response.
const OBSERVED_INFO_BODY = [
  'ID:0123456789ABCDEF0123',
  'SOURCE=EEPROM',
  'EEPROM_IDENTITY=1',
  'EEPROM_VER=1',
  'HW=SYNCIT',
  'FW=3.54',
  'L1:ONE',
  'L2:TWO',
  'L3:THREE',
  'L4:FOUR',
  'SCREEN=1',
  'FONT=1',
  'P1=0',
  'P2=2',
  'P3=4',
  'P4=6',
  'S1=0',
  'S2=0',
  'S3=0',
  'S4=0',
  'LAYOUT_CAP=DEFAULT1',
].join('\r\n');
const OBSERVED_INFO_RESPONSE = `${OBSERVED_INFO_BODY}\r\nEND\r\n\u0000`;

test('the exact observed END\\r\\n\\u0000 response parses as a standard layout', () => {
  // Reproduce the captured tail byte-for-byte (the firmware emits the string's
  // NUL terminator because it writes 6 bytes of "END\\r\\n").
  assert.ok(OBSERVED_INFO_RESPONSE.endsWith('LAYOUT_CAP=DEFAULT1\r\nEND\r\n\u0000'));
  assert.equal(isCompleteInfoResponse(OBSERVED_INFO_RESPONSE), true);
  const info = parseInfo(OBSERVED_INFO_RESPONSE);
  assert.equal(info.l1, 'ONE');
  assert.equal(info.l4, 'FOUR');
  assert.equal(info.layoutCap, 'DEFAULT1');
  assert.deepEqual(info.positions, [0, 2, 4, 6]);
  assert.deepEqual(info.spacing, [0, 0, 0, 0]);
  assert.equal(assessLayout(info).kind, 'standard');
});

test('a complete END line is recognised promptly, even when NUL padding arrives later', () => {
  const withoutNul = OBSERVED_INFO_RESPONSE.slice(0, -1); // ends with "END\r\n"
  assert.equal(isCompleteInfoResponse(withoutNul), true);
  assert.equal(isCompleteInfoResponse(`${withoutNul}\u0000`), true);
  assert.equal(isCompleteInfoResponse(`${withoutNul}\u0000\u0000\u0000`), true);
});

test('only trailing CR, LF and NUL bytes after END are tolerated', () => {
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\nEND\r\n\r\n`), true);
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\nEND\n\u0000\n`), true);
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\nEND\u0000`), true);
  assert.equal(assessLayout(parseInfo(`${OBSERVED_INFO_BODY}\r\nEND\n\u0000\n`)).kind, 'standard');

  // A trailing space is data, not framing, and must still be rejected.
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\nEND\r\n `), false);
  assert.throws(() => parseInfo(`${OBSERVED_INFO_BODY}\r\nEND\r\n `), /terminal END/);
});

test('chunked serial delivery completes as soon as the END line arrives', () => {
  const chunks = [
    OBSERVED_INFO_BODY.slice(0, 40),
    OBSERVED_INFO_BODY.slice(40) + '\r\nEND\r\n',
    '\u0000',
  ];
  let accumulated = '';
  let completedAtChunk = -1;
  chunks.forEach((chunk, index) => {
    accumulated += chunk;
    if (completedAtChunk === -1 && isCompleteInfoResponse(accumulated)) completedAtChunk = index;
  });
  // Completion must be detected on the chunk carrying END, not deferred until
  // the trailing NUL chunk (which would otherwise force the full timeout).
  assert.equal(completedAtChunk, 1);
  assert.equal(isCompleteInfoResponse(accumulated), true);
  assert.equal(assessLayout(parseInfo(accumulated)).kind, 'standard');
});

test('responses without a genuine terminal END are rejected', () => {
  assert.equal(isCompleteInfoResponse(''), false);
  assert.equal(isCompleteInfoResponse('L1:ONE\r\nL2:TWO\r\n'), false);
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\n`), false);
  assert.throws(() => parseInfo(`${OBSERVED_INFO_BODY}\r\n`), /terminal END/);
});

test('non-whitespace data after END is still rejected', () => {
  assert.equal(isCompleteInfoResponse(`${OBSERVED_INFO_BODY}\r\nEND\r\nS4=0\r\n`), false);
  assert.throws(() => parseInfo(`${OBSERVED_INFO_BODY}\r\nEND\r\nX`), /terminal END/);
  assert.throws(() => parseInfo(`${OBSERVED_INFO_BODY}\r\nEND\r\nX\u0000`), /terminal END/);
});

test('an embedded NUL byte is still treated as malformed', () => {
  assert.throws(() => parseInfo(`${OBSERVED_INFO_BODY}\r\nEND\r\n\u0000JUNK`), /unexpected NUL/);
  assert.throws(() => parseInfo(OBSERVED_INFO_RESPONSE.replace('L1:ONE', 'L1:O\u0000NE')), /unexpected NUL/);
});

test('truncated and malformed observed responses remain rejected', () => {
  assert.throws(() => parseInfo(OBSERVED_INFO_RESPONSE.replace('\r\nEND\r\n\u0000', '\r\n')), /terminal END/);
  assert.throws(() => parseInfo(OBSERVED_INFO_RESPONSE.replace('END\r\n\u0000', '')), /terminal END/);
  assert.throws(() => parseInfo(OBSERVED_INFO_RESPONSE.replace('P4=6', 'P4=99')), /Invalid P4/);
  assert.throws(() => parseInfo(OBSERVED_INFO_RESPONSE.replace('L4:FOUR', 'L3:FOUR')), /Duplicate L3/);
});
