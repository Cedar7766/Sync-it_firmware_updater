class AvrSerial {
  constructor(port, baudRate = 57600) {
    this.port = port;
    this.buffer = [];
  }

  async open() {
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
  }

  async close() {
    if (this.reader) await this.reader.cancel();
    if (this.writer) this.writer.releaseLock();
    await this.port.close();
  }

  async writeBytes(bytes) {
    await this.writer.write(new Uint8Array(bytes));
    console.log("TX:", bytes.map(b => b.toString(16).padStart(2, '0')).join(" "));
  }

  async readByte(timeout = 1000) {
    if (this.buffer.length) {
      const b = this.buffer.shift();
      console.log("RX (buffer):", b.toString(16).padStart(2, "0"));
      return b;
    }

    const timeoutP = new Promise((_, rej) =>
      setTimeout(() => rej(new Error("Read timeout")), timeout)
    );

    const pull = async () => {
      const { value, done } = await this.reader.read();
      if (done || !value?.length) throw new Error("Stream closed");
      this.buffer.push(...value);
      const b = this.buffer.shift();
      console.log("RX:", b.toString(16).padStart(2, "0"));
      return b;
    };

    return await Promise.race([pull(), timeoutP]);
  }

  async readBytes(count, timeout = 1000) {
    const bytes = [];
    for (let i = 0; i < count; i++) {
      bytes.push(await this.readByte(timeout));
    }
    return bytes;
  }

async readBytePair(timeout = 500) {
  if (this._readingPair) {
    throw new Error("readBytePair() already in progress");
  }
  this._readingPair = true;

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error("Read timeout (pair)")), timeout)
  );

  const readAlignedPair = async () => {
    try {
      while (true) {
        // Already have two or more bytes?
        if (this.buffer.length >= 2) {
          const first = this.buffer[0];
          const second = this.buffer[1];
          if (first === 0x14 && second === 0x10) {
            this.buffer.shift();
            this.buffer.shift();
            console.log("readBytePair(): Matched response: 14 10");
            return [0x14, 0x10];
          } else {
            const discarded = this.buffer.shift();
            console.log("readBytePair(): Discarding byte:", discarded.toString(16).padStart(2, "0"));
            continue;
          }
        }

        // Wait for more bytes
        const { value, done } = await this.reader.read();
        if (done || !value?.length) throw new Error("Stream closed");

        const bytes = Array.from(value);
        console.log("readBytePair(): Raw read:", bytes.map(b => b.toString(16)).join(" "));
        this.buffer.push(...bytes);
        console.log("readBytePair(): Buffer now:", this.buffer.map(b => b.toString(16)).join(" "));
      }
    } finally {
      this._readingPair = false;
    }
  };

  return await Promise.race([readAlignedPair(), timeoutPromise]);
}
}

function analyzeHex(hexText, options = {}) {
  const pageSize = options.pageSize ?? 128;
  const bootloaderStart = options.bootloaderStart ?? 0x7800;
  const pages = [];
  const dataMap = new Map();
  const lines = hexText.split(/\r?\n/);
  let curr = 0;
  let buff = [];
  let dataBytes = 0;
  let highestAddress = 0;
  let firstBootloaderAddress = null;

  for (const line of lines) {
    if (!line.startsWith(":")) continue;

    const len = parseInt(line.substr(1, 2), 16);
    const addr = parseInt(line.substr(3, 4), 16);
    const type = parseInt(line.substr(7, 2), 16);

    if (type === 1) break;
    if (type !== 0) continue;

    const dataEnd = addr + len;
    if (dataEnd > highestAddress) {
      highestAddress = dataEnd;
    }
    dataBytes += len;

    if (dataEnd > bootloaderStart && firstBootloaderAddress === null) {
      firstBootloaderAddress = Math.max(addr, bootloaderStart);
    }

    const data = [];
    for (let j = 0; j < len; j++) {
      const value = parseInt(line.substr(9 + j * 2, 2), 16);
      data.push(value);
      dataMap.set(addr + j, value);
    }

    if (addr !== curr + buff.length) {
      while (buff.length) {
        const chunk = buff.splice(0, pageSize);
        pages.push([curr, chunk]);
        curr += pageSize;
      }
      curr = addr;
    }

    buff.push(...data);
  }

  while (buff.length) {
    const chunk = buff.splice(0, pageSize);
    pages.push([curr, chunk]);
    curr += pageSize;
  }

  return {
    pages,
    pageSize,
    bootloaderStart,
    dataBytes,
    dataMap,
    highestAddress,
    firstBootloaderAddress,
    bootloaderOverwrite: firstBootloaderAddress !== null,
  };
}

