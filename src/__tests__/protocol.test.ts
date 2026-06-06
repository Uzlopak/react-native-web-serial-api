/**
 * Tests for the WebSocket wire protocol parser ({@link parseControlMessage}).
 */
import {describe, expect, it} from '@jest/globals';
import {parseControlMessage} from '../websocket/protocol';

describe('parseControlMessage', () => {
  it('parses a valid command message', () => {
    const msg = parseControlMessage(
      JSON.stringify({type: 'command', id: 1, command: 'setLineCoding'}),
    );
    expect(msg).toMatchObject({
      type: 'command',
      id: 1,
      command: 'setLineCoding',
    });
  });

  it('parses a valid response message', () => {
    const msg = parseControlMessage(
      JSON.stringify({type: 'response', id: 2, error: null, result: null}),
    );
    expect(msg).toMatchObject({type: 'response', id: 2});
  });

  it('parses a valid event message', () => {
    const msg = parseControlMessage(
      JSON.stringify({type: 'event', event: 'open'}),
    );
    expect(msg).toMatchObject({type: 'event', event: 'open'});
  });

  it('returns null for invalid JSON (catch branch)', () => {
    const msg = parseControlMessage('not-json');
    expect(msg).toBeNull();
  });

  it('returns null for a non-object JSON value (array)', () => {
    const msg = parseControlMessage(JSON.stringify([1, 2, 3]));
    expect(msg).toBeNull();
  });

  it('returns null for a non-object JSON value (null)', () => {
    // JSON.parse('null') returns null, which is not an object
    const msg = parseControlMessage('null');
    expect(msg).toBeNull();
  });

  it('returns null for an unknown message type', () => {
    const msg = parseControlMessage(JSON.stringify({type: 'unknown'}));
    expect(msg).toBeNull();
  });
});
