/**
 * Pure NMEA 0183 sentence generation — no `react-native`, no `SimulatedDevice`,
 * no transport. Every sentence flows through the same primitives (one
 * checksum, one coordinate formatter, one `$..*HH\r\n` wrapper, one builder
 * table), so adding a sentence is a one-liner and nothing is repeated.
 *
 * Ported to TypeScript from the Python `nmea-gps-emulator`
 * (https://github.com/luk-kop/nmea-gps-emulator, MIT © 2021 luk-kop) and the
 * NMEA 0183 sentence specs.
 */

/** A single satellite as reported in GSV/GSA. */
export type Satellite = {
  /** PRN / satellite id (1–32 for GPS). */
  id: number;
  /** Elevation above the horizon, degrees (0–90). */
  elevationDeg: number;
  /** Azimuth to true north, degrees (0–359). */
  azimuthDeg: number;
  /** Signal-to-noise ratio / signal strength, dB-Hz (0–99). */
  snrDb: number;
};

/** The complete state a receiver encodes into its sentences. */
export type GpsFix = {
  /** Latitude in decimal degrees (negative = south). */
  latitude: number;
  /** Longitude in decimal degrees (negative = west). */
  longitude: number;
  /** Antenna altitude above mean sea level, metres. */
  altitudeMeters: number;
  /** Geoidal separation (WGS-84 ellipsoid vs. mean sea level), metres. */
  geoidSeparationMeters: number;
  /** Speed over ground, knots. */
  speedKnots: number;
  /** Course over ground / heading, degrees true. */
  courseDegrees: number;
  /** GGA fix quality: 0 = no fix, 1 = GPS, 2 = DGPS. */
  fixQuality: 0 | 1 | 2;
  /** GSA fix mode: 1 = no fix, 2 = 2D, 3 = 3D. */
  fixMode: 1 | 2 | 3;
  /** Horizontal dilution of precision. */
  hdop: number;
  /** Position dilution of precision. */
  pdop: number;
  /** Vertical dilution of precision. */
  vdop: number;
  /** Satellites currently in view (reported by GSV). */
  satellites: Satellite[];
  /** How many satellites are used for the fix (GGA count / GSA ids). */
  satellitesUsed: number;
};

/** Sentence types this emulator can produce (all with the `GP` talker id). */
export type SentenceType = 'GGA' | 'GLL' | 'GSA' | 'GSV' | 'RMC' | 'VTG';

type Field = string | number;
type SentenceBuilder = (fix: GpsFix, date: Date) => Field[][];

const pad2 = (n: number): string => String(n).padStart(2, '0');
const pad3 = (n: number): string => String(n).padStart(3, '0');

/**
 * NMEA checksum: XOR of every character between `$` and `*`, as two uppercase
 * hex digits. `body` is the payload without the `$` prefix or `*` suffix.
 */
export function checksum(body: string): string {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    sum ^= body.charCodeAt(i);
  }
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/** Format decimal degrees as `(d)dmm.mmmm`, zero-padded to `degWidth` degrees. */
function formatCoordinate(deg: number, degWidth: number): string {
  const abs = Math.abs(deg);
  let degrees = Math.floor(abs);
  let minutes = (abs - degrees) * 60;
  // Guard the rare rounding case where minutes round up to a full degree.
  if (Number(minutes.toFixed(4)) >= 60) {
    degrees += 1;
    minutes = 0;
  }
  return (
    String(degrees).padStart(degWidth, '0') +
    minutes.toFixed(4).padStart(7, '0')
  );
}

export function formatLatitude(deg: number): {
  value: string;
  hemisphere: 'N' | 'S';
} {
  return {value: formatCoordinate(deg, 2), hemisphere: deg >= 0 ? 'N' : 'S'};
}

export function formatLongitude(deg: number): {
  value: string;
  hemisphere: 'E' | 'W';
} {
  return {value: formatCoordinate(deg, 3), hemisphere: deg >= 0 ? 'E' : 'W'};
}

/** UTC time as `hhmmss.ss`. */
export function utcTime(date: Date): string {
  const centis = Math.floor(date.getUTCMilliseconds() / 10);
  return `${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(
    date.getUTCSeconds(),
  )}.${pad2(centis)}`;
}

/** UTC date as `ddmmyy`. */
export function utcDate(date: Date): string {
  return `${pad2(date.getUTCDate())}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCFullYear() % 100,
  )}`;
}

/** Wrap fields into a full sentence: `$GP<type>,<fields>*HH\r\n`. */
export function assemble(type: SentenceType, fields: Field[]): string {
  const body = `GP${type},${fields.map(String).join(',')}`;
  return `$${body}*${checksum(body)}\r\n`;
}

