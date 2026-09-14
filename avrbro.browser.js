class AvrSerial {
  constructor(port) {
    this.port = port;
    this.buffer = [];
    this.waiters = [];
    this.ended = false;
    this.readError = null;
    this.pumpPromise = null;
    this._readingPair = false;
  }

  async open() {
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.pumpPromise = this._pump();
  }

  async _pump() {
    try {
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value?.length) {
          const bytes = Array.from(value);
          this.buffer.push(...bytes);
          console.debug("STK500 RX:", bytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
          this._notifyWaiters();
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError") this.readError = error;
    } finally {
      this.ended = true;
      this._notifyWaiters();
    }
  }

  _notifyWaiters() {
    const waiters = this.waiters.splice(0, this.waiters.length);
    waiters.forEach(resolve => resolve());
  }

  async close() {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch (error) {
        if (error?.name !== "InvalidStateError") console.warn("STK500 reader cancel failed:", error);
      }
    }
    if (this.pumpPromise) await this.pumpPromise;
    if (this.reader) this.reader.releaseLock();
    if (this.writer) this.writer.releaseLock();
    await this.port.close();
  }

  async writeBytes(bytes) {
    await this.writer.write(new Uint8Array(bytes));
    console.debug("STK500 TX:", bytes.map(b => b.toString(16).padStart(2, "0")).join(" "));
  }

  clearBufferedInput(reason) {
    if (!this.buffer.length) return;
    console.debug(`Discarding ${this.buffer.length} stale STK500 byte(s) ${reason}`);
    this.buffer.length = 0;
  }

  async _waitForInput(timeout) {
    if (this.buffer.length) return true;
    if (this.readError) throw this.readError;
    if (this.ended) throw new Error("Stream closed");
    return new Promise(resolve => {
      const waiter = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  async readByte(timeout = 1000) {
    const deadline = performance.now() + timeout;
    while (!this.buffer.length) {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || !await this._waitForInput(remaining)) throw new Error("Read timeout");
    }
    const byte = this.buffer.shift();
    console.debug("STK500 RX byte:", byte.toString(16).padStart(2, "0"));
    return byte;
  }

  async readBytes(count, timeout = 1000) {
    const bytes = [];
    for (let i = 0; i < count; i++) bytes.push(await this.readByte(timeout));
    return bytes;
  }

  async readBytePair(timeout = 500) {
    if (this._readingPair) throw new Error("readBytePair() already in progress");
    this._readingPair = true;
    const deadline = performance.now() + timeout;
    let discarded = 0;
    try {
      while (true) {
        while (this.buffer.length >= 2) {
          if (this.buffer[0] === 0x14 && this.buffer[1] === 0x10) {
            this.buffer.shift();
            this.buffer.shift();
            console.debug("STK500 response: 14 10");
            return [0x14, 0x10];
          }
          const byte = this.buffer.shift();
          discarded += 1;
          console.warn("STK500 malformed response byte discarded:", byte.toString(16).padStart(2, "0"));
        }
        const remaining = deadline - performance.now();
        if (remaining <= 0 || !await this._waitForInput(remaining)) {
          const suffix = discarded ? ` after discarding ${discarded} malformed byte(s)` : "";
          throw new Error(`Read timeout (pair)${suffix}`);
        }
      }
    } finally {
      this._readingPair = false;
    }
  }
}

function analyzeHex(hexText, options = {}) {
  const pageSize = options.pageSize ?? 128;
  const bootloaderStart = options.bootloaderStart ?? 0x7E00;
  const pages = [];
  const dataMap = new Map();
  let curr = 0, buff = [], dataBytes = 0, highestAddress = 0, firstBootloaderAddress = null;
  for (const line of hexText.split(/\r?\n/)) {
    if (!line.startsWith(":")) continue;
    const len = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);
    if (type === 1) break;
    if (type !== 0) continue;
    const dataEnd = addr + len;
    highestAddress = Math.max(highestAddress, dataEnd);
    dataBytes += len;
    if (dataEnd > bootloaderStart && firstBootloaderAddress === null) firstBootloaderAddress = Math.max(addr, bootloaderStart);
    const data = [];
    for (let j = 0; j < len; j++) {
      const value = parseInt(line.substr(9 + j * 2, 2), 16);
      data.push(value);
      dataMap.set(addr + j, value);
    }
    if (addr !== curr + buff.length) {
      while (buff.length) {
        pages.push([curr, buff.splice(0, pageSize)]);
        curr += pageSize;
      }
      curr = addr;
    }
    buff.push(...data);
  }
  while (buff.length) {
    pages.push([curr, buff.splice(0, pageSize)]);
    curr += pageSize;
  }
  return { pages, pageSize, bootloaderStart, dataBytes, dataMap, highestAddress,
    firstBootloaderAddress, bootloaderOverwrite: firstBootloaderAddress !== null };
}

class STK500v1 {
  constructor(serial) { this.serial = serial; }

  async _expectPair(stage, timeout) {
    try {
      return await this.serial.readBytePair(timeout);
    } catch (error) {
      console.warn(`STK500 ${stage} failed:`, error.message);
      throw new Error(`${stage}: ${error.message}`);
    }
  }

  async sync(attempts = 4) {
    this.serial.clearBufferedInput("before STK500 sync");
    for (let i = 0; i < attempts; i++) {
      console.info(`STK500 sync attempt ${i + 1}/${attempts}`);
      await this.serial.writeBytes([0x30, 0x20]);
      try {
        await this._expectPair("sync", 350);
        console.info("STK500 sync succeeded");
        return;
      } catch (error) {
        console.warn(`STK500 sync timeout or malformed response (${i + 1}/${attempts}):`, error.message);
      }
      if (i + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("No bootloader sync response");
  }

  async enterProgrammingMode() {
    await this.serial.writeBytes([0x50, 0x20]);
    await this._expectPair("enter programming mode", 750);
  }

  async loadAddress(addr) {
    await this.serial.writeBytes([0x55, addr & 0xFF, (addr >> 8) & 0xFF, 0x20]);
    await this._expectPair("load address", 750);
  }

  async programPage(data) {
    const size = data.length;
    await this.serial.writeBytes([0x64, (size >> 8) & 0xFF, size & 0xFF, 0x46, ...data, 0x20]);
    await this._expectPair("program page", 1500);
  }

  async readPage(size) {
    await this.serial.writeBytes([0x74, (size >> 8) & 0xFF, size & 0xFF, 0x46, 0x20]);
    const start = await this.serial.readByte(1000);
    if (start !== 0x14) throw new Error("verify read: malformed response start");
    const data = await this.serial.readBytes(size, 1000);
    const ok = await this.serial.readByte(1000);
    if (ok !== 0x10) throw new Error("verify read: malformed response end");
    return data;
  }

  async leaveProgrammingMode() {
    await this.serial.writeBytes([0x51, 0x20]);
    await this._expectPair("leave programming mode", 750);
  }

  async verifyBootloaderRegion(analysis) {
    const bootloaderPages = analysis.pages.filter(([addr, data]) => addr + data.length > analysis.bootloaderStart);
    if (!bootloaderPages.length) return null;
    let checkedBytes = 0, matchedBytes = 0, mismatchedBytes = 0, firstMismatch = null;
    for (const [addr, data] of bootloaderPages) {
      await this.loadAddress(addr >> 1);
      const readBack = await this.readPage(data.length);
      for (let i = 0; i < data.length; i++) {
        const absoluteAddr = addr + i;
        if (absoluteAddr < analysis.bootloaderStart) continue;
        const expected = analysis.dataMap.get(absoluteAddr);
        if (expected === undefined) continue;
        checkedBytes += 1;
        if (readBack[i] === expected) matchedBytes += 1;
        else {
          mismatchedBytes += 1;
          if (!firstMismatch) firstMismatch = { address: absoluteAddr, expected, actual: readBack[i] };
        }
      }
    }
    return { attempted: true, checkedBytes, matchedBytes, mismatchedBytes,
      actualOverwrite: checkedBytes > 0 && mismatchedBytes === 0,
      protected: checkedBytes > 0 && mismatchedBytes > 0, firstMismatch };
  }

  async flashHex(hexText, onProgress, options = {}) {
    if (!options.skipSync) await this.sync();
    await this.enterProgrammingMode();
    const analysis = analyzeHex(hexText, options);
    if (analysis.bootloaderOverwrite && !options.allowBootloaderOverwrite) {
      throw new Error(`HEX file tries to write to 0x${analysis.firstBootloaderAddress.toString(16)} ` +
        `(bootloader region starts at 0x${analysis.bootloaderStart.toString(16)}).`);
    }
    for (let i = 0; i < analysis.pages.length; i++) {
      const [addr, data] = analysis.pages[i];
      console.info(`STK500 programming page ${i + 1}/${analysis.pages.length}, address 0x${addr.toString(16)}`);
      await this.loadAddress(addr >> 1);
      await this.programPage(data);
      onProgress?.(Math.round((i + 1) / analysis.pages.length * 100));
    }
    const verification = options.verifyBootloaderOverwrite && analysis.bootloaderOverwrite
      ? await this.verifyBootloaderRegion(analysis) : null;
    await this.leaveProgrammingMode();
    console.info("STK500 programming completed");
    return { analysis, verification };
  }
}

window.AvrSerial = AvrSerial;
window.STK500v1 = STK500v1;
window.analyzeHex = analyzeHex;
