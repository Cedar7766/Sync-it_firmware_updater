# Sync-it Web Serial Firmware And Startup-Text Interface: Technical Summary
Web Pages repo for updating Sync-its, visit this link in a Chrome browser:<br>
https://cedar7766.github.io/Sync-it_firmware_updater/

## Purpose
This document describes both serial interactions currently implemented across the two Sync-it repositories:

- The browser-based firmware flashing flow in the web updater repository.
- The browser-to-device application protocol used to read and edit the four startup-screen text lines.

The goal is to document the full contract between the web page and the AVR firmware, including request/response behavior, persistence, validation, and the practical display limits seen by users.

## Repositories And Key Files

### Web updater repository
- `index.html`: user interface, Web Serial startup-text workflow, firmware upload orchestration.
- `avrbro.browser.js`: Web Serial transport wrapper plus STK500v1 flasher implementation.
- `firmware/manifest.json`: hosted firmware list for the dropdown.

### Device firmware repository
- `src/setup.cpp`: starts the UART at 57600 on boot.
- `src/loop.cpp`: calls `serialID_poll()` continuously during normal operation.
- `src/serialID.cpp`: implements `ID?`, `INFO?`, `L1=`..`L4=`, and `SAVE`.
- `src/EEPROMFunctions.cpp`: loads and saves startup-screen configuration to EEPROM.
- `src/display.cpp`: renders the personalised startup screen from EEPROM-backed globals.
- `src/startup.cpp`: inserts the personalised screen into the startup-screen sequence.
- `src/sleepWake.cpp`: shuts Serial down before sleep and restores `Serial.begin(57600)` on wake.
- `src/sharedDefinitions.h`: declares the EEPROM-backed startup text buffers as 26-byte arrays.

## Two Distinct Serial Modes
The Sync-it toolchain currently uses the same USB serial connection for two different tasks:

1. Bootloader flashing mode.
2. Application-mode startup-text configuration.

These are separate protocols.

### Bootloader flashing mode
- Triggered by the web updater with a 1200-baud open/close reset pulse.
- Reconnects at 57600 baud and speaks STK500v1 binary frames.
- Used only for flashing Intel HEX firmware.

### Application-mode startup-text mode
- Connects directly at 57600 baud.
- Exchanges newline-terminated ASCII commands and ASCII responses.
- Used for `ID?`, `INFO?`, startup-line staging, and `SAVE`.

## Bootloader Firmware Update Flow
The firmware update path remains unchanged.

### Browser-side flow
1. User selects a hosted HEX file or uploads a local `.hex` file.
2. The browser reads the HEX text before opening the port.
3. The updater analyzes the address map and checks whether the image overlaps the configured bootloader region at `0x7800`.
4. If overlap is detected, the UI warns the user and requires explicit confirmation before proceeding.
5. The browser requests a serial port.
6. The port is opened at 1200 baud, held briefly, then closed to trigger bootloader entry.
7. The same port is reopened at 57600 baud.
8. `AvrSerial` wraps the Web Serial streams.
9. `STK500v1.flashHex()` syncs, enters programming mode, writes 128-byte pages, optionally verifies bootloader-region writes, then leaves programming mode.
10. The page updates the progress bar and final status message.

### STK500v1 framing
The browser sends canonical STK500v1 request frames and expects `0x14 0x10` (`INSYNC`, `OK`) responses.

- Sync: `0x30 0x20`
- Enter programming mode: `0x50 0x20`
- Load address: `0x55 <low> <high> 0x20`
- Program page: `0x64 <len_hi> <len_lo> 0x46 <data...> 0x20`
- Read page: `0x74 <len_hi> <len_lo> 0x46 0x20`
- Leave programming mode: `0x51 0x20`

### Bootloader overwrite protection
- The browser warns before opening the port if the HEX overlaps `0x7800` and above.
- The flasher also rejects bootloader writes unless overwrite was explicitly allowed.
- If overwrite is allowed, the flasher can read back bootloader-region bytes to distinguish:
  - `actualOverwrite`
  - `protected`

## Application Serial Protocol For Startup Text
The startup-text editor uses a small line-oriented ASCII protocol implemented in `src/serialID.cpp`.

### Transport and framing
- Baud rate: 57600.
- Browser sends commands terminated with LF (`\n`).
- Firmware ignores CR (`\r`) while parsing.
- Firmware responses are emitted as CRLF-terminated ASCII lines.
- Commands are processed one line at a time when LF is received.

### Read-only commands
These remain unchanged.

#### `ID?`
- Browser sends: `ID?\n`
- Firmware responds with one line:
  - `ID:<20 hex chars>`

The value comes from the ATmega328PB signature row and is printed as 10 bytes of uppercase hex.