const fixStatus = (fix: GpsFix): string => (fix.fixQuality > 0 ? 'A' : 'V');

/** One tiny builder per sentence; each returns one-or-more rows of fields. */
const SENTENCE_BUILDERS: Record<SentenceType, SentenceBuilder> = {
  GGA: (fix, date) => {
    const lat = formatLatitude(fix.latitude);
    const lon = formatLongitude(fix.longitude);
    return [
      [
        utcTime(date),
        lat.value,
        lat.hemisphere,
        lon.value,
        lon.hemisphere,
        fix.fixQuality,
        pad2(fix.satellitesUsed),
        fix.hdop.toFixed(2),
        fix.altitudeMeters.toFixed(1),
        'M',
        fix.geoidSeparationMeters.toFixed(1),
        'M',
        '',
        '',
      ],
    ];
  },
  GLL: (fix, date) => {
    const lat = formatLatitude(fix.latitude);
    const lon = formatLongitude(fix.longitude);
    return [
      [
        lat.value,
        lat.hemisphere,
        lon.value,
        lon.hemisphere,
        utcTime(date),
        fixStatus(fix),
      ],
    ];
  },
  GSA: fix => {
    const ids = fix.satellites
      .slice(0, fix.satellitesUsed)
      .map(s => pad2(s.id));
    while (ids.length < 12) {
      ids.push('');
    }
    return [
      [
        'A',
        fix.fixMode,
        ...ids,
        fix.pdop.toFixed(2),
        fix.hdop.toFixed(2),
        fix.vdop.toFixed(2),
      ],
    ];
  },
  GSV: fix => {
    const sats = fix.satellites;
    const messages = Math.max(1, Math.ceil(sats.length / 4));
    const rows: Field[][] = [];
    for (let msg = 0; msg < messages; msg++) {
      const fields: Field[] = [messages, msg + 1, pad2(sats.length)];
      for (const sat of sats.slice(msg * 4, msg * 4 + 4)) {
        fields.push(
          pad2(sat.id),
          pad2(sat.elevationDeg),
          pad3(sat.azimuthDeg),
          pad2(sat.snrDb),
        );
      }
      rows.push(fields);
    }
    return rows;
  },
  RMC: (fix, date) => {
    const lat = formatLatitude(fix.latitude);
    const lon = formatLongitude(fix.longitude);
    return [
      [
        utcTime(date),
        fixStatus(fix),
        lat.value,
        lat.hemisphere,
        lon.value,
        lon.hemisphere,
        fix.speedKnots.toFixed(1),
        fix.courseDegrees.toFixed(1),
        utcDate(date),
        '',
        '',
      ],
    ];
  },
  VTG: fix => [
    [
      fix.courseDegrees.toFixed(1),
      'T',
      '',
      'M',
      fix.speedKnots.toFixed(1),
      'N',
      (fix.speedKnots * 1.852).toFixed(1),
      'K',
    ],
  ],
};

/** The sentence set a typical consumer GNSS receiver streams. */
export const DEFAULT_SENTENCES: SentenceType[] = [
  'GGA',
  'GLL',
  'GSA',
  'GSV',
  'RMC',
  'VTG',
];

/** Build one full cycle of sentences for the given fix/time. */
export function buildCycle(
  fix: GpsFix,
  date: Date,
  types: SentenceType[] = DEFAULT_SENTENCES,
): string[] {
  return types.flatMap(type =>
    SENTENCE_BUILDERS[type](fix, date).map(fields => assemble(type, fields)),
  );
}

/**
 * Build `count` plausible satellites (deterministic, so tests are stable).
 * Pass `snrDb` to force a uniform signal strength.
 */
export function makeSatellites(
  count: number,
  opts: {snrDb?: number} = {},
): Satellite[] {
  const sats: Satellite[] = [];
  for (let i = 0; i < count; i++) {
    sats.push({
      id: i + 1,
      elevationDeg: 10 + ((i * 7) % 80),
      azimuthDeg: (i * 47) % 360,
      snrDb: opts.snrDb ?? 30 + ((i * 5) % 20),
    });
  }
  return sats;
}

/** Greenwich Royal Observatory, a strong 3D fix — the emulator's default. */
export const DEFAULT_FIX: GpsFix = {
  latitude: 51.476852,
  longitude: -0.0005,
  altitudeMeters: 15.2,
  geoidSeparationMeters: 32.5,
  speedKnots: 0,
  courseDegrees: 0,
  fixQuality: 1,
  fixMode: 3,
  hdop: 0.92,
  pdop: 1.56,
  vdop: 1.25,
  satellites: makeSatellites(12),
  satellitesUsed: 12,
};
