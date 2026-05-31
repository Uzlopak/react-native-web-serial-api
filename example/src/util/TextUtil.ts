// Ported from SimpleUsbTerminal TextUtil.java

export const NEWLINE_CRLF = '\r\n';
export const NEWLINE_LF = '\n';

/** A run of text; `caret` runs (^X control-char notation) get a gray background. */
export type Run = {text: string; caret: boolean};

/** Parse a hex string ("AA BB CC" / "aabbcc") into bytes, ignoring non-hex chars. */
export function fromHexString(s: string): Uint8Array {
  const out: number[] = [];
  let b = 0;
  let nibble = 0;
  for (let i = 0; i < s.length; i++) {
    if (nibble === 2) {
      out.push(b & 0xff);
      nibble = 0;
      b = 0;
    }
    const c = s.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) {
      nibble++;
      b = b * 16 + (c - 0x30);
    } else if (c >= 0x41 && c <= 0x46) {
      nibble++;
      b = b * 16 + (c - 0x41 + 10);
    } else if (c >= 0x61 && c <= 0x66) {
      nibble++;
      b = b * 16 + (c - 0x61 + 10);
    }
  }
  if (nibble > 0) {
    out.push(b & 0xff);
  }
  return Uint8Array.from(out);
}

/** Format bytes as space-separated uppercase hex: "AA BB CC". */
export function toHexString(buf: Uint8Array | number[]): string {
  let sb = '';
  for (let i = 0; i < buf.length; i++) {
    if (sb.length > 0) {
      sb += ' ';
    }
    sb += (buf[i] & 0xff).toString(16).toUpperCase().padStart(2, '0');
  }
  return sb;
}

/** HexWatcher formatting: keep only hex chars, uppercase, group into pairs. */
export function formatHexInput(s: string): string {
  let hex = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
      hex += c;
    } else if (c >= 'a' && c <= 'f') {
      hex += c.toUpperCase();
    }
  }
  let grouped = '';
  for (let i = 0; i < hex.length; i++) {
    if (i > 0 && i % 2 === 0) {
      grouped += ' ';
    }
    grouped += hex[i];
  }
  return grouped;
}

/**
 * Caret notation (https://en.wikipedia.org/wiki/Caret_notation) so invisible
 * control characters are shown as ^X with a highlighted background.
 */
export function toCaretRuns(s: string, keepNewline: boolean): Run[] {
  const runs: Run[] = [];
  let plain = '';
  const flush = () => {
    if (plain) {
      runs.push({text: plain, caret: false});
      plain = '';
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch < 32 && !(keepNewline && ch === 10)) {
      flush();
      runs.push({text: `^${String.fromCharCode(ch + 64)}`, caret: true});
    } else {
      plain += s[i];
    }
  }
  flush();
  return runs;
}

const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Decode received bytes to a string (UTF-8 when available, else Latin-1). */
export function bytesToString(data: Uint8Array): string {
  if (decoder) {
    return decoder.decode(data);
  }
  let s = '';
  for (let i = 0; i < data.length; i++) {
    s += String.fromCharCode(data[i]);
  }
  return s;
}

/** Encode a string to UTF-8 bytes for sending. */
export function stringToBytes(str: string): Uint8Array {
  if (encoder) {
    return encoder.encode(str);
  }
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return Uint8Array.from(out);
}
