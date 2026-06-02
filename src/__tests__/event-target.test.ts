/**
 * Unit tests for the Event/EventTarget polyfill — exercises the parts the serial
 * suites don't (Event methods, listener options, parent bubbling).
 */
import {describe, expect, it, jest} from '@jest/globals';
import {Event, EventTarget, setEventParent} from '../lib/event-target';

describe('Event', () => {
  it('preventDefault only takes effect when cancelable', () => {
    const plain = new Event('x');
    plain.preventDefault();
    expect(plain.defaultPrevented).toBe(false);

    const cancelable = new Event('x', {cancelable: true});
    cancelable.preventDefault();
    expect(cancelable.defaultPrevented).toBe(true);
  });

  it('stopPropagation / stopImmediatePropagation set cancelBubble', () => {
    const a = new Event('x');
    a.stopPropagation();
    expect(a.cancelBubble).toBe(true);

    const b = new Event('x');
    b.stopImmediatePropagation();
    expect(b.cancelBubble).toBe(true);
  });

  it('composedPath() and initEvent()', () => {
    const e = new Event('x');
    expect(e.composedPath()).toEqual([]);
    e.initEvent('y', true, true);
    expect(e.type).toBe('y');
    expect(e.bubbles).toBe(true);
    expect(e.cancelable).toBe(true);
  });

  it('initEvent defaults bubbles/cancelable to false', () => {
    const e = new Event('x', {bubbles: true, cancelable: true});
    e.initEvent('z');
    expect(e.type).toBe('z');
    expect(e.bubbles).toBe(false);
    expect(e.cancelable).toBe(false);
  });
});

describe('EventTarget', () => {
  it('dispatches to a listener with the target set', () => {
    const t = new EventTarget();
    let target: EventTarget | null = null;
    let path: EventTarget[] = [];
    t.addEventListener('e', ev => {
      target = ev.target;
      path = ev.composedPath();
    });
    t.dispatchEvent(new Event('e'));
    expect(target).toBe(t);
    expect(path).toEqual([t]);
  });

  it('ignores a duplicate listener registration', () => {
    const t = new EventTarget();
    const fn = jest.fn();
    t.addEventListener('e', fn);
    t.addEventListener('e', fn);
    t.dispatchEvent(new Event('e'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('once: removes the listener after the first dispatch', () => {
    const t = new EventTarget();
    const fn = jest.fn();
    t.addEventListener('e', fn, {once: true});
    t.dispatchEvent(new Event('e'));
    t.dispatchEvent(new Event('e'));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('removeEventListener removes it; unknown type is a no-op', () => {
    const t = new EventTarget();
    const fn = jest.fn();
    const other = jest.fn();
    t.addEventListener('e', fn);
    t.addEventListener('e', other);
    t.removeEventListener('e', other);
    t.removeEventListener('e', fn);
    t.removeEventListener('does-not-exist', fn);
    t.dispatchEvent(new Event('e'));
    expect(fn).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('supports object (handleEvent) listeners', () => {
    const t = new EventTarget();
    const obj = {handleEvent: jest.fn()};
    t.addEventListener('e', obj);
    t.dispatchEvent(new Event('e'));
    expect(obj.handleEvent).toHaveBeenCalledTimes(1);
  });

  it('bubbles to the event parent, keeping target = the child', () => {
    const child = new EventTarget();
    const parent = new EventTarget();
    setEventParent(child, parent);

    let seen: EventTarget | null = null;
    parent.addEventListener('e', ev => {
      seen = ev.target;
    });
    child.dispatchEvent(new Event('e'));
    expect(seen).toBe(child);
  });

  it('stopPropagation halts bubbling to the parent', () => {
    const child = new EventTarget();
    const parent = new EventTarget();
    setEventParent(child, parent);

    const parentFn = jest.fn();
    parent.addEventListener('e', parentFn);
    child.addEventListener('e', ev => ev.stopPropagation());
    child.dispatchEvent(new Event('e'));
    expect(parentFn).not.toHaveBeenCalled();
  });
});
