import {
  ByteLengthQueuingStrategy as ByteLengthQueuingStrategyPolyfill,
  ReadableStream as ReadableStreamPolyfill,
  WritableStream as WritableStreamPolyfill,
} from 'web-streams-polyfill';

type MaybeGlobal = Record<string, unknown>;

function getCtor<T>(name: string, fallback: T): T {
  const value = (globalThis as MaybeGlobal)[name];
  return typeof value === 'function' ? (value as T) : fallback;
}

export {
  ByteLengthQueuingStrategyPolyfill,
  ReadableStreamPolyfill,
  WritableStreamPolyfill,
};

export const ReadableStreamImpl = getCtor(
  'ReadableStream',
  ReadableStreamPolyfill,
);

export const WritableStreamImpl = getCtor(
  'WritableStream',
  WritableStreamPolyfill,
);

export const ByteLengthQueuingStrategyImpl = getCtor(
  'ByteLengthQueuingStrategy',
  ByteLengthQueuingStrategyPolyfill,
);

// Companion TYPE aliases so that `Impl as X` imports carry a type too. Without
// these, an annotation like `ReadableStream<Uint8Array>` (where `ReadableStream`
// is the imported value) falls back to the ambient *global* ReadableStream and
// no longer matches the polyfill instances actually constructed — the runtime
// pick stays native-or-polyfill; only the static type is anchored to the
// (structurally faithful) polyfill instance type.
export type ReadableStreamImpl<R = unknown> = ReadableStreamPolyfill<R>;
export type WritableStreamImpl<W = unknown> = WritableStreamPolyfill<W>;
export type ByteLengthQueuingStrategyImpl = ByteLengthQueuingStrategyPolyfill;