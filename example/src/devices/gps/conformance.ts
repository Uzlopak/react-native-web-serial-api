/**
 * NMEA 0183 GPS conformance suite.
 *
 * A runtime-agnostic set of checks over the sentence stream from any GNSS
 * receiver reached through a {@link SerialPort}. The *same* cases run against:
 *   - the built-in {@link NmeaGpsDevice} emulator (the reference), and
 *   - a real connected receiver (e.g. a u-blox 8),
 * so you can confirm real hardware conforms to NMEA 0183 the same way the
 * emulator does. The checks are behavioural and **talker-agnostic** (they match
 * `$GP…`, `$GN…`, `$GL…`, … alike) and **fix-tolerant** (a populated field must
 * be well-formed, but a receiver with no fix indoors still passes the framing
 * checks). They are read-only: nothing is written to the port.
 */

import type {SerialPort} from 'react-native-web-serial-api';
import {Serial} from 'react-native-web-serial-api';
import {
  assert,
  compareResults,
  errorMessage,
  SerialClient,
  type SerialTestProgress,
  type SerialTestResult,
  VirtualSerialTransport,
} from 'react-native-web-serial-api/testing';
import {NmeaGpsDevice} from './NmeaGpsDevice';
import {checksum} from './nmea';

export type GpsTestResult = SerialTestResult;

/** Progress hooks so a UI can render results live as each test completes. */
export type GpsConformanceProgress = SerialTestProgress;

// ── sentence parsing ─────────────────────────────────────────────────────────

/** A parsed NMEA sentence: `$<talker><type>,<fields…>*<checksum>`. */
export type NmeaSentence = {
  raw: string;
  talker: string;
  type: string;
  fields: string[];
  checksumValid: boolean;
};

const SENTENCE_RE = /^\$([A-Z]{2})([A-Z]{3}),(.*)\*([0-9A-Fa-f]{2})$/;

/** Talker ids a GNSS receiver may use (GP/GL/GA/GB/GN/GQ/GI…). */
const GNSS_TALKERS = new Set(['GP', 'GL', 'GA', 'GB', 'GN', 'GQ', 'GI', 'BD']);

export function parseSentence(line: string): NmeaSentence | null {
  const match = line.trim().match(SENTENCE_RE);
  if (!match) {
    return null;
  }
  const [, talker, type, body, cs] = match;
  const checksumBody = `${talker}${type},${body}`;
  return {
    raw: line,
    talker,
    type,
    fields: body.split(','),
    checksumValid: checksum(checksumBody) === cs.toUpperCase(),
  };
}

const isBlank = (field: string | undefined): boolean =>
  field === undefined || field === '';

const isNumeric = (field: string): boolean =>
  field !== '' && !Number.isNaN(Number(field));

/** Validate a numeric field that may be left blank (no-fix tolerance). */
function numericOrBlank(field: string | undefined, label: string): void {
  if (!isBlank(field)) {
    assert(
      isNumeric(field as string),
      `${label} should be numeric (got "${field}")`,
    );
  }
}

/** Decode an `(d)dmm.mmmm` magnitude into decimal degrees. */
function decodeDegrees(value: string, degDigits: number): number {
  const degrees = Number(value.slice(0, degDigits));
  const minutes = Number(value.slice(degDigits));
  return degrees + minutes / 60;
}

type Position = {lat: number; lon: number};

/** Decode lat/ns/lon/ew at the given field offsets, or null when blank. */
function decodePosition(s: NmeaSentence, latIndex: number): Position | null {
  const lat = s.fields[latIndex];
  const ns = s.fields[latIndex + 1];
  const lon = s.fields[latIndex + 2];
  const ew = s.fields[latIndex + 3];
  if (isBlank(lat) || isBlank(lon)) {
    return null;
  }
  assert(/^\d{4}\.\d+$/.test(lat), `latitude must be ddmm.mmmm (got "${lat}")`);
  assert(
    ns === 'N' || ns === 'S',
    `latitude hemisphere must be N/S (got "${ns}")`,
  );
  assert(
    /^\d{5}\.\d+$/.test(lon),
    `longitude must be dddmm.mmmm (got "${lon}")`,
  );
  assert(
    ew === 'E' || ew === 'W',
    `longitude hemisphere must be E/W (got "${ew}")`,
  );
  return {
    lat: decodeDegrees(lat, 2) * (ns === 'S' ? -1 : 1),
    lon: decodeDegrees(lon, 3) * (ew === 'W' ? -1 : 1),
  };
}

const TIME_RE = /^\d{6}(\.\d+)?$/;

function assertTime(field: string | undefined, label: string): void {
  if (!isBlank(field)) {
    assert(
      TIME_RE.test(field as string),
      `${label} must be hhmmss[.sss] (got "${field}")`,
    );
  }
}

const byType = (batch: NmeaSentence[], type: string): NmeaSentence[] =>
  batch.filter(s => s.type === type);

// ── the suite ────────────────────────────────────────────────────────────────

