export interface EventInit {
  bubbles?: boolean;
  cancelable?: boolean;
  composed?: boolean;
}

export class Event {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  readonly composed: boolean;

  target: EventTarget | null = null;
  currentTarget: EventTarget | null = null;

  defaultPrevented: boolean = false;
  cancelBubble: boolean = false;
  _stopImmediatePropagationFlag: boolean = false;

  readonly timeStamp: number = Date.now();
  readonly isTrusted: boolean = false;

  static readonly NONE = 0;
  static readonly CAPTURING_PHASE = 1;
  static readonly AT_TARGET = 2;
  static readonly BUBBLING_PHASE = 3;

  readonly NONE = 0;
  readonly CAPTURING_PHASE = 1;
  readonly AT_TARGET = 2;
  readonly BUBBLING_PHASE = 3;

  eventPhase: number = Event.NONE;

  constructor(type: string, options?: EventInit) {
    this.type = type;
    this.bubbles = options?.bubbles ?? false;
    this.cancelable = options?.cancelable ?? false;
    this.composed = options?.composed ?? false;
  }

  preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  stopPropagation(): void {
    this.cancelBubble = true;
  }

  stopImmediatePropagation(): void {
    this.cancelBubble = true;
    this._stopImmediatePropagationFlag = true;
  }

  composedPath(): EventTarget[] {
    return this.currentTarget ? [this.currentTarget] : [];
  }

  initEvent(type: string, bubbles?: boolean, cancelable?: boolean): void {
    (this as Mutable<Event>).type = type;
    (this as Mutable<Event>).bubbles = bubbles ?? false;
    (this as Mutable<Event>).cancelable = cancelable ?? false;
  }
}

type Mutable<T> = {-readonly [P in keyof T]: T[P]};

type EventListener = (event: Event) => void;

interface EventListenerObject {
  handleEvent(event: Event): void;
}

type EventListenerOrEventListenerObject = EventListener | EventListenerObject;

type ListenerOptions =
  | {once?: boolean; capture?: boolean; passive?: boolean}
  | boolean
  | undefined;

interface ListenerInfo {
  target: EventTarget;
  listener: EventListenerOrEventListenerObject;
  options: ListenerOptions;
}

type SecretMap = Record<string, ListenerInfo[]>;

const wm = new WeakMap<object, SecretMap>();

function define<T extends object>(
  target: T,
  name: string,
  value: unknown,
): void {
  Object.defineProperty(target, name, {
    configurable: true,
    writable: true,
    value,
  });
}

function dispatch(this: Event, info: ListenerInfo): boolean {
  const options = info.options;
  const once =
    typeof options === 'object' && options !== null ? options.once : false;

  if (once) {
    info.target.removeEventListener(this.type, info.listener);
  }

  if (typeof info.listener === 'function') {
    info.listener.call(info.target, this);
  } else {
    info.listener.handleEvent(this);
  }

  return this._stopImmediatePropagationFlag;
}

export class EventTarget {
  constructor() {
    wm.set(this, Object.create(null) as SecretMap);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: ListenerOptions,
  ): void {
    const secret = wm.get(this)!;
    let listeners = secret[type];
    if (!listeners) {
      listeners = [];
      secret[type] = listeners;
    }

    for (let i = 0; i < listeners.length; i++) {
      if (listeners[i].listener === listener) return;
    }

    listeners.push({target: this, listener, options});
  }

  dispatchEvent(event: Event): boolean {
    const secret = wm.get(this)!;
    const listeners = secret[event.type];

    if (listeners) {
      define(event, 'target', this);
      define(event, 'currentTarget', this);
      listeners.slice(0).some(dispatch, event);
      define(event, 'target', null);
      define(event, 'currentTarget', null);
    }

    return true;
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    _options?: ListenerOptions,
  ): void {
    const secret = wm.get(this)!;
    const listeners = secret[type];
    if (!listeners) return;

    for (let i = 0; i < listeners.length; i++) {
      if (listeners[i].listener === listener) {
        listeners.splice(i, 1);
        return;
      }
    }
  }
}
