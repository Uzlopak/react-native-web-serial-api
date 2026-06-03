/**
 * Runs the shared Web Serial conformance suite under Jest.
 *
 * The exact same `serialConformanceTests` array is executed on-device by the
 * example app's Self-Test screen — one suite, two runtimes.
 */
import {describe, it} from '@jest/globals';
import {serialConformanceTests} from './conformance-suite';

describe('Web Serial conformance (virtual transport)', () => {
  for (const test of serialConformanceTests) {
    it(test.name, async () => {
      await test.run();
    });
  }
});