class STK500v1 {
  constructor(serial) {
    this.serial = serial;
  }
async sync() {
  for (let i = 0; i < 6; i++) {
    console.log("sync attempt", i + 1);
    await this.serial.writeBytes([0x30, 0x20]);
    try {
      const [resp, ok] = await this.serial.readBytePair(500);
      if (resp === 0x14 && ok === 0x10) {
        console.log("Sync OK");
        return;  // ✅ Exit on success!
      } else {
        console.warn("Unexpected sync response:", resp.toString(16), ok.toString(16));
      }
    } catch (e) {
      console.warn("sync timeout:", e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("No bootloader sync response");
}
  async enterProgrammingMode() {
    await this.serial.writeBytes([0x50,0x20]);
    const [r,ok] = await this.serial.readBytePair(500);
    if (r!==0x14||ok!==0x10) throw new Error("enterProgrammingMode failed");
  }
  async loadAddress(addr) {
    const high=(addr>>8)&0xFF, low=addr&0xFF;
    await this.serial.writeBytes([0x55, low, high, 0x20]);
    const [r,ok] = await this.serial.readBytePair(500);
    if (r!==0x14||ok!==0x10) throw new Error("loadAddress failed");
  }
async programPage(data) {
  const size = data.length;
  const high = (size >> 8) & 0xFF, low = size & 0xFF;

  const cmd = [0x64, high, low, 0x46, ...data, 0x20];
  console.log(`TX programPage (length=${size})`);

  const start = performance.now();
  await this.serial.writeBytes(cmd);

  const [r, ok] = await this.serial.readBytePair(1000);
  const elapsed = performance.now() - start;

  console.log(`programPage response: ${r.toString(16)} ${ok.toString(16)} (elapsed ${Math.round(elapsed)}ms)`);

  if (elapsed > 900) {
    console.warn("⚠️ programPage took too long — bootloader may have exited");
  }

  if (r !== 0x14 || ok !== 0x10) throw new Error("programPage failed");
}
  async readPage(size) {
    const high = (size >> 8) & 0xFF;
    const low = size & 0xFF;

    await this.serial.writeBytes([0x74, high, low, 0x46, 0x20]);

    const start = await this.serial.readByte(1000);
    if (start !== 0x14) throw new Error("readPage failed to start");

    const data = await this.serial.readBytes(size, 1000);
    const ok = await this.serial.readByte(1000);
    if (ok !== 0x10) throw new Error("readPage failed to finish");

    return data;
  }
  async leaveProgrammingMode() {
    await this.serial.writeBytes([0x51,0x20]);
    const [r,ok] = await this.serial.readBytePair(500);
    if (r!==0x14||ok!==0x10) throw new Error("leaveProgMode failed");
  }
async verifyBootloaderRegion(analysis) {
  const bootloaderPages = analysis.pages.filter(([addr, data]) => addr + data.length > analysis.bootloaderStart);

  if (!bootloaderPages.length) {
    return null;
  }

  let checkedBytes = 0;
  let matchedBytes = 0;
  let mismatchedBytes = 0;
  let firstMismatch = null;

  for (const [addr, data] of bootloaderPages) {
    await this.loadAddress(addr >> 1);
    const readBack = await this.readPage(data.length);

    for (let i = 0; i < data.length; i++) {
      const absoluteAddr = addr + i;
      if (absoluteAddr < analysis.bootloaderStart) {
        continue;
      }

      const expected = analysis.dataMap.get(absoluteAddr);
      if (expected === undefined) {
        continue;
      }

      checkedBytes += 1;
      if (readBack[i] === expected) {
        matchedBytes += 1;
      } else {
        mismatchedBytes += 1;
        if (!firstMismatch) {
          firstMismatch = {
            address: absoluteAddr,
            expected,
            actual: readBack[i],
          };
        }
      }
    }
  }

  return {
    attempted: true,
    checkedBytes,
    matchedBytes,
    mismatchedBytes,
    actualOverwrite: checkedBytes > 0 && mismatchedBytes === 0,
    protected: checkedBytes > 0 && mismatchedBytes > 0,
    firstMismatch,
  };
}
async flashHex(hexText, onProgress, options = {}) {
  await this.sync();
  await this.enterProgrammingMode();

  const analysis = analyzeHex(hexText, options);

  if (analysis.bootloaderOverwrite && !options.allowBootloaderOverwrite) {
    throw new Error(
      `HEX file tries to write to 0x${analysis.firstBootloaderAddress.toString(16)} ` +
      `(bootloader region starts at 0x${analysis.bootloaderStart.toString(16)}).`
    );
  }

  for (let i = 0; i < analysis.pages.length; i++) {
    const [addr, data] = analysis.pages[i];
    console.log(`Flashing page ${i + 1}/${analysis.pages.length}, addr=0x${addr.toString(16)}`);
    await this.loadAddress(addr >> 1);
    await this.programPage(data);
    onProgress?.(Math.round((i + 1) / analysis.pages.length * 100));
  }

  const verification = options.verifyBootloaderOverwrite && analysis.bootloaderOverwrite
    ? await this.verifyBootloaderRegion(analysis)
    : null;

  await this.leaveProgrammingMode();

  return {
    analysis,
    verification,
  };
}
}

window.AvrSerial = AvrSerial;
window.STK500v1   = STK500v1;
window.analyzeHex = analyzeHex;
