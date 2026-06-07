/**
 * @format
 */

import {describe, expect, it} from '@jest/globals';
import * as TextUtil from '../../src/util/TextUtil';

describe('TextUtil', () => {
  it('parses and formats hex strings', () => {
    expect(TextUtil.fromHexString('AA bb cc')).toEqual(
      Uint8Array.from([0xaa, 0xbb, 0xcc]),
    );
    expect(TextUtil.fromHexString('f1-2')).toEqual(
      Uint8Array.from([0xf1, 0x02]),
    );
    expect(TextUtil.fromHexString('!')).toEqual(Uint8Array.from([]));
    expect(TextUtil.toHexString([0, 15, 255])).toBe('00 0F FF');
    expect(TextUtil.toHexString([])).toBe('');
    expect(TextUtil.formatHexInput('abCD-12')).toBe('AB CD 12');
  });

  it('converts control characters to caret runs', () => {
    expect(TextUtil.toCaretRuns('A\tB\n', false)).toEqual([
      {text: 'A', caret: false},
      {text: '^I', caret: true},
      {text: 'B', caret: false},
      {text: '^J', caret: true},
    ]);
    expect(TextUtil.toCaretRuns('A\tB\n', true)).toEqual([
      {text: 'A', caret: false},
      {text: '^I', caret: true},
      {text: 'B\n', caret: false},
    ]);
    expect(TextUtil.toCaretRuns('\u0001A', false)).toEqual([
      {text: '^A', caret: true},
      {text: 'A', caret: false},
    ]);
  });

  it('encodes and decodes strings', () => {
    const bytes = TextUtil.stringToBytes('Hi!');
    expect(Array.from(bytes)).toEqual([72, 105, 33]);
    expect(TextUtil.bytesToString(Uint8Array.from([72, 105, 33]))).toBe(
      'Hi!',
    );
  });

  it('falls back when text encoders are unavailable', () => {
    const globalAny = globalThis as typeof globalThis & {
      TextDecoder?: typeof TextDecoder;
      TextEncoder?: typeof TextEncoder;
    };
    const originalDecoder = globalAny.TextDecoder;
    const originalEncoder = globalAny.TextEncoder;
    let fallback: typeof TextUtil | undefined;

    try {
      globalAny.TextDecoder = undefined as any;
      globalAny.TextEncoder = undefined as any;

      jest.isolateModules(() => {
        fallback = require('../../src/util/TextUtil') as typeof TextUtil;
      });

      expect(
        fallback?.bytesToString(Uint8Array.from([0x48, 0xe9])),
      ).toBe('Hé');
      expect(Array.from(fallback?.stringToBytes('Hé') ?? [])).toEqual([
        0x48,
        0xc3,
        0xa9,
      ]);
      expect(Array.from(fallback?.stringToBytes('€') ?? [])).toEqual([
        0xe2,
        0x82,
        0xac,
      ]);
    } finally {
      globalAny.TextDecoder = originalDecoder;
      globalAny.TextEncoder = originalEncoder;
    }
  });
});
