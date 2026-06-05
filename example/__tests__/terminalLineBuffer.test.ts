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
        {type: 'append', spans: [plain('B\n')]},
      ],
      50,
    );
    expect(next.lines.map(l => l.spans.map(s => s.text).join(''))).toEqual([
      'AB',
      '',
    ]);

    const cleared = clearTerminalLineBuffer(next);
    expect(cleared.lines).toHaveLength(1);
    expect(cleared.lines[0].spans).toHaveLength(0);
    expect(cleared.nextId).toBeGreaterThan(next.nextId);
  });
});
