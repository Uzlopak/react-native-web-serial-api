/**
 * IMST HCI message constants and (de)serialisation.
 *
 * Message on the wire (before SLIP framing): `SAP(1) | MsgID(1) | payload | CRC16(2, LSB-first)`.
 * The CRC (CRC-16/IBM-SDLC) covers SAP+MsgID+payload. See the protocol spec p5-7.
 */
import {crc16Bytes} from './crc16';

/** Service Access Point identifiers (spec p7). */
export enum Sap {
  DevMgmt = 0x01,
  WMBus = 0x09,
  ApprovalTest = 0x20,
}

/** Device Management SAP message IDs (spec p18). */
export enum DevMgmt {
  StartupInd = 0x00,
  PingReq = 0x01,
  PingRsp = 0x02,
  GetDeviceInfoReq = 0x03,
  GetDeviceInfoRsp = 0x04,
  GetFwInfoReq = 0x05,
  GetFwInfoRsp = 0x06,
  RestartReq = 0x07,
  RestartRsp = 0x08,
  SetOpModeReq = 0x09,
  SetOpModeRsp = 0x0a,
  GetOpModeReq = 0x0b,
  GetOpModeRsp = 0x0c,
  SetDateTimeReq = 0x0d,
  SetDateTimeRsp = 0x0e,
  GetDateTimeReq = 0x0f,
  GetDateTimeRsp = 0x10,
  SetSystemOptionsReq = 0xf7,
  SetSystemOptionsRsp = 0xf8,
  GetSystemOptionsReq = 0xf9,
  GetSystemOptionsRsp = 0xfa,
}

/** WM-Bus Gateway SAP message IDs (spec p22-55). */
export enum WMBus {
  GetActiveConfigReq = 0x01,
  GetActiveConfigRsp = 0x02,
  SetActiveConfigReq = 0x03,
  SetActiveConfigRsp = 0x04,
  GetDefaultConfigReq = 0x05,
  GetDefaultConfigRsp = 0x06,
  SetDefaultConfigReq = 0x07,
  SetDefaultConfigRsp = 0x08,
  ResetDefaultConfigReq = 0x09,
  ResetDefaultConfigRsp = 0x0a,
  ClearDeviceListReq = 0x11,
  ClearDeviceListRsp = 0x12,
  AppendDeviceListReq = 0x13,
  AppendDeviceListRsp = 0x14,
  ReadDeviceListReq = 0x15,
  ReadDeviceListRsp = 0x16,
  SaveDeviceListReq = 0x17,
  SaveDeviceListRsp = 0x18,
  LoadDeviceListReq = 0x19,
  LoadDeviceListRsp = 0x1a,
  RxMessageInd = 0x20,
  SetScanModeReq = 0x21,
  SetScanModeRsp = 0x22,
  ScanModeInd = 0x24,
  SendMessageReq = 0x31,
  SendMessageRsp = 0x32,
  MessageTransmittedInd = 0x34,
  EncryptSendReq = 0x35,
  EncryptSendRsp = 0x36,
  EncryptedMessageTransmittedInd = 0x38,
  SendPacketReq = 0x39,
  SendPacketRsp = 0x3a,
  EncryptSendPacketReq = 0x3b,
  EncryptSendPacketRsp = 0x3c,
  GetStatusReportReq = 0x41,
  GetStatusReportRsp = 0x42,
  ResetStatusReportReq = 0x43,
  ResetStatusReportRsp = 0x44,
  GetRadioConfigReq = 0x51,
  GetRadioConfigRsp = 0x52,
  SetRadioConfigReq = 0x53,
  SetRadioConfigRsp = 0x54,
  GetWMBusAddressReq = 0x81,
  GetWMBusAddressRsp = 0x82,
}

/** Approval Test SAP message IDs (spec p61, iM881/iM891 only). */
export enum ApprovalTest {
  ResetTestReq = 0x01,
  ResetTestRsp = 0x02,
  EnableCwReq = 0xc1,
  EnableCwRsp = 0xc2,
  EnablePn9Req = 0xc3,
  EnablePn9Rsp = 0xc4,
}

/** Approval Test status codes (spec p62). */
export enum ApprovalStatus {
  Ok = 0x00,
  Error = 0x01,
  Unsupported = 0x02,
  WrongParameter = 0x03,
  WrongMode = 0x04,
  MediaBusy = 0x05,
  Busy = 0x06,
  WrongLength = 0x07,
  NvmWrite = 0x08,
  NvmRead = 0x09,
  Rejected = 0x0a,
  RadioBusy = 0x0b,
  BadFormat = 0x0c,
  WrongRadioMode = 0x0d,
  WrongRadioIndex = 0x0e,
}

/** Device Management status codes (spec p19). */
export enum DevStatus {
  Ok = 0x00,
  Error = 0x01,
  Unsupported = 0x02,
  WrongParameter = 0x03,
  WrongMode = 0x04,
  Busy = 0x06,
  WrongLength = 0x07,
  NvmWrite = 0x08,
  NvmRead = 0x09,
  Rejected = 0x0a,
  BadFormat = 0x0c,
}

/** WM-Bus Gateway status codes (spec p53). */
export enum GwStatus {
  Ok = 0x00,
  Error = 0x01,
  Unsupported = 0x02,
  WrongParameter = 0x03,
  WrongMode = 0x04,
  NoMoreData = 0x05,
  Busy = 0x06,
  WrongLength = 0x07,
  NvmWrite = 0x08,
  NvmRead = 0x09,
  Rejected = 0x0a,
  AccessDenied = 0x0b,
  DataTruncated = 0x0c,
  UnsupportedEncryption = 0x0d,
  NoKey = 0x0e,
  EncryptionInfoMissing = 0x0f,
  EncryptionError = 0x10,
}

export type HciMessage = {sap: number; msg: number; payload: number[]};

/** Build `SAP | Msg | payload | CRC16(LSB-first)` (not yet SLIP-framed). */
export function encodeHci(
  sap: number,
  msg: number,
  payload: ArrayLike<number> = [],
): number[] {
  const body = [sap & 0xff, msg & 0xff];
  for (let i = 0; i < payload.length; i++) body.push(payload[i] & 0xff);
  const [lo, hi] = crc16Bytes(body);
  body.push(lo, hi);
  return body;
}

/** Parse a de-SLIPped frame; returns null if too short or the CRC fails. */
export function decodeHci(frame: ArrayLike<number>): HciMessage | null {
  if (frame.length < 4) return null;
  const body: number[] = [];
  for (let i = 0; i < frame.length - 2; i++) body.push(frame[i] & 0xff);
  const [lo, hi] = crc16Bytes(body);
  if ((frame[frame.length - 2] & 0xff) !== lo) return null;
  if ((frame[frame.length - 1] & 0xff) !== hi) return null;
  return {sap: body[0], msg: body[1], payload: body.slice(2)};
}
