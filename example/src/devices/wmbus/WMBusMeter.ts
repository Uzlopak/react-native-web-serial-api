/**
 * A simulated Wireless M-Bus meter (water/gas/electricity …). It has a WM-Bus
 * address, an optional 128-bit key, and a payload it periodically transmits.
 * Telegrams are injected into a hosting {@link WMBusGateway} which forwards them
 * to the serial host as WM-Bus Packet Received (0x20) events.
 */
import {buildWMBusPacket, type WMBusAddress} from './frame';

/** Encryption modes a meter can claim for its telegrams (spec p34). */
export const ENCRYPTION_NONE = 0;
export const ENCRYPTION_MODE_5 = 5;

export type InjectOptions = {
  rssi?: number;
  linkMode?: number;
  encryptionMode?: number;
  timestamp?: number;
};

/** The slice of the gateway a meter needs — lets the meter avoid importing it. */
export interface MeterGateway {
  injectRxPacket(packet: number[], options?: InjectOptions): void;
}

export type WMBusMeterOptions = {
  address: WMBusAddress;
  /** 16-byte key. When present, telegrams claim Mode 5 encryption. */
  encryptionKey?: number[];
  /** Link mode reported with each telegram (1=S, 2=T, 4/5=C, …). Default 2 (T). */
  linkMode?: number;
  /** Reported RSSI in dBm. Default -50. */
  rssi?: number;
  /** Application data after the address (CI + transport + data). */
  payloadTemplate?: number[];
  /** When set, the meter streams a telegram every `intervalMs` while the port is open. */
  intervalMs?: number;
  /** Whether to auto-stream once hosted + open. Default true. */
  startImmediately?: boolean;
};

export class WMBusMeter {
  readonly address: WMBusAddress;
  readonly encryptionKey?: number[];
  readonly linkMode: number;
  readonly rssi: number;
  readonly intervalMs: number;
  readonly autoStream: boolean;

  #payload: number[];
  #timer?: ReturnType<typeof setInterval>;
  #gateway?: MeterGateway;

  constructor(options: WMBusMeterOptions) {
    this.address = options.address;
    this.encryptionKey = options.encryptionKey;
    this.linkMode = options.linkMode ?? 2;
    this.rssi = options.rssi ?? -50;
    this.intervalMs = options.intervalMs ?? 0;
    this.autoStream = options.startImmediately ?? true;
    this.#payload = options.payloadTemplate ? [...options.payloadTemplate] : [];
  }

  /** @internal Bind/unbind the hosting gateway (called by WMBusGateway). */
  _attach(gateway: MeterGateway): void {
    this.#gateway = gateway;
  }

  _detach(): void {
    this.stopPeriodic();
    this.#gateway = undefined;
  }

  /** Transmit a single telegram now (using the current or a custom payload). */
  sendTelegram(customPayload?: number[]): void {
    if (!this.#gateway) return;
    const packet = buildWMBusPacket(
      this.address,
      customPayload ?? this.#payload,
    );
    this.#gateway.injectRxPacket(packet, {
      rssi: this.rssi,
      linkMode: this.linkMode,
      encryptionMode: this.encryptionKey ? ENCRYPTION_MODE_5 : ENCRYPTION_NONE,
    });
  }

  /** Start (or restart) periodic transmission. */
  startPeriodic(intervalMs: number = this.intervalMs): void {
    this.stopPeriodic();
    if (intervalMs <= 0) return;
    this.#timer = setInterval(() => this.sendTelegram(), intervalMs);
  }

  stopPeriodic(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  updatePayloadTemplate(payload: number[]): void {
    this.#payload = [...payload];
  }
}
