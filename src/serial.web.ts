import type {Serial} from './WebSerial';

// On web, delegate to the browser's native Web Serial API implementation.
// (navigator.serial is not part of TypeScript's standard DOM lib types, so we
// cast through our own structurally-compatible Serial type.)
export default (navigator as unknown as {serial: Serial}).serial;
