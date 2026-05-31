// On web there is no native USB-serial TurboModule. serial.web.ts delegates to
// the browser's native navigator.serial, and UsbSerial.getUsbSerial() treats a
// null module as "not available" — so this stub simply avoids touching
// TurboModuleRegistry (which does not exist under react-native-web).
export default null;
