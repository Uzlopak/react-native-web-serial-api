/**
 * Imports every barrel / platform-stub file that would otherwise sit at 0%
 * statement coverage.  No assertions needed — just executing the module-level
 * code (re-exports, TurboModuleRegistry.get(), navigator.serial accessor) is
 * enough for Istanbul/c8 to record the statements as covered.
 */
import {expect, it} from '@jest/globals';
import * as _main from '../index';
import * as _NativeUsbSerial from '../NativeUsbSerial';
import _NativeUsbSerialWeb from '../NativeUsbSerial.web';
import * as _serial from '../serial';
import * as _serialAndroid from '../serial.android';
import * as _serialWeb from '../serial.web';
import * as _testing from '../testing/index';
import * as _websocket from '../websocket/index';

it('all barrel and platform files are importable', () => {
  expect(_main).toBeDefined();
  expect(_testing).toBeDefined();
  expect(_websocket).toBeDefined();
  expect(_NativeUsbSerialWeb).toBeNull();
  expect(_serial).toBeDefined();
  expect(_serialAndroid).toBeDefined();
  expect(_serialWeb).toBeDefined();
  expect(_NativeUsbSerial).toBeDefined();
});
