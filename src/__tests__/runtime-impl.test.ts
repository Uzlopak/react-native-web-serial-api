import {describe, expect, it, jest} from '@jest/globals';

type Globals = Record<string, unknown>;

function withPatchedGlobal<T>(
  key: string,
  value: unknown,
  run: () => T,
): T {
  const g = globalThis as Globals;
  const had = Object.prototype.hasOwnProperty.call(g, key);
  const prev = g[key];
  if (value === undefined) {
    delete g[key];
  } else {
    g[key] = value;
  }
  try {
    return run();
  } finally {
    if (had) {
      g[key] = prev;
    } else {
      delete g[key];
    }
  }
}

describe('runtime implementation selectors', () => {
  it('prefers runtime WebStreams constructors when available', () => {
    const mod = require('../lib/web-streams') as {
      ReadableStreamImpl: unknown;
      WritableStreamImpl: unknown;
      ByteLengthQueuingStrategyImpl: unknown;
    };

    expect(mod.ReadableStreamImpl).toBe((globalThis as Globals).ReadableStream);
    expect(mod.WritableStreamImpl).toBe((globalThis as Globals).WritableStream);
    expect(mod.ByteLengthQueuingStrategyImpl).toBe(
      (globalThis as Globals).ByteLengthQueuingStrategy,
    );
  });

  it('falls back to polyfill WebStreams constructors when globals are missing', () => {
    withPatchedGlobal('ReadableStream', undefined, () => {
      withPatchedGlobal('WritableStream', undefined, () => {
        withPatchedGlobal('ByteLengthQueuingStrategy', undefined, () => {
          jest.isolateModules(() => {
            const mod = require('../lib/web-streams') as {
              ReadableStreamImpl: unknown;
              WritableStreamImpl: unknown;
              ByteLengthQueuingStrategyImpl: unknown;
              ReadableStreamPolyfill: unknown;
              WritableStreamPolyfill: unknown;
              ByteLengthQueuingStrategyPolyfill: unknown;
            };
            expect(mod.ReadableStreamImpl).toBe(mod.ReadableStreamPolyfill);
            expect(mod.WritableStreamImpl).toBe(mod.WritableStreamPolyfill);
            expect(mod.ByteLengthQueuingStrategyImpl).toBe(
              mod.ByteLengthQueuingStrategyPolyfill,
            );
          });
        });
      });
    });
  });

  it('prefers runtime DOMException and EventTarget when available', () => {
    const mod = require('../lib/dom-exception') as {DOMExceptionImpl: unknown};
    const evt = require('../lib/event-target') as {
      EventImpl: unknown;
      EventTargetImpl: unknown;
    };

    expect(mod.DOMExceptionImpl).toBe((globalThis as Globals).DOMException);
    expect(evt.EventImpl).toBe((globalThis as Globals).Event);
    expect(evt.EventTargetImpl).toBe((globalThis as Globals).EventTarget);
  });

  it('falls back for DOMException and EventTarget when globals are missing', () => {
    withPatchedGlobal('DOMException', undefined, () => {
      withPatchedGlobal('Event', undefined, () => {
        withPatchedGlobal('EventTarget', undefined, () => {
          jest.isolateModules(() => {
            const dom = require('../lib/dom-exception') as {
              DOMExceptionImpl: unknown;
              DOMExceptionPolyfill: unknown;
            };
            const evt = require('../lib/event-target') as {
              EventImpl: unknown;
              EventTargetImpl: unknown;
              Event: unknown;
              EventTarget: unknown;
            };

            expect(dom.DOMExceptionImpl).toBe(dom.DOMExceptionPolyfill);
            expect(evt.EventImpl).toBe(evt.Event);
            expect(evt.EventTargetImpl).toBe(evt.EventTarget);
          });
        });
      });
    });
  });
});