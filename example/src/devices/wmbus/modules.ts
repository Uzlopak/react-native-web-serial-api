/**
 * Per-variant facts for the WM-Bus gateway modules (spec p21).
 *
 * `moduleType`/`moduleId`/`productType`/`productId` are reported by Get Device
 * Information & the Startup Indication. For the iU sticks these are the real
 * values read off the hardware (USB VID/PID 04b4:0003, Cypress). The iM881A-XL /
 * iM891A-XL are *integrated radio modules* with no canonical USB identity, and
 * we have no real moduleId/productType/productId for them — only the spec-defined
 * `moduleType` is known, so the rest are explicit `0` placeholders (NOT invented
 * values). All multi-byte fields are LSB-first on the wire.
 */
export type ModuleVariant =
  | 'iM881A-XL'
  | 'iM891A-XL'
  | 'iU891A-XL'
  | 'iU893A-XL';

export type ModuleInfo = {
  moduleType: number;
  usbVendorId: number;
  usbProductId: number;
  /** Get/Set Radio Control Config available (iM881A-XL / iM891A-XL only). */
  hasRadioControl: boolean;
  /** Stored WM-Bus address + Send/Encrypt-II + Get WM-Bus Address (iU sticks only). */
  hasStoredAddress: boolean;
  /** Approval Test SAP (Reset Test / CW / PN9) available (iM881A-XL / iM891A-XL only). */
  hasApprovalTest: boolean;
  /** Reported by Get Device Information / Startup Indication. */
  moduleId: number;
  productType: number;
  productId: number;
};

export const MODULES: Record<ModuleVariant, ModuleInfo> = {
  // Integrated radio modules. Only `moduleType` is spec-known; USB IDs and the
  // unique IDs are unknown placeholders (these variants are used only in tests).
  'iM881A-XL': {
    moduleType: 0xa3,
    usbVendorId: 0x0000,
    usbProductId: 0x0000,
    hasRadioControl: true,
    hasStoredAddress: false,
    hasApprovalTest: true,
    moduleId: 0x00000000,
    productType: 0x00000000,
    productId: 0x00000000,
  },
  'iM891A-XL': {
    moduleType: 0x6d,
    usbVendorId: 0x0000,
    usbProductId: 0x0000,
    hasRadioControl: true,
    hasStoredAddress: false,
    hasApprovalTest: true,
    moduleId: 0x00000000,
    productType: 0x00000000,
    productId: 0x00000000,
  },
  // iU USB sticks — real values read off the hardware (Cypress 04b4:0003).
  'iU891A-XL': {
    moduleType: 0x6e,
    usbVendorId: 0x04b4,
    usbProductId: 0x0003,
    hasRadioControl: false,
    hasStoredAddress: true,
    hasApprovalTest: false,
    moduleId: 0x00001b0d,
    productType: 0x00062dbe,
    productId: 0x00000ba5,
  },
  'iU893A-XL': {
    moduleType: 0x71,
    usbVendorId: 0x04b4,
    usbProductId: 0x0003,
    hasRadioControl: false,
    hasStoredAddress: true,
    hasApprovalTest: false,
    moduleId: 0x00001164,
    productType: 0x00062dc8,
    productId: 0x000004a2,
  },
};

export const FIRMWARE = {
  /** Minor version first on the wire: [minor, major] => "major.minor". */
  versionMinor: 9,
  versionMajor: 0,
  buildCount: 55,
  buildDate: '09.04.2020',
  name: 'VIRT_WMBus_Gateway',
} as const;
