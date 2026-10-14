(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncItFirmwareSelection = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function fnv1a32(bytes) {
    let hash = 0x811c9dc5;
    for (const byte of bytes) {
      hash ^= byte;
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  async function resolveFirmwareSelection({ userFile, selectedFirmware, fetchFirmware, textEncoder = new TextEncoder() }) {
    // Snapshot the object/URL before awaiting: a later UI change cannot replace
    // the payload selected for this upload transaction.
    const localFile = userFile || null;
    const bundledUrl = selectedFirmware || null;
    let hexText;
    let source;
    let filename;
    let declaredSize = null;

    if (localFile) {
      hexText = await localFile.text();
      source = 'local-file';
      filename = localFile.name || '(unnamed local file)';
      declaredSize = Number.isFinite(localFile.size) ? localFile.size : null;
    } else if (bundledUrl) {
      const response = await fetchFirmware(bundledUrl);
      if (!response.ok) throw new Error(`Unable to fetch selected firmware (${response.status})`);
      hexText = await response.text();
      source = 'bundled-url';
      filename = bundledUrl;
    } else {
      throw new Error('No firmware selected or uploaded');
    }

    const hexBytes = textEncoder.encode(hexText);
    return {
      hexText,
      diagnostics: {
        source,
        filename,
        declaredSize,
        hexByteLength: hexBytes.length,
        hexByteChecksumFnv1a32: fnv1a32(hexBytes),
      },
    };
  }

  return { resolveFirmwareSelection };
});
