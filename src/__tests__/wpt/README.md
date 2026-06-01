# WPT-derived Web Serial spec-compliance tests

These suites are ported from the official **Web Platform Tests** for the Web
Serial API (vendored in [`tmp/serial/`](../../../tmp/serial)). They run the
spec's own test logic against our `Serial`/`SerialPort` polyfill, driving it
through a `VirtualSerialTransport` "loopback" device — so the W3C behaviour is
verified with no browser and no hardware.

Each file names the WPT source it came from. Helpers in `wpt-helpers.ts`
(`compareArrays`, `readWithLength`) are ports of `tmp/serial/resources/common.js`.

## What runs here

| Suite | WPT source | Covers |
| --- | --- | --- |
| `loopback.wpt.test.ts` | `serialPort_loopback-manual` | small/large writes round-trip byte-exact |
| `flowControl.wpt.test.ts` | `serialPort_loopback_flowControl-manual` | manual RTS→CTS, hardware CTS back-pressure |
| `readable.wpt.test.ts` | `serialPort_readable-manual` | 1 MB PRNG stream, chunked, byte-exact (scaled from 10 MB) |
| `disconnect.wpt.test.ts` | `serialPort_disconnect-manual` | read error → NetworkError + readable cleared |
| `errors.wpt.test.ts` | `serialPort_loopback_BreakError/BufferOverrunError-manual` | typed read errors |
| `idl.wpt.test.ts` | `idlharness.https.any.js` | `Serial`/`SerialPort` interface shape |

## Spec gaps these tests surfaced — and drove fixes for

Porting the WPT faithfully originally exposed five real gaps in the polyfill.
All are now **fixed** (these tests pass as plain `it()` against real polyfill
code); they remain as regression guards.

| Behaviour | WebSerial.ts fix |
| --- | --- |
| Typed read errors (`BreakError`, `BufferOverrunError`, `FramingError`, `ParityError`) on `readable` | the readable's error handler maps the transport's error name onto the `DOMException` (was hard-coded `NetworkError`) |
| Disconnect during read rejects the pending read with `NetworkError` | `handleDeviceLost()` errors the readable controller directly instead of `cancel()` (which fails on a reader-locked stream and orphaned the read) |
| Disconnect during write rejects the pending write with `NetworkError` | `handleDeviceLost()` errors the writable controller (was an `abort()` that rejected with the abort reason) |
| `connect`/`disconnect` observed on `serial` have `target === port` | the event is dispatched on the port and bubbles to the Serial via `setEventParent` (EventTarget now supports event parents) |
| `readable.cancel()` then re-acquire keeps working | `handleClosingReadableStream()` now removes the `onData`/`onError` subscription (it was leaked, breaking the next stream) |

## Not applicable (browser-security tests, intentionally not ported)

These WPT files test the browser security model, which has no meaning for a
React Native / non-browser polyfill:

- `getPorts/reject_opaque_origin.*`, `requestPort/reject_opaque_origin.*` — opaque-origin `SecurityError`
- `getPorts/sandboxed_iframe.*`, `requestPort/sandboxed_iframe.*` — sandboxed-iframe `allow="serial"` delegation
- `serial-*-permissions-policy*.https.sub.html` (5 files) — HTTP `Permissions-Policy` / iframe `allow` enforcement
