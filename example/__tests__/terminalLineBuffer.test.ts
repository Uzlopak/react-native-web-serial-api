import {describe, expect, it} from '@jest/globals';
import {
  appendTerminalSpans,
  applyTerminalLogOps,
  clearTerminalLineBuffer,
  createTerminalLineBuffer,
  dropTrailingCaretM,
  type TerminalSpan,
} from '../src/util/TerminalLineBuffer';

const RED = '#f00';
const GREEN = '#0f0';

function plain(text: string, color = RED): TerminalSpan {
  return {text, color, caret: false};
}

describe('TerminalLineBuffer', () => {
  it('starts from a custom id and preserves the next id after clear', () => {
    const initial = createTerminalLineBuffer(42);
    expect(initial.lines).toEqual([{id: 42, spans: []}]);
    expect(initial.nextId).toBe(43);

    const cleared = clearTerminalLineBuffer(initial);
    expect(cleared.lines).toEqual([{id: 43, spans: []}]);
    expect(cleared.nextId).toBe(44);
  });

  it('splits incoming spans into discrete lines', () => {
    const next = appendTerminalSpans(
      createTerminalLineBuffer(),
      [plain('one\ntwo\n')],
      50,
    );

    expect(next.lines).toHaveLength(3);
    expect(next.lines[0].spans.map(s => s.text).join('')).toBe('one');
    expect(next.lines[1].spans.map(s => s.text).join('')).toBe('two');
    expect(next.lines[2].spans).toHaveLength(0);
  });

  it('preserves caret and color metadata across appended spans', () => {
    const next = appendTerminalSpans(
      createTerminalLineBuffer(),
      [
        {text: '^M', color: GREEN, caret: true},
        {text: 'tail', color: RED, caret: false},
      ],
      50,
    );

    expect(next.lines[0].spans).toEqual([
      {text: '^M', color: GREEN, caret: true},
      {text: 'tail', color: RED, caret: false},
    ]);
  });

  it('initializes empty buffers, ignores empty spans, and honors the minimum line cap', () => {
    const next = appendTerminalSpans(
      {lines: [], nextId: 7},
      [{text: '', color: GREEN, caret: false}, plain('\nX', GREEN)],
      0,
    );

    expect(next.lines).toHaveLength(1);
    expect(next.lines[0]).toEqual({
      id: 8,
      spans: [{text: 'X', color: GREEN, caret: false}],
    });
    expect(next.nextId).toBe(9);
  });

  it('drops only a trailing caret ^M from the latest non-empty line', () => {
    const state = appendTerminalSpans(
      createTerminalLineBuffer(),
      [plain('ab'), {text: '^M', color: GREEN, caret: true}],
      50,
    );

    const next = dropTrailingCaretM(state);
    expect(next.lines[0].spans).toEqual([
      {text: 'ab', color: RED, caret: false},
    ]);
  });

  it('leaves buffers unchanged when there is nothing to trim', () => {
    const state = {
      lines: [{id: 1, spans: [{text: '^M', color: GREEN, caret: false}]}],
      nextId: 2,
    };
    expect(dropTrailingCaretM(state)).toEqual(state);
    const empty = {lines: [{id: 1, spans: []}], nextId: 2};
    expect(dropTrailingCaretM(empty)).toBe(empty);
  });

  it('does not trim other trailing caret escapes', () => {
    const state = appendTerminalSpans(
      createTerminalLineBuffer(),
      [plain('ab'), {text: '^J', color: GREEN, caret: true}],
      50,
    );

    expect(dropTrailingCaretM(state)).toEqual(state);
  });

  it('caps old lines and keeps the latest tail', () => {
    let state = createTerminalLineBuffer();
    for (let i = 1; i <= 6; i++) {
      state = appendTerminalSpans(state, [plain(`L${i}\n`)], 3);
    }
    expect(state.lines).toHaveLength(3);
    expect(state.lines.map(l => l.spans.map(s => s.text).join(''))).toEqual([
      'L5',
      'L6',
      '',
    ]);
  });

  it('supports queued ops for append/drop/clear', () => {
    const next = applyTerminalLogOps(
      createTerminalLineBuffer(),
      [
        {
          type: 'append',
          spans: [plain('A'), {text: '^M', color: GREEN, caret: true}],
        },
        {type: 'dropTrailingCaretM'},
        {type: 'clear'},
        {type: 'append', spans: [plain('B\n')]},
      ],
      50,
    );
    expect(next.lines.map(l => l.spans.map(s => s.text).join(''))).toEqual([
      'B',
      '',
    ]);

    const cleared = clearTerminalLineBuffer(next);
    expect(cleared.lines).toHaveLength(1);
    expect(cleared.lines[0].spans).toHaveLength(0);
    expect(cleared.nextId).toBeGreaterThan(next.nextId);
  });

  it('supports a standalone clear op in the log pipeline', () => {
    const next = applyTerminalLogOps(
      createTerminalLineBuffer(9),
      [{type: 'clear'}],
      50,
    );

    expect(next.lines).toEqual([{id: 10, spans: []}]);
    expect(next.nextId).toBe(11);
  });

  it('returns the same buffer when there are no log ops', () => {
    const state = createTerminalLineBuffer(9);
    expect(applyTerminalLogOps(state, [], 50)).toBe(state);
  });
});