export type GpsConformanceTest = {
  name: string;
  run(batch: NmeaSentence[]): void;
};

export const gpsConformanceTests: GpsConformanceTest[] = [
  {
    name: 'Streams NMEA sentences',
    run(batch) {
      assert(batch.length > 0, 'no NMEA sentences were received');
    },
  },
  {
    name: 'Every sentence carries a valid checksum',
    run(batch) {
      const bad = batch.filter(s => !s.checksumValid);
      assert(
        bad.length === 0,
        `${bad.length} sentence(s) failed checksum, e.g. ${bad[0]?.raw}`,
      );
    },
  },
  {
    name: 'Uses a recognised GNSS talker id',
    run(batch) {
      const unknown = batch.find(s => !GNSS_TALKERS.has(s.talker));
      assert(
        !unknown,
        `unexpected talker id "${unknown?.talker}" in ${unknown?.raw}`,
      );
    },
  },
  {
    name: 'Streams a position-fix sentence (GGA)',
    run(batch) {
      const ggas = byType(batch, 'GGA');
      assert(ggas.length > 0, 'no GGA sentence was received');
      for (const gga of ggas) {
        assertTime(gga.fields[0], 'GGA time');
        const quality = gga.fields[5];
        assert(
          !isBlank(quality) && /^[0-8]$/.test(quality),
          `GGA fix quality must be 0–8 (got "${quality}")`,
        );
        numericOrBlank(gga.fields[6], 'GGA satellites-used');
        numericOrBlank(gga.fields[7], 'GGA HDOP');
        decodePosition(gga, 1); // validates lat/lon shape when present
      }
    },
  },
  {
    name: 'Streams recommended-minimum data (RMC)',
    run(batch) {
      const rmcs = byType(batch, 'RMC');
      assert(rmcs.length > 0, 'no RMC sentence was received');
      for (const rmc of rmcs) {
        assertTime(rmc.fields[0], 'RMC time');
        const stat = rmc.fields[1];
        assert(
          stat === 'A' || stat === 'V',
          `RMC status must be A/V (got "${stat}")`,
        );
        const date = rmc.fields[8];
        if (!isBlank(date)) {
          assert(
            /^\d{6}$/.test(date),
            `RMC date must be ddmmyy (got "${date}")`,
          );
        }
        decodePosition(rmc, 2);
      }
    },
  },
  {
    name: 'Reports satellites in view with signal strength (GSV)',
    run(batch) {
      const gsvs = byType(batch, 'GSV');
      assert(gsvs.length > 0, 'no GSV sentence was received');
      let snrSeen = false;
      let inView = 0;
      for (const gsv of gsvs) {
        numericOrBlank(gsv.fields[0], 'GSV message count');
        numericOrBlank(gsv.fields[1], 'GSV message number');
        numericOrBlank(gsv.fields[2], 'GSV satellites-in-view');
        inView = Math.max(inView, Number(gsv.fields[2] ?? 0));
        // Satellite blocks: [id, elevation, azimuth, snr] × up to 4.
        for (let i = 3; i + 4 <= gsv.fields.length; i += 4) {
          numericOrBlank(gsv.fields[i], 'GSV satellite id');
          numericOrBlank(gsv.fields[i + 1], 'GSV elevation');
          numericOrBlank(gsv.fields[i + 2], 'GSV azimuth');
          numericOrBlank(gsv.fields[i + 3], 'GSV SNR');
          if (isNumeric(gsv.fields[i + 3] ?? '')) {
            snrSeen = true;
          }
        }
      }
      // With satellites in view, at least one must report an SNR (signal
      // strength). With none in view (no fix indoors) the framing is enough.
      assert(
        inView === 0 || snrSeen,
        'satellites are in view but none report a signal strength (SNR)',
      );
    },
  },
  {
    name: 'Reports active satellites and DOP (GSA)',
    run(batch) {
      const gsas = byType(batch, 'GSA');
      assert(gsas.length > 0, 'no GSA sentence was received');
      for (const gsa of gsas) {
        const select = gsa.fields[0];
        assert(
          select === 'A' || select === 'M',
          `GSA select mode must be A/M (got "${select}")`,
        );
        const mode = gsa.fields[1];
        assert(
          /^[123]$/.test(mode ?? ''),
          `GSA fix mode must be 1/2/3 (got "${mode}")`,
        );
        // The last three fields are PDOP, HDOP, VDOP.
        const dop = gsa.fields.slice(-3);
        for (const value of dop) {
          numericOrBlank(value, 'GSA DOP');
        }
      }
    },
  },
  {
    name: 'Latitude/longitude are within range',
    run(batch) {
      const positions = [
        ...byType(batch, 'GGA').map(s => decodePosition(s, 1)),
        ...byType(batch, 'RMC').map(s => decodePosition(s, 2)),
        ...byType(batch, 'GLL').map(s => decodePosition(s, 0)),
      ].filter((p): p is Position => p !== null);
      for (const p of positions) {
        assert(Math.abs(p.lat) <= 90, `latitude out of range (${p.lat})`);
        assert(Math.abs(p.lon) <= 180, `longitude out of range (${p.lon})`);
      }
    },
  },
  {
    name: 'GGA and RMC agree on position',
    run(batch) {
      const gga = byType(batch, 'GGA')
        .map(s => decodePosition(s, 1))
        .find((p): p is Position => p !== null);
      const rmc = byType(batch, 'RMC')
        .map(s => decodePosition(s, 2))
        .find((p): p is Position => p !== null);
      if (!gga || !rmc) {
        return; // no fix in this window — nothing to cross-check
      }
      assert(
        Math.abs(gga.lat - rmc.lat) < 0.01 &&
          Math.abs(gga.lon - rmc.lon) < 0.01,
        `GGA (${gga.lat}, ${gga.lon}) and RMC (${rmc.lat}, ${rmc.lon}) disagree`,
      );
    },
  },
];

