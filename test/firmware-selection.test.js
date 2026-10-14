const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { resolveFirmwareSelection } = require('../firmware-selection.js');

test('a selected local HEX wins over a stale bundled selection and is the programming payload', async () => {
  const localHex = ':020000000102FB\n:00000001FF\n';
  const localFile = { name: 'Sync-it-firmware-v3.54.hex', size: localHex.length, text: async () => localHex };
  let fetched = false;
  const selected = await resolveFirmwareSelection({
    userFile: localFile,
    selectedFirmware: 'firmware/Sync-it-firmware-v3.53.hex',
    fetchFirmware: async () => { fetched = true; throw new Error('bundled firmware must not be fetched'); },
  });
  const programmed = [];
  await { flashHex: async hexText => programmed.push(hexText) }.flashHex(selected.hexText);

  assert.equal(fetched, false);
  assert.deepEqual(programmed, [localHex]);
  assert.deepEqual(selected.diagnostics, {
    source: 'local-file',
    filename: 'Sync-it-firmware-v3.54.hex',
    declaredSize: localHex.length,
    hexByteLength: localHex.length,
    hexByteChecksumFnv1a32: 'cc3de2e9',
  });
});

test('a bundled selection fetches exactly its selected URL when no local file exists', async () => {
  const bundledHex = ':00000001FF\n';
  const urls = [];
  const selected = await resolveFirmwareSelection({
    userFile: null,
    selectedFirmware: 'firmware/Sync-it-firmware-v3.53.hex',
    fetchFirmware: async url => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => bundledHex };
    },
  });

  assert.deepEqual(urls, ['firmware/Sync-it-firmware-v3.53.hex']);
  assert.equal(selected.hexText, bundledHex);
  assert.equal(selected.diagnostics.source, 'bundled-url');
  assert.equal(selected.diagnostics.filename, 'firmware/Sync-it-firmware-v3.53.hex');
});

test('a missing selection fails before any serial connection is attempted', async () => {
  await assert.rejects(
    resolveFirmwareSelection({ userFile: null, selectedFirmware: null, fetchFirmware: async () => undefined }),
    /No firmware selected or uploaded/
  );
});

test('the page passes the resolved payload, rather than either selection variable, to flashHex', () => {
  const page = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(page, /userFile = file;\s*selectedFirmware = null;/);
  assert.match(page, /const firmwareText = firmwarePayload\.hexText;/);
  assert.match(page, /uploader\.flashHex\(\s*firmwareText,/);
  assert.match(page, /Firmware payload selected for upload/);
  assert.match(page, /Firmware payload passed to STK500 flashHex/);
});
