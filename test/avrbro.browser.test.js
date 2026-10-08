const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { performance } = require("node:perf_hooks");
const test = require("node:test");
const vm = require("node:vm");

const source = readFileSync(require.resolve("../avrbro.browser.js"), "utf8");

function loadFlasher() {
  const quietConsole = { debug() {}, info() {}, warn() {} };
  const context = { Uint8Array, performance, setTimeout, clearTimeout, console: quietConsole, window: {} };
  vm.runInNewContext(source, context, { filename: "avrbro.browser.js" });
  return context.window;
}

class MockSerialPort {
  constructor(onWrite) {
    this.writes = [];
    this.onWrite = onWrite;
    this.closed = false;
    this.readable = new ReadableStream({ start: controller => { this.controller = controller; } });
    this.writable = new WritableStream({
      write: bytes => {
        const copy = Array.from(bytes);
        this.writes.push(copy);
        return this.onWrite?.(copy, this);
      },
    });
  }

  send(bytes, delay = 0) {
    setTimeout(() => this.controller.enqueue(Uint8Array.from(bytes)), delay);
  }

  async close() {
    this.closed = true;
  }
}

async function withSerial(onWrite, callback) {
  const { AvrSerial, STK500v1 } = loadFlasher();
  const port = new MockSerialPort(onWrite);
  const serial = new AvrSerial(port);
  await serial.open();
  try {
    await callback({ serial, stk: new STK500v1(serial), port });
  } finally {
    await serial.close();
  }
}

function replyPair(_bytes, port) {
  port.send([0x14, 0x10]);
}

test("normal immediate responses program consecutive 0x0000 and 0x0080 pages", async () => {
  await withSerial(replyPair, async ({ stk, port }) => {
    await stk.sync(1);
    await stk.enterProgrammingMode();
    await stk.loadAddress(0x0000);
    await stk.programPage(new Array(128).fill(0xaa), 0x0000);
    await stk.loadAddress(0x0040);
    await stk.programPage(new Array(128).fill(0x55), 0x0080);
    await stk.leaveProgrammingMode();
    assert.deepEqual(port.writes.map(command => command.slice(0, 4)), [
      [0x30, 0x20], [0x50, 0x20], [0x55, 0x00, 0x00, 0x20], [0x64, 0x00, 0x80, 0x46],
      [0x55, 0x40, 0x00, 0x20], [0x64, 0x00, 0x80, 0x46], [0x51, 0x20],
    ]);
  });
});

test("split response chunks are assembled in protocol order", async () => {
  await withSerial((_bytes, port) => {
    port.send([0x14], 2);
    port.send([0x10], 5);
  }, async ({ stk }) => {
    await stk.sync(1);
    await stk.enterProgrammingMode();
  });
});

test("delayed response inside the command deadline succeeds", async () => {
  await withSerial((_bytes, port) => port.send([0x14, 0x10], 40), async ({ stk }) => {
    await stk.sync(1);
  });
});

test("a late acknowledgement from a timed-out sync attempt is logged and not accepted by the retry", async () => {
  let syncCount = 0;
  await withSerial((bytes, port) => {
    if (bytes[0] !== 0x30) return;
    syncCount += 1;
    // Attempt 1 replies after attempt 2 has been transmitted.  The first pair
    // received by attempt 2 is therefore ambiguous and must not establish sync.
    if (syncCount === 1) port.send([0x14, 0x10], 455);
    else if (syncCount === 2) port.send([0x14, 0x10], 20);
    else port.send([0x14, 0x10], 1);
  }, async ({ stk, port }) => {
    await stk.sync(3);
    assert.equal(port.writes.filter(command => command[0] === 0x30).length, 3);
  });
});

test("duplicate response pairs force a new sync instead of acknowledging a later command", async () => {
  let syncCount = 0;
  await withSerial((bytes, port) => {
    if (bytes[0] !== 0x30) return replyPair(bytes, port);
    syncCount += 1;
    port.send(syncCount === 1 ? [0x14, 0x10, 0x14, 0x10] : [0x14, 0x10]);
  }, async ({ stk, port }) => {
    await stk.sync(2);
    assert.equal(port.writes.filter(command => command[0] === 0x30).length, 2);
    await stk.enterProgrammingMode();
  });
});

test("missing program-page final OK fails and does not turn a partial response into success", async () => {
  await withSerial((bytes, port) => {
    if (bytes[0] === 0x64) port.send([0x14]);
    else replyPair(bytes, port);
  }, async ({ stk }) => {
    await stk.sync(1);
    await stk.enterProgrammingMode();
    await stk.loadAddress(0);
    await assert.rejects(stk.programPage(new Array(128).fill(0), 0), /program page final OK timeout/);
  });
});

test("unexpected residual response bytes stop the next command rather than being discarded", async () => {
  await withSerial((bytes, port) => {
    replyPair(bytes, port);
    if (bytes[0] === 0x50) port.send([0x14, 0x10], 1);
  }, async ({ stk }) => {
    await stk.sync(1);
    await stk.enterProgrammingMode();
    await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(stk.loadAddress(0), /unexpected buffered STK500 byte/);
  });
});
