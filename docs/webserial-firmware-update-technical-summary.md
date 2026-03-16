# Sync-it WebSerial Firmware Updater: Technical Summary

## Purpose
This repository hosts a browser-based firmware updater for Sync-it hardware devices connected over USB serial. The update process runs entirely in the browser via the Web Serial API and flashes Intel HEX firmware to an AVR target using the STK500v1 bootloader protocol.

## Relevant Components
- `index.html` : UI, firmware selection, and upload orchestration.
- `firmware/manifest.json`: List of firmware files exposed in the dropdown.
- `avrbro.browser.js`: Serial transport and STK500v1 flashing implementation.

## End-to-End Update Flow
1. User opens the updater page in a browser that supports Web Serial (`navigator.serial`).
2. Firmware source is selected:
   - Hosted firmware listed from `firmware/manifest.json`, or
   - A local `.hex` file uploaded by the user.
3. User clicks **Connect & Upload**.
4. Updater reads the HEX text before opening the serial port and analyzes its address map.
5. If the HEX reaches the configured bootloader region, the user is warned and must explicitly confirm before flashing proceeds.
6. Browser prompts for a serial device (`navigator.serial.requestPort()`).
7. Updater opens the selected port at **1200 baud**, waits ~250 ms, then closes it.
8. Same port is reopened at **57600 baud** for bootloader communication.
9. `AvrSerial` wraps the Web Serial port streams.
10. `STK500v1.flashHex()` performs protocol sync, enters programming mode, parses HEX, writes pages, optionally verifies bootloader-region writes by reading flash back, and exits programming mode.
11. Progress is reported to the UI progress bar; completion/failure is shown in the status area.
12. Serial resources are closed in `finally` to release the USB port.

## USB/Serial Behavior
- Transport: USB CDC/UART bridge exposed as a serial port.
- Initial 1200-baud open/close: used as a reset trigger pattern before attempting bootloader traffic.
- Bootloader session baud: 57600.
- Serial I/O is asynchronous via `port.readable.getReader()` and `port.writable.getWriter()`.
- Reads use timeout guards to avoid hanging operations.

## Bootloader Protocol (STK500v1)
The updater sends canonical STK500v1-style command frames and expects `0x14 0x10` (`INSYNC`, `OK`) responses.

### Sync
- Command: `0x30 0x20` (Get Sync + EOP)
- Retries: up to 6 attempts with short delay.
- Failure result: `No bootloader sync response`.

### Enter Programming Mode
- Command: `0x50 0x20`

### Load Address
- Command: `0x55 <low> <high> 0x20`
- Address used is word-addressed (`byte_address >> 1`), matching AVR bootloader conventions.

### Program Page
- Command format:
  - `0x64 <len_hi> <len_lo> 0x46 <data...> 0x20`
- Data payload is a flash page chunk from parsed HEX content.
- Response timeout is longer (1000 ms) for page programming latency.

### Read Page
- Command format:
  - `0x74 <len_hi> <len_lo> 0x46 0x20`
- Used after a confirmed bootloader-overwrite attempt to read back programmed bytes and determine whether the bootloader region actually changed.
- Expected response structure:
  - `0x14 <data...> 0x10`

### Leave Programming Mode
- Command: `0x51 0x20`

## HEX Parsing and Flash Mapping
`flashHex()` parses Intel HEX text line-by-line:
- Processes only data records (`type 00`).
- Stops on EOF record (`type 01`).
- Ignores other record types.

Data handling details:
- Data is collected into contiguous regions and emitted as pages.
- Page size used by this updater: **128 bytes**.
- Each page is written using `loadAddress()` then `programPage()`.
- A `dataMap` is also built so individual absolute addresses can be compared during post-flash verification.

## Bootloader Overwrite Detection And Policy
A bootloader-boundary analysis is implemented using a default bootloader start of `0x7800`.

The analyzer records:
- `bootloaderStart = 0x7800`
- The highest addressed byte present in the HEX file
- The first byte address where the HEX overlaps the bootloader region
- Whether the HEX attempts any write into the bootloader region at all

Behavior is split into two layers:
- UI layer: warns the user before any serial connection is opened and requires explicit confirmation to continue.
- Flasher layer: still rejects bootloader-region writes unless `allowBootloaderOverwrite` is explicitly enabled.

This means accidental bootloader overwrites are blocked by default, but intentional testing or recovery flows can still proceed when the user confirms.

## Post-Flash Bootloader Verification
If the user confirms a firmware image that overlaps the bootloader region, the updater can verify what happened after flashing:
- It reads back only the pages that intersect the bootloader region.
- It compares readback bytes against the uploaded HEX image for addresses at or above `0x7800`.
- It classifies the result as one of the following:
  - `actualOverwrite`: all checked bootloader bytes match the uploaded HEX.
  - `protected`: one or more checked bytes differ, indicating that bootloader-region writes were attempted but not fully applied.

This distinction is important because an AVR bootloader may allow application writes while still protecting the bootloader section using lock bits.

## Error Handling and Recovery
- Browser capability check: if Web Serial is unavailable, update is blocked with guidance to use Chrome/Edge over HTTPS.
- Manifest load failure surfaces HTTP/json errors in the UI.
- User cancellation of a bootloader-overwrite warning aborts the upload before any serial activity begins.
- Protocol/timeout failures bubble up as upload failure status.
- Bootloader verification can refine the final status after a successful flash by reporting whether the overwrite was confirmed or the bootloader appears to have remained protected.
- Cleanup runs in `finally`:
  - Attempts `serial.close()` when session wrapper exists.
  - Otherwise closes `port` if still readable/writable.

## UI State and Progress
- Firmware selection and local file upload are mutually exclusive state paths.
- Progress callback updates the `<progress>` value as pages complete.
- Status area reports selection, errors, user cancellation, successful completion, and bootloader verification outcomes.

## Operational Notes for Real Devices
- No other application should hold the serial port during update (for example, serial monitor tools).
- The user must select the USB-UART bridge device exposed by the Sync-it hardware.
- Firmware binaries must be valid Intel HEX and compatible with device memory layout and bootloader assumptions (including 0x7800 bootloader boundary).

## Practical Sequence (Condensed)
1. Select firmware (manifest entry or local HEX).
2. Analyze HEX and detect whether it overlaps the bootloader region.
3. If bootloader overlap is detected, warn the user and require explicit confirmation.
4. Request serial port from browser.
5. 1200-baud reset pulse (open -> wait -> close).
6. Reopen at 57600 baud.
7. STK500 sync.
8. Enter programming mode.
9. Parse HEX -> build 128-byte pages.
10. For each page: load address -> program page -> update progress.
11. If bootloader overwrite was allowed, read back bootloader-region pages and compare them with the HEX image.
12. Leave programming mode.
13. Close serial and report result, including whether a bootloader overwrite was only attempted or actually verified.
