import {LineDevice} from 'react-native-web-serial-api/testing';

/**
 * A simulated CP210x temperature sensor — a worked example of authoring a whole
 * peripheral by extending SerialDevice (via LineDevice).
 *
 * On open it greets and then streams a reading every second; it also answers
 * line commands ("ID?" → model name, anything else → a fresh reading).
 */
export class SensorDevice extends LineDevice {
  readonly usbVendorId = 0x10c4;
  readonly usbProductId = 0xea60;
  readonly serialNumber = 'VIRT-CP210x-SENSOR';

  #timer?: ReturnType<typeof setInterval>;

  onOpen(): void {
    this.send('SENSOR READY\r\n');
    this.#timer = setInterval(() => this.send(this.#reading()), 1000);
  }

  onLine(line: string): void {
    this.send(line.trim() === 'ID?' ? 'ACME-TEMP-100\r\n' : this.#reading());
  }

  onClose(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #reading(): string {
    return `temp=${(20 + Math.random() * 5).toFixed(1)}C\r\n`;
  }
}
