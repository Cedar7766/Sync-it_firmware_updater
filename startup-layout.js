(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.SyncItStartupLayout = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const STANDARD_POSITIONS = [0, 2, 4, 6];
  const LEGACY_OVERLAP_POSITIONS = [0, 0, 4, 6];
  const REQUIRED_LINES = ['L1', 'L2', 'L3', 'L4'];
  const REQUIRED_LAYOUT_FIELDS = ['SCREEN', 'FONT', 'P1', 'P2', 'P3', 'P4', 'S1', 'S2', 'S3', 'S4'];

  function samePositions(actual, expected) {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  }

  function parseIntegerField(name, value, min, max) {
    if (!/^\d+$/.test(value)) throw new Error(`Malformed ${name} in INFO response`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
      throw new Error(`Invalid ${name} in INFO response`);
    }
    return number;
  }

  // The INFO? block is terminated by an END line that some units follow with
  // stray framing bytes (the firmware emits a NUL terminator after "END\r\n").
  // Only trailing CR, LF and NUL bytes after END are tolerated; any NUL or other
  // data elsewhere still marks the frame malformed.
  function stripTrailingFraming(text) {
    return String(text).replace(/[\r\n\0]+$/, '');
  }

  // True once the accumulated serial text contains a genuine terminal END line
  // followed only by trailing CR, LF or NUL bytes. The serial reader uses this
  // to stop as soon as the block completes instead of waiting out the full
  // response timeout (a NUL arriving after END must not defeat it).
  function isCompleteInfoResponse(text) {
    return /(?:^|\n)END[\r\n\0]*$/.test(String(text));
  }

  function parseInfo(text) {
    const normalized = stripTrailingFraming(text);
    if (normalized.includes('\0')) throw new Error('INFO response contains an unexpected NUL byte');
    const lines = normalized.replace(/\r/g, '').split('\n');
    if (lines.pop() !== 'END') throw new Error('INFO response is missing a terminal END line');

    const values = Object.create(null);
    const seen = new Set();
    const known = new Set([...REQUIRED_LINES, ...REQUIRED_LAYOUT_FIELDS, 'LAYOUT_CAP', 'LAYOUT_VER']);

    for (const line of lines) {
      let name = null;
      let value = null;
      const lineMatch = /^L([1-4]):(.*)$/.exec(line);
      const fieldMatch = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (lineMatch) {
        name = `L${lineMatch[1]}`;
        value = lineMatch[2];
      } else if (fieldMatch && known.has(fieldMatch[1])) {
        name = fieldMatch[1];
        value = fieldMatch[2].trim();
      }

      if (!name) continue;
      if (seen.has(name)) throw new Error(`Duplicate ${name} in INFO response`);
      seen.add(name);
      values[name] = value;
    }

    for (const field of REQUIRED_LINES) {
      if (!seen.has(field)) throw new Error(`INFO response is missing ${field}`);
    }

    const info = {
      l1: values.L1,
      l2: values.L2,
      l3: values.L3,
      l4: values.L4,
      screen: undefined,
      font: undefined,
      positions: undefined,
      spacing: undefined,
      layoutCap: values.LAYOUT_CAP,
      layoutVersion: undefined,
    };

    if (seen.has('SCREEN')) info.screen = parseIntegerField('SCREEN', values.SCREEN, 0, 1);
    if (seen.has('FONT')) info.font = parseIntegerField('FONT', values.FONT, 1, 255);
    if (seen.has('LAYOUT_VER')) info.layoutVersion = parseIntegerField('LAYOUT_VER', values.LAYOUT_VER, 0, 1);
    if (['P1', 'P2', 'P3', 'P4'].every(field => seen.has(field))) {
      info.positions = ['P1', 'P2', 'P3', 'P4'].map(field => parseIntegerField(field, values[field], 0, 6));
    } else if (['P1', 'P2', 'P3', 'P4'].some(field => seen.has(field))) {
      throw new Error('INFO response has incomplete startup positions');
    }
    if (['S1', 'S2', 'S3', 'S4'].every(field => seen.has(field))) {
      info.spacing = ['S1', 'S2', 'S3', 'S4'].map(field => parseIntegerField(field, values[field], 0, 6));
    } else if (['S1', 'S2', 'S3', 'S4'].some(field => seen.has(field))) {
      throw new Error('INFO response has incomplete startup spacing');
    }

    return info;
  }

  function assessLayout(info) {
    if ((info.screen !== 0 && info.screen !== 1) || info.font === undefined || !info.positions || !info.spacing) {
      return { kind: 'invalid', message: 'The unit did not provide a complete startup-screen layout. No text was changed.' };
    }
    if (info.screen === 0 && info.layoutVersion !== 1) {
      return { kind: 'invalid', message: 'The unit has no verified startup-layout marker. No text was changed.' };
    }
    if (samePositions(info.positions, STANDARD_POSITIONS)) return { kind: 'standard' };
    if (samePositions(info.positions, LEGACY_OVERLAP_POSITIONS)) {
      return info.layoutCap === 'DEFAULT1'
        ? { kind: 'repairable-overlap' }
        : { kind: 'overlap-without-repair', message: 'Lines 1 and 2 share a vertical position, but this firmware cannot safely repair the layout. No text was changed.' };
    }
    return { kind: 'custom', message: 'This unit has a customised startup layout. Automatic text editing is unavailable until the layout is reviewed. No text was changed.' };
  }

  function isExactlyOneOk(text) {
    const lines = String(text).replace(/\r/g, '').split('\n').filter(Boolean);
    return lines.length === 1 && lines[0] === 'OK';
  }

  async function runStartupTextUpdate({ readInfo, confirmRepair, repairLayout, writeText }) {
    let assessment = assessLayout(await readInfo());
    if (assessment.kind === 'standard') {
      await writeText();
      return { repaired: false, cancelled: false };
    }
    if (assessment.kind !== 'repairable-overlap') {
      throw new Error(assessment.message);
    }
    if (!await confirmRepair()) return { repaired: false, cancelled: true };

    await repairLayout();
    assessment = assessLayout(await readInfo());
    if (assessment.kind !== 'standard') {
      throw new Error('Startup-layout repair could not be verified. No text was changed.');
    }

    await writeText();
    return { repaired: true, cancelled: false };
  }

  return { STANDARD_POSITIONS, parseInfo, isCompleteInfoResponse, assessLayout, isExactlyOneOk, runStartupTextUpdate };
});