// ── an NMEA line reader over a SerialPort ────────────────────────────────────

/**
 * Read sentences off a {@link SerialClient} until `wantTypes` have all been seen
 * (a full cycle) or `timeoutMs` elapses — fast for the emulator, ~1–2 s for real
 * hardware. `SerialClient.readLine` does the line framing the collector used to
 * hand-roll.
 */
async function collectSentences(
  client: SerialClient,
  options: {wantTypes: string[]; minSentences: number; timeoutMs: number},
): Promise<NmeaSentence[]> {
  const out: NmeaSentence[] = [];
  const seen = new Set<string>();
  const deadline = Date.now() + options.timeoutMs;

  while (Date.now() < deadline) {
    if (
      out.length >= options.minSentences &&
      options.wantTypes.every(t => seen.has(t))
    ) {
      break;
    }
    if (client.ended) break;
    let line: string;
    try {
      line = await client.readLine({timeout: deadline - Date.now()});
    } catch {
      break; // read timeout — return whatever was collected
    }
    const sentence = parseSentence(line);
    if (sentence) {
      out.push(sentence);
      seen.add(sentence.type);
    }
  }
  return out;
}

// ── runners ──────────────────────────────────────────────────────────────────

/** Run the full suite against an already-acquired port (opens & closes it). */
export async function runGpsConformance(
  port: SerialPort,
  progress?: GpsConformanceProgress,
): Promise<GpsTestResult[]> {
  const client = new SerialClient(port);
  try {
    await client.open({baudRate: 9600});
  } catch (e) {
    const result = {
      name: 'open serial port',
      passed: false,
      error: errorMessage(e),
      durationMs: 0,
    };
    progress?.onResult?.(result);
    return [result];
  }

  const batch = await collectSentences(client, {
    wantTypes: ['GGA', 'RMC', 'GSV', 'GSA'],
    minSentences: 4,
    timeoutMs: 5000,
  });

  const results: GpsTestResult[] = [];
  const total = gpsConformanceTests.length;
  for (let i = 0; i < total; i++) {
    const test = gpsConformanceTests[i];
    progress?.onStart?.(test.name, i, total);
    const start = Date.now();
    let result: GpsTestResult;
    try {
      test.run(batch);
      result = {name: test.name, passed: true, durationMs: Date.now() - start};
    } catch (e) {
      result = {
        name: test.name,
        passed: false,
        error: errorMessage(e),
        durationMs: Date.now() - start,
      };
    }
    results.push(result);
    progress?.onResult?.(result);
  }

  await client.close().catch(() => {});
  return results;
}

/** A fresh virtual GPS port — the reference a real receiver is compared to. */
export async function makeVirtualGpsPort(): Promise<SerialPort> {
  const transport = new VirtualSerialTransport();
  // A brisk cycle so the reference run completes quickly; real receivers
  // typically stream at 1 Hz, which the collector's timeout accommodates.
  transport.addDevice(new NmeaGpsDevice({intervalMs: 100}), {
    hasPermission: true,
  });
  const serial = new Serial(transport);
  const [port] = await serial.getPorts();
  if (!port) {
    throw new Error('failed to create a virtual GPS port');
  }
  return port;
}

/**
 * Run the suite against `realPort` and against the emulator, returning one
 * result per case: `passed` means the real receiver behaved identically to the
 * emulator (both pass / both fail the same case), via the shipped
 * {@link compareResults}.
 */
export async function compareGpsWithSimulator(
  realPort: SerialPort,
  progress?: GpsConformanceProgress,
): Promise<GpsTestResult[]> {
  progress?.onStart?.(
    'preparing emulator reference…',
    0,
    gpsConformanceTests.length,
  );
  const reference = await runGpsConformance(await makeVirtualGpsPort());
  const candidate = await runGpsConformance(realPort, {
    onStart: progress?.onStart,
  });
  const compared = compareResults(reference, candidate);
  for (const row of compared) progress?.onResult?.(row);
  return compared;
}
