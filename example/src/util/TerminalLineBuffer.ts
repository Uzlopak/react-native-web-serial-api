export type TerminalSpan = {text: string; color: string; caret: boolean};

export type TerminalLine = {
  id: number;
  spans: TerminalSpan[];
};

export type TerminalLineBuffer = {
  lines: TerminalLine[];
  nextId: number;
};

export type TerminalLogOp =
  | {type: 'append'; spans: TerminalSpan[]}
  | {type: 'dropTrailingCaretM'}
  | {type: 'clear'};

export function createTerminalLineBuffer(startId = 1): TerminalLineBuffer {
  return {
    lines: [{id: startId, spans: []}],
    nextId: startId + 1,
  };
}

export function clearTerminalLineBuffer(
  state: TerminalLineBuffer,
): TerminalLineBuffer {
  return createTerminalLineBuffer(state.nextId);
}

function cloneLines(lines: TerminalLine[]): TerminalLine[] {
  return lines.map(line => ({id: line.id, spans: line.spans.slice()}));
}

export function appendTerminalSpans(
  state: TerminalLineBuffer,
  spans: TerminalSpan[],
  maxLines: number,
): TerminalLineBuffer {
  const cappedMaxLines = Math.max(1, maxLines);
  const lines = cloneLines(state.lines);
  let nextId = state.nextId;

  if (lines.length === 0) {
    lines.push({id: nextId, spans: []});
    nextId += 1;
  }

  for (const span of spans) {
    if (span.text.length === 0) {
      continue;
    }
    const parts = span.text.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length > 0) {
        const lastLine = lines[lines.length - 1];
        lastLine.spans.push({...span, text: part});
      }
      if (i < parts.length - 1) {
        lines.push({id: nextId, spans: []});
        nextId += 1;
      }
    }
  }

  const nextLines =
    lines.length > cappedMaxLines
      ? lines.slice(lines.length - cappedMaxLines)
      : lines;

  return {
    lines: nextLines,
    nextId,
  };
}

export function dropTrailingCaretM(
  state: TerminalLineBuffer,
): TerminalLineBuffer {
  const lines = cloneLines(state.lines);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.spans.length === 0) {
      continue;
    }
    const last = line.spans[line.spans.length - 1];
    if (last.caret && last.text === '^M') {
      line.spans = line.spans.slice(0, line.spans.length - 1);
    }
    return {lines, nextId: state.nextId};
  }

  return state;
}

export function applyTerminalLogOps(
  state: TerminalLineBuffer,
  ops: TerminalLogOp[],
  maxLines: number,
): TerminalLineBuffer {
  let next = state;
  for (const op of ops) {
    if (op.type === 'append') {
      next = appendTerminalSpans(next, op.spans, maxLines);
    } else if (op.type === 'dropTrailingCaretM') {
      next = dropTrailingCaretM(next);
    } else if (op.type === 'clear') {
      next = createTerminalLineBuffer(next.nextId);
    }
  }
  return next;
}
