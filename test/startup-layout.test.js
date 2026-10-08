const assert = require('node:assert/strict');
const test = require('node:test');
const { assessLayout, isExactlyOneOk, parseInfo, runStartupTextUpdate } = require('../startup-layout.js');

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
