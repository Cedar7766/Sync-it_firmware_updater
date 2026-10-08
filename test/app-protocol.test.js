const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// These tests execute the real inline script from index.html inside a VM with a
// fake Web Serial port. This exercises the same transactions the page runs for
// "Read Startup Text" and "Write Startup Text" without a browser.

const root = path.join(__dirname, '..');
const avrbroSource = readFileSync(path.join(root, 'avrbro.browser.js'), 'utf8');
const startupLayoutSource = readFileSync(path.join(root, 'startup-layout.js'), 'utf8');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const inlineScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const LINE_IDS = ['line1Input', 'line2Input', 'line3Input', 'line4Input'];

function makeElement() {
  return {
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    selectedIndex: -1,
    files: [],
    onclick: null,
    onchange: null,
    addEventListener() {},
    appendChild() {},
  };
}

function createFakePort(onCommand) {
  const encoder = new TextEncoder();
  const port = {
    opened: false,
    closed: false,
    writes: [],
    signalCalls: [],
    onCommand,
    _controller: null,
    async open() { port.opened = true; },
    async close() { port.closed = true; },
    async setSignals(signals) { port.signalCalls.push(signals); },
    enqueue(text) {
      if (port.closed || !port._controller) return;
      try {
        port._controller.enqueue(encoder.encode(text));
      } catch {
        // The readable side was already cancelled; late padding is irrelevant.
      }
    },
  };
  port.readable = new ReadableStream({ start(controller) { port._controller = controller; } });
  port.writable = new WritableStream({
    write(bytes) {
      const command = new TextDecoder().decode(bytes);
      port.writes.push(command);
      port.onCommand?.(command, port);
    },
  });
  return port;
}

function loadPage({ onCommand, confirmResult = false } = {}) {
  const elements = new Map();
  const port = createFakePort(onCommand);
  const requestedDelays = [];
  const context = {
    console: { debug() {}, info() {}, warn() {}, error() {}, log() {} },
    performance,
    TextDecoder,
    TextEncoder,
    ReadableStream,
    WritableStream,
    // Cap delayed sleeps (e.g. the 1200 ms port-open delay) while keeping real
    // deadlines for the read timeouts under test.
    setTimeout: (fn, ms, ...args) => {
      requestedDelays.push(Number(ms) || 0);
      return setTimeout(fn, Math.min(Number(ms) || 0, 5), ...args);
    },
    clearTimeout,
    confirmCalls: [],
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id);
      },
      createElement() { return makeElement(); },
    },
  };
  context.window = context;
  context.globalThis = context;
  context.navigator = { serial: { requestPort: async () => port } };
  context.fetch = () => Promise.reject(new Error('manifest unavailable in harness'));
  context.confirm = message => {
    context.confirmCalls.push(message);
    return confirmResult === true;
  };
  context.alert = () => {};

  vm.createContext(context);
  vm.runInContext(avrbroSource, context, { filename: 'avrbro.browser.js' });
  vm.runInContext(startupLayoutSource, context, { filename: 'startup-layout.js' });
  vm.runInContext(inlineScript, context, { filename: 'index.html#inline' });

  return {
    context,
    port,
    elements,
    requestedDelays,
    statusText: () => elements.get('startupStatus').textContent,
    setLines(lines) {
      LINE_IDS.forEach((id, index) => { elements.get(id).value = lines[index]; });
    },
  };
}

// Mirrors the firmware's printInfoBlock(): CRLF lines, then "END\r\n" written as
// 6 bytes so the string's NUL terminator is emitted too.
function infoBlock({ positions = [0, 2, 4, 6], cap = 'DEFAULT1', layoutVersion = 1, l1 = 'ONE', l4 = 'FOUR' } = {}) {
  const fields = [
    'FW=3.54',
    `L1:${l1}`, 'L2:TWO', 'L3:THREE', `L4:${l4}`,
    'SCREEN=1', 'FONT=1',
    `P1=${positions[0]}`, `P2=${positions[1]}`, `P3=${positions[2]}`, `P4=${positions[3]}`,
    'S1=0', 'S2=0', 'S3=0', 'S4=0',
  ];
  if (cap !== undefined) fields.push(`LAYOUT_CAP=${cap}`);
  if (layoutVersion !== undefined) fields.push(`LAYOUT_VER=${layoutVersion}`);
  return `${fields.join('\r\n')}\r\nEND\r\n\u0000`;
}

const OK = 'OK\r\n';

test('writeStartup reports success and never throws a scope ReferenceError', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      port.enqueue(command.startsWith('INFO?') ? infoBlock() : OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Write OK. Disconnect and reconnect the unit to display the completed startup text.');
  assert.ok(page.requestedDelays.includes(5000));
  assert.equal(page.port.closed, true);
  assert.deepEqual(page.port.signalCalls, []);
  assert.deepEqual(page.port.writes, [
    'INFO?\n', 'L1=ONE\n', 'L2=TWO\n', 'L3=THREE\n', 'L4=FOUR\n', 'SAVE\n', 'INFO?\n',
  ]);
});

test('readStartup populates the lines and reports Read OK', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      if (command.startsWith('INFO?')) port.enqueue(infoBlock());
    },
  });

  await page.context.readStartup();

  assert.equal(page.statusText(), 'Read OK');
  assert.equal(page.elements.get('line1Input').value, 'ONE');
  assert.equal(page.elements.get('line4Input').value, 'FOUR');
  assert.ok(page.requestedDelays.includes(1200));
  assert.equal(page.requestedDelays.includes(5000), false);
});

