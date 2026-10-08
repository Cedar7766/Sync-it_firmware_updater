# Legacy Watterott Optiboot Web Serial upload failure — October 2026

## Summary

A Sync-it customer reported that the public Web Serial firmware updater stopped during an upload of `Sync-it-firmware-v3.53.hex` with the message, “Programming stopped before completion. Please try the update again.” The unit was then unresponsive and repeated browser uploads failed.

The fault was reproduced on a test unit configured with the original manufacturing procedure. The browser-side STK500v1 receive framing was corrected and validated on both the legacy and current production bootloaders. This report records the evidence, limits of the conclusion, recovery, and validation.

## Original hardware configuration

- MCU: ATmega328PB at 16 MHz.
- Legacy bootloader: Watterott Optiboot, likely installed in January 2025.
- Original fuse/lock bytes: `FF,D6,F5,FF` (low, high, extended, lock).
- The `D6` high fuse selects the 512-byte boot section at `0x7E00`–`0x7FFF`.
- Protocol: STK500v1 over UART at 57,600 baud.
- The original bootloader binary is believed to have been `optiboot_m328pb.hex`; the exact customer installation has not been independently confirmed.

## Reproduced browser failure

The browser synchronised, entered programming mode, and appeared to write the first 128-byte page. Initial synchronisation needed several retries and responses were delayed and fragmented. The relevant STK500v1 frames were:

| Operation | Browser request | Observed response |
| --- | --- | --- |
| Sync | `30 20` | Delayed/fragmented `14 10` after several attempts |
| Enter programming mode | `50 20` | `14 10 14 10` |
| Page 1 load address (`0x0000`) | `55 00 00 20` | Reported successful |
| Page 1 program (128 bytes) | `64 00 80 46 <128 data bytes> 20` | `14`, then `10`; both logged after about 4 ms |
| Page 2 load address (`0x0080`) | `55 40 00 20` | `14`, then timeout waiting for `10` |

`14` is `STK_INSYNC` and `10` is `STK_OK`. The relevant console sequence was:

```text
STK500 sync succeeded
STK500 TX: 50 20
STK500 RX: 14 10 14 10

Programming page 1/252, address 0x0000
LOAD_ADDRESS successful
PROG_PAGE successful
INSYNC received after 4 ms
OK received after 4 ms

Programming page 2/252, address 0x0080
STK500 TX: 55 40 00 20
STK500 RX: 14
load address: Read timeout (pair)
```

No later pages were programmed. The partial application write explains why the unit no longer ran its prior application; it does not by itself prove the bootloader was damaged.

## Recovery investigation

AVRDUDE 8.1 initially communicated with the legacy bootloader and read the ATmega328PB signature `1E 95 16`. One subsequent communication attempt failed, but communication returned after a USB power cycle. No USBasp or ISP recovery was required on the test unit.

The normal USB serial interface then wrote and verified all 32,112 bytes of v3.53 successfully:

```bash
avrdude -p m328pb -c arduino \
  -P /dev/cu.usbserial-117 -b 57600 \
  -U flash:w:Sync-it-firmware-v3.53.hex:i
```

This established that the reproduced unit could still be programmed through the legacy serial bootloader and focused investigation on browser-side transaction sequencing rather than an inherent inability of the legacy bootloader to write the image.

## Root-cause investigation

### Confirmed implementation defect

The prior `readBytePair()` receive routine scanned its buffered bytes until it found `14 10`, discarding any preceding bytes. It therefore had no command-to-response boundary: a complete acknowledgement left by an earlier command could be accepted as the acknowledgement for a later command. It also silently discarded malformed or unexpected bytes while searching for a pair.

This was unsafe after a retry or delayed serial response. In particular, the browser could send `LOAD_ADDRESS`, accept an earlier `14 10` as its success, and immediately send `PROGRAM_PAGE` although the addressed command had not yet been confirmed.

### Evidence of response misalignment

The duplicated `14 10` immediately after `ENTER_PROGMODE`, the unusually fast page-1 acknowledgement, and the lone `14` at the next `LOAD_ADDRESS` are evidence that response framing was not aligned with the command sequence. The old receive implementation permitted that misalignment to cascade into later commands.

### What remains a hypothesis

The precise source of the duplicated acknowledgements was not conclusively established. Plausible explanations include a late reply from a prior sync retry, serial/USB buffering and delivery timing, or another source of duplicated data. Likewise, one plausible sequence is that page 1 consumed the pending `LOAD_ADDRESS` response as its programming acknowledgement, leaving the actual page-program `14` to be seen by page 2. The trace is consistent with that sequence, but does not prove it. This report does not attribute duplicated acknowledgements to a bootloader defect.

## Implemented correction

The Web Serial updater was changed only in its host-side STK500v1 framing:

- Response pairs are parsed strictly in order: `14` followed by `10`. Unexpected bytes fail the command instead of being scanned past.
- A successful `GET_SYNC` must be followed by a 25 ms quiet window. A delayed or duplicate response during that window rejects the tentative sync and performs a fresh synchronisation attempt.
- Buffered receive bytes before non-sync commands are rejected, so they cannot acknowledge a different command.
- Buffered bytes discarded between sync retries are logged with their hexadecimal values; unexpected responses are not silently discarded.

The correction does not change DTR, RTS, or 1200-baud reset fallback behaviour; baud rate; STK500v1 command bytes; 128-byte page size; word addressing; bootloader firmware; or the policy not to automatically retry an ambiguous flash page write.

## Validation

Host-side validation completed successfully:

- Mock serial transport tests: 7 passed, 0 failed.
- `node --check avrbro.browser.js`: passed.
- `git diff --check`: passed.

Hardware validation completed successfully:

| Test | Result |
| --- | --- |
| A1 — legacy Watterott, first upload | PASS |
| A2 — legacy Watterott, repeat after USB power cycle | PASS |
| B1 — current custom Sync-it bootloader, first upload | PASS |
| B2 — current custom Sync-it bootloader, repeat after USB power cycle | PASS |

Browser upload completion is based on successful STK500 programming acknowledgements. It is not presently based on a full flash readback verification of the application image.

## Customer implications and remaining work

- The reproduced failure was recoverable through serial programming and did not require ISP.
- The customer's actual device has not yet been recovered or independently diagnosed.
- Full application-flash readback verification remains a separate improvement.
- Production bootloader-region write protection should be strengthened separately.
- More validation across additional hardware units and USB/host combinations is desirable.
