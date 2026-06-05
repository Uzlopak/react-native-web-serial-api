#!/usr/bin/env node
/**
 * expose-serial-websocket — bridge a local serial port to a WebSocket so a
 * browser / React Native app can drive it through `WebSocketSerialTransport`.
 *
 * This is a thin Node wrapper: argument parsing and the per-connection wiring
 * live in the package's built `websocket/bridge` module (unit-tested with
 * fakes); here we just supply the real `serialport` and `ws` objects.
 */

let bridge;
try {
  bridge = require('../lib/commonjs/websocket/bridge.js');
} catch (_e) {
  console.error(
    'Could not load the built bridge module. Build the package first ' +
      '(npm run prepare) and try again.',
  );
  process.exit(1);
}
const {attachBridge, parseBridgeArgs, USAGE} = bridge;

function requireOrExit(name) {
  try {
    return require(name);
  } catch (_e) {
    console.error(
      `Missing optional dependency "${name}". Install it on this host:\n` +
        `  npm install ${name}\n`,
    );
    process.exit(1);
  }
}

function main() {
  const args = parseBridgeArgs(process.argv.slice(2), process.env);

  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (!args.port) {
    console.error('Error: --port <path> is required.\n');
    console.error(USAGE);
    process.exit(1);
  }

  const {SerialPort} = requireOrExit('serialport');
  const {WebSocketServer} = requireOrExit('ws');

  const parseHexMaybe = value => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return undefined;
      const base = /^0x/i.test(trimmed) ? 16 : 16;
      const parsed = Number.parseInt(trimmed.replace(/^0x/i, ''), base);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  };

  const normalizeInfo = info => {
    if (!info || typeof info !== 'object') {
      return null;
    }
    const usbVendorId = parseHexMaybe(info.vendorId ?? info.usbVendorId);
    const usbProductId = parseHexMaybe(info.productId ?? info.usbProductId);
    const serialNumber =
      typeof info.serialNumber === 'string' ? info.serialNumber : undefined;
    if (
      usbVendorId === undefined &&
      usbProductId === undefined &&
      serialNumber === undefined
    ) {
      return null;
    }
    return {usbVendorId, usbProductId, serialNumber};
  };

  let cachedPortInfo = null;

  const refreshPortInfo = async () => {
    try {
      const list = await SerialPort.list();
      const match = list.find(p => p.path === args.port);
      cachedPortInfo = normalizeInfo(match);
    } catch {
      // ignore metadata refresh failures
    }
  };

  const serial = new SerialPort({path: args.port, baudRate: args.baudRate});
  // Kick off metadata discovery in parallel; getPortInfo can still fall back to
  // fields directly exposed by the opened serial instance.
  void refreshPortInfo();

  const getPortInfo = () => {
    return (
      cachedPortInfo ??
      normalizeInfo({
        vendorId: serial.vendorId,
        productId: serial.productId,
        serialNumber: serial.serialNumber,
      })
    );
  };

  let serialClosed = false;

  serial.on('error', err => {
    console.error(`serial error: ${err.message}`);
    if (
      err.message.includes('Disconnected') ||
      err.message.includes('No such file')
    ) {
      serialClosed = true;
      if (active) {
        active.close(1011, 'Serial port disconnected');
        active = null;
      }
      process.exit(1); // or attempt to reopen
    }
  });
  serial.on('close', () => {
    console.error('Serial port closed unexpectedly');
    serialClosed = true;
    if (active) {
      active.close(1011, 'Serial port closed');
      active = null;
    }
    process.exit(1);
  });

  const wss = new WebSocketServer({host: args.host, port: args.wsPort});
  let active = null;
  let detachCurrent = null;

  wss.on('connection', ws => {
    if (active) {
      ws.close(1013, 'serial port already in use');
      return;
    }
    if (!serial.isOpen || serialClosed) {
      ws.close(1011, 'serial port not available');
      return;
    }
    active = ws;
    console.log('client connected');
    const detach = attachBridge(serial, ws, {
      log: m => console.error(m),
      portInfo: getPortInfo,
    });
    detachCurrent = detach;

    ws.on('close', () => {
      if (detachCurrent) detachCurrent();
      if (active === ws) active = null;
      detachCurrent = null;
      console.log('client disconnected');
    });
  });

  wss.on('listening', () => {
    console.log(
      `Serial port ${args.port} exposed on ws://${args.host}:${args.wsPort}`,
    );
    if (args.host === '0.0.0.0' || args.allowRemote) {
      console.warn(
        '⚠  Bound to a non-localhost address — your serial port is reachable ' +
          'from the network. Only do this on trusted networks.',
      );
    }
  });
  wss.on('error', err => {
    console.error(`WebSocket server error: ${err.message}`);
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\nshutting down…');
    try {
      wss.close();
    } catch (_e) {}
    try {
      if (serial.isOpen) {
        serial.close();
      }
    } catch (_e) {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
