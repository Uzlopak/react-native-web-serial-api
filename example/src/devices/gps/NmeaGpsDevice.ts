import {SerialDevice} from 'react-native-web-serial-api/testing';
import {
  buildCycle,
  DEFAULT_FIX,
  DEFAULT_SENTENCES,
  type GpsFix,
  type SentenceType,
} from './nmea';

/**
 * Construction options: any subset of the {@link GpsFix} plus emulator knobs.
 */
export type NmeaGpsOptions = Partial<GpsFix> & {
  /** Override the advertised USB identity. */
  identity?: {
    usbVendorId?: number;
    usbProductId?: number;
    serialNumber?: string;
  };
  /** Which sentences to stream each cycle (defaults to a typical receiver set). */
  sentences?: SentenceType[];
  /** Interval between sentence cycles, ms (default 1000). */
  intervalMs?: number;
  /** Clock used for the time/date fields (default `() => new Date()`). */
  clock?: () => Date;
};

/**
 * A simulated NMEA 0183 GPS receiver — a worked example of authoring a whole
 * peripheral by extending `SerialDevice`. It is transmit-only (like a GPS
 * puck): on open it streams a full sentence cycle immediately and then once per
 * `intervalMs`. It defaults to the Greenwich Royal Observatory position.
 *
 * The fix can be configured at construction and changed at runtime with
 * {@link update} — entirely in-process, no bytes are written to the port.
 *
 * @example
 * const gps = new NmeaGpsDevice({latitude: 48.8584, longitude: 2.2945});
 * transport.addDevice(gps, {hasPermission: true});
 * // later, move it / change signal strength without touching the serial line:
 * gps.update({satellites: makeSatellites(12, {snrDb: 48})});
 */
export class NmeaGpsDevice extends SerialDevice {
  readonly usbVendorId: number;
  readonly usbProductId: number;
  readonly serialNumber: string;

  #fix: GpsFix;
  readonly #sentences: SentenceType[];
  readonly #intervalMs: number;
  readonly #clock: () => Date;
  #timer?: ReturnType<typeof setInterval>;

  constructor(options: NmeaGpsOptions = {}) {
    super();
    const {identity, sentences, intervalMs, clock, ...fix} = options;
    this.usbVendorId = identity?.usbVendorId ?? 0x1546; // u-blox
    this.usbProductId = identity?.usbProductId ?? 0x01a7; // u-blox 7 GNSS
    this.serialNumber = identity?.serialNumber ?? 'VIRT-GPS-NMEA';
    this.#fix = {...DEFAULT_FIX, ...fix};
    this.#sentences = sentences ?? DEFAULT_SENTENCES;
    this.#intervalMs = intervalMs ?? 1000;
    this.#clock = clock ?? (() => new Date());
  }

  /** A read-only snapshot of the current fix. */
  get fix(): Readonly<GpsFix> {
    return this.#fix;
  }

  /** Change any aspect of the fix at runtime — no serial round-trip. */
  update(patch: Partial<GpsFix>): void {
    this.#fix = {...this.#fix, ...patch};
  }

  /** The sentences the next cycle will transmit for the current fix/clock. */
  sentences(): string[] {
    return buildCycle(this.#fix, this.#clock(), this.#sentences);
  }

  onOpen(): void {
    this.#emit();
    this.#timer = setInterval(() => this.#emit(), this.#intervalMs);
  }

  onClose(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
    }
    this.#timer = undefined;
  }

  #emit(): void {
    for (const sentence of this.sentences()) {
      this.send(sentence);
    }
  }
}