#### `INFO?`
- Browser sends: `INFO?\n`
- Firmware responds with a multi-line ASCII block ending in `END`.

Typical fields include:
- `ID:<hex>`
- `SOURCE=EEPROM` or `SOURCE=LEGACY`
- `EEPROM_IDENTITY=1` or `0`
- `EEPROM_VER=1` when applicable
- `HW=...`
- `FW=...`
- `CAL=...`
- `SN:...`
- `UNIT=...`
- `CUSTOMER=...`
- `CUSTOMER2=...`
- `L1:...`
- `L2:...`
- `L3:...`
- `L4:...`
- `SCREEN=1` or `0`
- `FONT=...`, `P1=...`..`P4=...`, `S1=...`..`S4=...` when `SCREEN=1`
- `END`

### Startup text write protocol
The old single-command form:

```text
TEXT=<line1>|<line2>|<line3>|<line4>
```

is no longer used by the browser and is no longer implemented by the firmware serial handler.

The current staged write flow is:

```text
L1=<text>
L2=<text>
L3=<text>
L4=<text>
SAVE
```

Each command is sent individually and the browser waits for a response before sending the next command.

### Device responses for staged writes
For each `L1=`..`L4=` command and for `SAVE`, the firmware returns exactly one status line:

- `OK`
- `ERR`

On the wire, these are emitted as `OK\r\n` or `ERR\r\n`.

## Current Browser-Side Startup Text Behavior
The startup-text editor is implemented in `index.html`.

### UI behavior
- The page exposes four text boxes, one per startup line.
- The visible UI limit is 12 characters per line.
- Each input shows a live character count such as `7 / 12`.
- Users can read the current lines from the unit or write new values back.

### Why the browser uses 12 characters while the firmware accepts 25
The firmware-side buffers and EEPROM layout can store up to 25 printable ASCII characters per line.

However, the browser intentionally limits editable input to 12 characters because that is the practical visible limit for the current startup-screen presentation on the OLED. This keeps the web UI aligned with what the user can actually see on the device, rather than the full storage capacity.

This means:
- Device storage capacity per line: up to 25 printable ASCII characters.
- Browser edit limit per line: 12 printable ASCII characters.
- Browser display of `INFO?` line text: also truncated to 12 characters before placing values back into the editor.

### Browser read flow
When the user clicks read:
1. The page opens a Web Serial session at 57600 baud.
2. It waits for the application boot delay configured in the page.
3. It sends `INFO?\n`.
4. It reads text until it has seen enough output to parse `L1:` through `L4:`.
5. It extracts those four lines and updates the four inputs.
6. It ignores the rest of the `INFO?` fields for UI purposes.

The browser does not use `SCREEN=`, `FONT=`, `P1`..`P4`, or `S1`..`S4` to drive the current editor UI.

### Browser write flow
When the user clicks update:
1. The page validates all four input lines first.
2. It opens one Web Serial session at 57600 baud.
3. It sends `L1=<text>\n` and waits for `OK`.
4. It sends `L2=<text>\n` and waits for `OK`.
5. It sends `L3=<text>\n` and waits for `OK`.
6. It sends `L4=<text>\n` and waits for `OK`.
7. It sends `SAVE\n` and waits for `OK`.
8. It closes the session.
9. It opens a fresh read session and issues `INFO?\n` to refresh the editor from the device.

This sequencing is deliberate. The commands are not concatenated into one blob. The browser sends one command at a time and waits for a status result before continuing.

### Browser-side validation rules
Before any write is attempted, the page enforces:
- maximum 12 characters per line in the editor
- printable ASCII only
- empty string allowed
- CR and LF removed from editor input

### Browser-side error handling
If any staged command returns `ERR` or fails to return `OK` before timeout:
- the sequence stops immediately
- no later commands are sent
- the UI reports which step failed
- the page does not report write success

The browser currently retries application-mode commands a small number of times before surfacing timeout failure.

## Current Firmware-Side Startup Text Behavior
The startup-text serial protocol is implemented in `src/serialID.cpp`.

### Serial parser design
- The parser is non-blocking and polled from the main loop via `serialID_poll()`.
- It collects one ASCII line at a time into a fixed buffer.
- CR is ignored.
- LF terminates the command.
- Recognized commands are dispatched immediately.
- If the line buffer overflows, the parser resets its position and discards the partial command.

### Supported commands
- `ID?`
- `INFO?`
- `L1=<text>`
- `L2=<text>`
- `L3=<text>`
- `L4=<text>`
- `SAVE`

### Firmware validation rules for `L1=`..`L4=`
Each line value must satisfy all of the following:
- length 0 to 25 characters
- printable ASCII only, decimal 32 through 126
- must not contain `|`
- must not contain CR or LF

