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
4. Browser prompts for a serial device (`navigator.serial.requestPort()`).
5. Updater opens the selected port at **1200 baud**, waits ~250 ms, then closes it.
6. Same port is reopened at **57600 baud** for bootloader communication.
7. `AvrSerial` wraps the Web Serial port streams.
8. `STK500v1.flashHex()` performs protocol sync, enters programming mode, parses HEX, writes pages, and exits programming mode.
9. Progress is reported to the UI progress bar; completion/failure is shown in the status area.
10. Serial resources are closed in `finally` to release the USB port.

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

## Flash Safety Constraint
A bootloader-protection check is implemented:
- `bootloaderStart = 0x7800`
- Any data record at or above this address causes an immediate failure.

This prevents accidental writes into the bootloader region.

## Error Handling and Recovery
- Browser capability check: if Web Serial is unavailable, update is blocked with guidance to use Chrome/Edge over HTTPS.
- Manifest load failure surfaces HTTP/json errors in the UI.
- Protocol/timeout failures bubble up as upload failure status.
- Cleanup runs in `finally`:
  - Attempts `serial.close()` when session wrapper exists.
  - Otherwise closes `port` if still readable/writable.

## UI State and Progress
- Firmware selection and local file upload are mutually exclusive state paths.
- Progress callback updates the `<progress>` value as pages complete.
- Status area reports selection, errors, and successful completion.

## Operational Notes for Real Devices
- No other application should hold the serial port during update (for example, serial monitor tools).
- The user must select the USB-UART bridge device exposed by the Sync-it hardware.
- Firmware binaries must be valid Intel HEX and compatible with device memory layout and bootloader assumptions (including 0x7800 bootloader boundary).

## Practical Sequence (Condensed)
1. Select firmware (manifest entry or local HEX).
2. Request serial port from browser.
3. 1200-baud reset pulse (open -> wait -> close).
4. Reopen at 57600 baud.
5. STK500 sync.
6. Enter programming mode.
7. Parse HEX -> build 128-byte pages.
8. For each page: load address -> program page -> update progress.
9. Leave programming mode.
10. Close serial and report result.
