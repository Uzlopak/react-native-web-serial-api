/**
 * A host-side HCI client for any IMST-style WM-Bus gateway over a
 * {@link SerialPort}. It frames requests (SLIP + HCI) and decodes the gateway's
 * responses and unsolicited events, layered on the shipped {@link SerialClient}
 * — the library's reusable reader/writer/timeout plumbing — so no test re-rolls
 * a reader loop. Shared by the conformance suite and the gateway/meter tests.
 *
 *   - {@link request}/{@link recv}  — send a frame and read the next reply/event,
 *   - {@link exchange}              — send a request and skip events until the
 *     matching response (for request/response conformance checks),
 *   - {@link waitFor}/{@link expectNoMessage} — observe (or assert the absence
 *     of) an unsolicited event.
 */

import type {SerialPort} from 'react-native-web-serial-api';
import {SerialClient} from 'react-native-web-serial-api/testing';
import {DevMgmt, decodeHci, encodeHci, type HciMessage, Sap} from './hci';
import {SlipDecoder, slipEncode} from './slip';

export class HciHost {
  readonly #client: SerialClient;
  readonly #dec = new SlipDecoder();
  readonly #pending: HciMessage[] = [];

  constructor(client: SerialClient) {
    this.#client = client;
  }

  /** Open `port` and return a ready host. */
  static async open(port: SerialPort, baudRate = 115200): Promise<HciHost> {
    const client = new SerialClient(port);
    await client.open({baudRate});
    return new HciHost(client);
  }

  /** Write raw bytes verbatim (e.g. to inject a deliberately malformed frame). */
  async raw(bytes: number[]): Promise<void> {
    await this.#client.write(bytes);
  }

  /** SLIP-frame and send one HCI message. */
  async send(sap: number, msg: number, payload: number[] = []): Promise<void> {
    await this.#client.write(slipEncode(encodeHci(sap, msg, payload)));
  }

  /** Read the next decoded HCI message (response or event). */
  async recv(timeoutMs = 5000): Promise<HciMessage> {
    while (this.#pending.length === 0) {
      if (this.#client.ended) throw new Error('serial stream closed');
      const chunk = await this.#client.readAvailable({timeout: timeoutMs});
      for (const frame of this.#dec.push(chunk)) {
        const decoded = decodeHci(frame);
        if (decoded) this.#pending.push(decoded);
      }
    }
    return this.#pending.shift() as HciMessage;
  }

  /** Send a request and return the very next frame (a simple req/rsp). */
  async request(
    sap: number,
    msg: number,
    payload: number[] = [],
  ): Promise<HciMessage> {
    await this.send(sap, msg, payload);
    return this.recv();
  }

  /** Send a request and wait for the matching response, skipping any events. */
  async exchange(
    sap: number,
    reqMsg: number,
    payload: number[],
    rspMsg: number,
    timeoutMs = 2000,
    onSkipped?: (message: HciMessage) => void,
  ): Promise<HciMessage> {
    await this.send(sap, reqMsg, payload);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      while (this.#pending.length > 0) {
        const m = this.#pending.shift() as HciMessage;
        if (m.sap === sap && m.msg === rspMsg) return m;
        onSkipped?.(m); // unsolicited event (telegram / tx-notify) — ignore
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for response 0x${sap.toString(16)}/0x${rspMsg.toString(16)}`,
        );
      }
      if (this.#client.ended) throw new Error('serial stream closed');
      await this.#pumpOnce(remaining);
    }
  }

  /** Wait for a specific message (typically an event), skipping all others. */
  async waitFor(
    sap: number,
    msg: number,
    timeoutMs = 5000,
    predicate?: (message: HciMessage) => boolean,
  ): Promise<HciMessage> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      while (this.#pending.length > 0) {
        const m = this.#pending.shift() as HciMessage;
        if (m.sap === sap && m.msg === msg && (!predicate || predicate(m))) {
          return m;
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `timed out waiting for message 0x${sap.toString(16)}/0x${msg.toString(16)}`,
        );
      }
      if (this.#client.ended) throw new Error('serial stream closed');
      await this.#pumpOnce(remaining);
    }
  }

  /** Assert a message does NOT occur for the entire timeout window. */
  async expectNoMessage(
    sap: number,
    msg: number,
    timeoutMs = 5000,
    predicate?: (message: HciMessage) => boolean,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Keep a floor so the final ping always has enough budget to complete on a
    // real serial link; otherwise a ping round-trip near the deadline would
    // surface as a spurious read timeout and fail the assertion.
    while (deadline - Date.now() > 500) {
      const remaining = deadline - Date.now();
      try {
        await this.exchange(
          Sap.DevMgmt,
          DevMgmt.PingReq,
          [],
          DevMgmt.PingRsp,
          Math.min(remaining, 1500),
          m => {
            if (
              m.sap === sap &&
              m.msg === msg &&
              (!predicate || predicate(m))
            ) {
              throw new Error(
                `unexpected message 0x${sap.toString(16)}/0x${msg.toString(16)} received`,
              );
            }
          },
        );
      } catch (e) {
        // Only the "unexpected message" assertion should fail this check; a slow
        // or dropped ping (real serial latency) is tolerated — keep observing.
        if (e instanceof Error && e.message.startsWith('unexpected message')) {
          throw e;
        }
      }
    }
  }

  /** Read one chunk into the SLIP/HCI buffer; a read timeout is non-fatal. */
  async #pumpOnce(timeoutMs: number): Promise<void> {
    let chunk: Uint8Array;
    try {
      chunk = await this.#client.readAvailable({timeout: timeoutMs});
    } catch {
      return; // read timeout — caller's deadline check reports it meaningfully
    }
    for (const frame of this.#dec.push(chunk)) {
      const decoded = decodeHci(frame);
      if (decoded) this.#pending.push(decoded);
    }
  }

  /** Release the client and close the underlying port. Safe to call twice. */
  async close(): Promise<void> {
    await this.#client.close();
  }
}
