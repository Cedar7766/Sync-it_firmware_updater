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
  async leaveProgrammingMode() {
    await this.serial.writeBytes([0x51,0x20]);
    const [r,ok] = await this.serial.readBytePair(500);
    if (r!==0x14||ok!==0x10) throw new Error("leaveProgMode failed");
  }
async flashHex(hexText, onProgress) {
  await this.sync();
  await this.enterProgrammingMode();

  const pages = [];
  const lines = hexText.split(/\r?\n/);
  let curr = 0;
  let buff = [];
  const pageSize = 128;
  const bootloaderStart = 0x7800; // ⛔ Modify if your bootloader starts elsewhere

  for (const l of lines) {
    if (!l.startsWith(":")) continue;
    const len = parseInt(l.substr(1, 2), 16);
    const addr = parseInt(l.substr(3, 4), 16);
    const type = parseInt(l.substr(7, 2), 16);
    if (type === 1) break; // EOF
    if (type !== 0) continue; // Not data

    //  Bootloader protection
    if (addr >= bootloaderStart) {
      throw new Error(`HEX file tries to write to 0x${addr.toString(16)} (bootloader region).`);
    }

    const data = [];
    for (let j = 0; j < len; j++) {
      data.push(parseInt(l.substr(9 + j * 2, 2), 16));
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

  for (let i = 0; i < pages.length; i++) {
    const [addr, data] = pages[i];
    console.log(`Flashing page ${i + 1}/${pages.length}, addr=0x${addr.toString(16)}`);
    await this.loadAddress(addr >> 1);
    await this.programPage(data);
    onProgress?.(Math.round((i + 1) / pages.length * 100));
  }

  await this.leaveProgrammingMode();
}
}

window.AvrSerial = AvrSerial;
window.STK500v1   = STK500v1;
