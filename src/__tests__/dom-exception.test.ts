/**
 * Unit tests for the DOMException polyfill class. The package exports the native
 * DOMException when one exists (it does under Node/Jest), so the polyfill class
 * is tested directly here.
 */
import {describe, expect, it, jest} from '@jest/globals';
import {DOM_EXCEPTION_CODES, DOMExceptionPolyfill} from '../lib/dom-exception';

describe('DOMExceptionPolyfill', () => {
  it('maps a known name to its legacy code', () => {
    const e = new DOMExceptionPolyfill('boom', 'NetworkError');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('NetworkError');
    expect(e.message).toBe('boom');
    expect(e.code).toBe(19);
    expect(e.toString()).toBe('NetworkError: boom');
  });

  it('defaults to name "Error", empty message, code 0', () => {
    const e = new DOMExceptionPolyfill();
    expect(e.name).toBe('Error');
    expect(e.message).toBe('');
    expect(e.code).toBe(0);
  });

  it('uses code 0 for an unknown name', () => {
    expect(new DOMExceptionPolyfill('x', 'TotallyMadeUpError').code).toBe(0);
  });

  it('exposes the legacy code constants as static and instance members', () => {
    const constants: Record<string, number> = {
      INDEX_SIZE_ERR: 1,
      DOMSTRING_SIZE_ERR: 2,
      HIERARCHY_REQUEST_ERR: 3,
      WRONG_DOCUMENT_ERR: 4,
      INVALID_CHARACTER_ERR: 5,
      NO_DATA_ALLOWED_ERR: 6,
      NO_MODIFICATION_ALLOWED_ERR: 7,
      NOT_FOUND_ERR: 8,
      NOT_SUPPORTED_ERR: 9,
      INUSE_ATTRIBUTE_ERR: 10,
      INVALID_STATE_ERR: 11,
      SYNTAX_ERR: 12,
      INVALID_MODIFICATION_ERR: 13,
      NAMESPACE_ERR: 14,
      INVALID_ACCESS_ERR: 15,
      VALIDATION_ERR: 16,
      TYPE_MISMATCH_ERR: 17,
      SECURITY_ERR: 18,
      NETWORK_ERR: 19,
      ABORT_ERR: 20,
      URL_MISMATCH_ERR: 21,
      QUOTA_EXCEEDED_ERR: 22,
      TIMEOUT_ERR: 23,
      INVALID_NODE_TYPE_ERR: 24,
      DATA_CLONE_ERR: 25,
    };
    const instance = new DOMExceptionPolyfill() as unknown as Record<
      string,
      number
    >;
    const ctor = DOMExceptionPolyfill as unknown as Record<string, number>;
    for (const [key, value] of Object.entries(constants)) {
      expect(ctor[key]).toBe(value);
      expect(instance[key]).toBe(value);
    }
  });

  it('covers every named code via the constructor', () => {
    for (const [name, code] of Object.entries(DOM_EXCEPTION_CODES)) {
      expect(new DOMExceptionPolyfill('', name).code).toBe(code);
    }
  });

  it('works when Error.captureStackTrace is unavailable', () => {
    const original = (Error as ErrorConstructor).captureStackTrace;
    delete (Error as {captureStackTrace?: unknown}).captureStackTrace;
    try {
      const e = new DOMExceptionPolyfill('no-capture', 'AbortError');
      expect(e.name).toBe('AbortError');
      expect(e.message).toBe('no-capture');
    } finally {
      (Error as ErrorConstructor).captureStackTrace = original;
    }
  });

  it('exports the polyfill constructor when global DOMException is missing', () => {
    const original = (globalThis as Record<string, unknown>).DOMException;
    delete (globalThis as Record<string, unknown>).DOMException;

    try {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../lib/dom-exception') as {
          DOMException: unknown;
          DOMExceptionPolyfill: unknown;
        };
        expect(mod.DOMException).toBe(mod.DOMExceptionPolyfill);
      });
    } finally {
      (globalThis as Record<string, unknown>).DOMException = original;
    }
  });
});