If valid:
- the target RAM buffer (`startupLine1`..`startupLine4`) is updated immediately
- the firmware replies `OK`

If invalid:
- the target line is not updated
- the firmware replies `ERR`

### Important staging behavior
`L1=`..`L4=` only update the in-memory startup-line globals. They do not persist anything by themselves.

Persistence happens only when `SAVE` is received.

### Firmware behavior on `SAVE`
When `SAVE` arrives:
1. The firmware recomputes `screenPersonalised` from the current staged RAM values.
2. `screenPersonalised` becomes true if any of the four lines is non-empty.
3. `screenPersonalised` becomes false if all four lines are empty.
4. `saveStartupConfigFromGlobals()` writes the lines and related display settings to EEPROM.
5. The firmware replies `OK`.

This means the clear-screen case is:

```text
L1=
L2=
L3=
L4=
SAVE
```

After that sequence:
- all four startup lines are empty in EEPROM-backed globals
- `screenPersonalised` is saved as false
- `INFO?` reports `SCREEN=0`

## EEPROM And Display Behavior On The Device

### EEPROM-backed startup data
The firmware stores startup-screen content in EEPROM-backed globals loaded by `EEPROMsetupReadWrite()`.

Relevant state includes:
- `startupLine1`..`startupLine4`
- `startupY1`..`startupY4`
- `startupSpacing1`..`startupSpacing4`
- `startupFont`
- `screenPersonalised`

Each startup line buffer is declared as a 26-byte array, allowing 25 characters plus a null terminator.

### Rendering on the OLED
`display.cpp` renders the personalised startup screen from the EEPROM-backed line buffers.

The flow is:
1. The normal startup splash runs.
2. The personalised screen is shown if enabled by the startup-screen state machine.
3. Each line is centered using `oled.strWidth(...)` and the stored Y position / spacing values.

The browser currently edits only line text. It does not edit font, Y positions, or spacing values, but those values remain part of the device-side saved configuration and are visible in `INFO?` output when `SCREEN=1`.

## Sleep/Wake And Serial Availability
The device keeps the application serial interface available during normal operation and restores it after wake:

- `setup()` starts `Serial.begin(57600)` on boot.
- `loop()` continuously calls `serialID_poll()`.
- `goToSleep()` calls `Serial.end()` before power-down.
- `wake()` eventually returns to normal operation.
- `sleepWake.cpp` calls `Serial.begin(57600)` again after waking.

This is why the browser can talk to the application serial protocol both after a cold boot and after a wake event, provided the device is fully awake.

## End-To-End Startup Text Interaction Summary

### Read path
1. Browser opens Web Serial at 57600.
2. Browser sends `INFO?\n`.
3. Firmware parses the line and calls `printInfoBlock()`.
4. Firmware emits identity, calibration, startup-text, and screen metadata lines ending with `END`.
5. Browser parses `L1:`..`L4:` and fills the editor.

### Write path
1. Browser validates four editor values locally.
2. Browser opens Web Serial at 57600.
3. Browser sends `L1=<text>\n`.
4. Firmware validates the line and responds `OK` or `ERR`.
5. Steps 3 and 4 repeat for `L2`, `L3`, and `L4`.
6. Browser sends `SAVE\n`.
7. Firmware updates `screenPersonalised`, writes EEPROM, and returns `OK`.
8. Browser closes the write session, reopens a read session, and sends `INFO?\n` to confirm the persisted values.

## Acceptance Cases Reflected By The Current Implementation

### Normal write
Writing:

```text
L1=SYNC-IT
L2=UNIT 1234
L3=ACME FILMS
L4=READY
SAVE
```

should succeed if each line is valid. A subsequent `INFO?` should report:

```text
L1:SYNC-IT
L2:UNIT 1234
L3:ACME FILMS
L4:READY
```

### Clear startup text
Writing:

```text
L1=
L2=
L3=
L4=
SAVE
```

should leave all startup lines empty and produce `SCREEN=0` in the next `INFO?` output.

### Invalid staged line
If a staged line contains non-printable data or exceeds the firmware-side line limit, the firmware returns `ERR` and the browser stops the sequence.

### Browser-side visible length enforcement
If the user tries to enter more than 12 characters in the web page, the editor prevents it before the command is sent.

## Practical Notes
- The firmware application protocol is intentionally simple and explicit to save AVR flash and RAM.
- The staged `L1`..`L4` plus `SAVE` design avoids assembling one larger `TEXT=` payload on the device.
- The device remains the source of truth for persisted startup text; the browser always refreshes from `INFO?` after writing.
- The browser UI is intentionally stricter than the device storage format because the displayable width is smaller than EEPROM capacity.