test('a trailing NUL after END is tolerated and recognised promptly', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      port.enqueue(command.startsWith('INFO?') ? infoBlock() : OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  const startedAt = performance.now();
  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Write OK. Disconnect and reconnect the unit to display the completed startup text.');
  // Prompt completion: nowhere near the 2500 ms INFO timeout, let alone three.
  assert.ok(performance.now() - startedAt < 2000, 'INFO? should not wait out the full timeout');
});

test('END and its trailing NUL arriving in separate chunks do not contaminate the next command', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      if (command.startsWith('INFO?')) {
        // END arrives in this chunk; the firmware's NUL padding arrives later.
        port.enqueue(`${infoBlock().slice(0, -1)}`); // drop the NUL byte
        setTimeout(() => port.enqueue('\u0000'), 20);
        return;
      }
      port.enqueue(OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Write OK. Disconnect and reconnect the unit to display the completed startup text.');
  assert.deepEqual(page.port.writes, [
    'INFO?\n', 'L1=ONE\n', 'L2=TWO\n', 'L3=THREE\n', 'L4=FOUR\n', 'SAVE\n', 'INFO?\n',
  ]);
});

test('an embedded NUL in the INFO response is rejected, not silently dropped', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      if (command.startsWith('INFO?')) port.enqueue(infoBlock({ l1: 'O\u0000NE' }));
      else port.enqueue(OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Unable to read unit information. Please try again.');
  // Three INFO? attempts, and no EEPROM-modifying command was ever sent.
  assert.deepEqual(page.port.writes, ['INFO?\n', 'INFO?\n', 'INFO?\n']);
});

test('a malformed INFO response blocks every EEPROM-modifying command', async () => {
  // Complete-looking block that ends with END but omits the required L4 field.
  const malformed = [
    'FW=3.54', 'L1:ONE', 'L2:TWO', 'L3:THREE', 'SCREEN=1', 'FONT=1',
    'P1=0', 'P2=2', 'P3=4', 'P4=6', 'S1=0', 'S2=0', 'S3=0', 'S4=0',
  ].join('\r\n') + '\r\nEND\r\n\u0000';
  const page = loadPage({
    onCommand: (command, port) => {
      port.enqueue(command.startsWith('INFO?') ? malformed : OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Unable to read unit information. Please try again.');
  assert.deepEqual(page.port.writes, ['INFO?\n', 'INFO?\n', 'INFO?\n']);
});

test('the recovery sequence confirms, repairs, verifies, then writes text', async () => {
  const page = loadPage({
    confirmResult: true,
    onCommand: (command, port) => {
      if (command === 'INFO?\n') {
        const infoCalls = page.port.writes.filter(w => w === 'INFO?\n').length;
        // First read sees the legacy overlap; later reads see the repaired layout.
        port.enqueue(infoCalls === 1 ? infoBlock({ positions: [0, 0, 4, 6] }) : infoBlock());
        return;
      }
      if (command === 'LAYOUT=DEFAULT\n') { port.enqueue(OK); return; }
      port.enqueue(OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Write OK. Disconnect and reconnect the unit to display the completed startup text.');
  assert.equal(page.context.confirmCalls.length, 1);
  assert.match(page.context.confirmCalls[0], /Line 1 and 2|Lines 1 and 2/);
  assert.deepEqual(page.port.writes, [
    'INFO?\n', 'LAYOUT=DEFAULT\n', 'INFO?\n',
    'L1=ONE\n', 'L2=TWO\n', 'L3=THREE\n', 'L4=FOUR\n', 'SAVE\n', 'INFO?\n',
  ]);
  assert.equal(page.port.writes.filter(w => w === 'LAYOUT=DEFAULT\n').length, 1);
});

test('cancelling the overlap repair sends no EEPROM-modifying command', async () => {
  const page = loadPage({
    confirmResult: false,
    onCommand: (command, port) => {
      if (command.startsWith('INFO?')) port.enqueue(infoBlock({ positions: [0, 0, 4, 6] }));
      else port.enqueue(OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.context.confirmCalls.length, 1);
  assert.equal(page.statusText(), 'Update cancelled; no changes were made.');
  assert.deepEqual(page.port.writes, ['INFO?\n']);
});

test('a mismatched post-SAVE INFO response is not reported as success', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      if (command === 'INFO?\n') {
        const infoCalls = page.port.writes.filter(write => write === 'INFO?\n').length;
        port.enqueue(infoCalls === 1 ? infoBlock() : infoBlock({ l4: 'OLD' }));
        return;
      }
      port.enqueue(OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'Saved startup text could not be verified (line 4)');
  assert.deepEqual(page.port.writes, [
    'INFO?\n', 'L1=ONE\n', 'L2=TWO\n', 'L3=THREE\n', 'L4=FOUR\n', 'SAVE\n', 'INFO?\n',
  ]);
});

test('a failed SAVE stops before verification and never reports success', async () => {
  const page = loadPage({
    onCommand: (command, port) => {
      if (command === 'INFO?\n') { port.enqueue(infoBlock()); return; }
      port.enqueue(command === 'SAVE\n' ? 'ERR\r\n' : OK);
    },
  });
  page.setLines(['ONE', 'TWO', 'THREE', 'FOUR']);

  await page.context.writeStartup();

  assert.equal(page.statusText(), 'SAVE failed: device returned ERR');
  assert.deepEqual(page.port.writes, [
    'INFO?\n', 'L1=ONE\n', 'L2=TWO\n', 'L3=THREE\n', 'L4=FOUR\n', 'SAVE\n',
  ]);
});
