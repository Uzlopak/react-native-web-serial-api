package dev.webserialapi;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReadableArray;
import com.facebook.react.bridge.ReadableMap;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;
import com.hoho.android.usbserial.util.SerialInputOutputManager;

import android.app.Activity;
import android.content.ActivityNotFoundException;

import com.facebook.react.bridge.ActivityEventListener;
import com.facebook.react.bridge.BaseActivityEventListener;

import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class NativeUsbSerialModule extends NativeUsbSerialSpec {

    public static final String NAME = "NativeUsbSerial";
    private static final String ACTION_USB_PERMISSION = "dev.webserialapi.USB_PERMISSION";
    private static final String EXTRA_REQUEST_CODE = "dev.webserialapi.REQUEST_CODE";

    private final UsbManager usbManager;

    // key: "deviceId:portNumber"
    private final Map<String, UsbSerialPort> openPorts = new HashMap<>();
    private final Map<String, UsbDeviceConnection> openConnections = new HashMap<>();
    private final Map<String, SerialInputOutputManager> ioManagers = new HashMap<>();

    // key: requestCode
    private final Map<Integer, Promise> pendingPermissions = new HashMap<>();
    private int nextRequestCode = 0;

    private static final int PORT_PICKER_REQUEST_CODE = 0xAB8465;
    private Promise pendingPortPickerPromise = null;

    private final ActivityEventListener activityEventListener = new BaseActivityEventListener() {
        @Override
        public void onActivityResult(Activity activity, int requestCode, int resultCode, Intent data) {
            if (requestCode != PORT_PICKER_REQUEST_CODE) return;

            Promise promise = pendingPortPickerPromise;
            pendingPortPickerPromise = null;

            if (promise == null) return;

            if (resultCode != Activity.RESULT_OK || data == null) {
                promise.reject("PORT_PICKER_CANCELED", "No port selected by the user.");
                return;
            }

            int deviceId   = data.getIntExtra(PortPickerActivity.EXTRA_DEVICE_ID, -1);
            int portNumber = data.getIntExtra(PortPickerActivity.EXTRA_PORT_NUMBER, 0);

            UsbSerialDriver driver = findDriver(deviceId);
            if (driver == null) {
                promise.reject("DRIVER_NOT_FOUND", "No driver found for deviceId: " + deviceId);
                return;
            }

            // Request permission if not already granted, then resolve with PortId
            requestPermission(deviceId, new PromiseWrapper(promise) {
                @Override
                public void onResolve(Object value) {
                    Boolean granted = (Boolean) value;
                    if (granted == null || !granted) {
                        promise.reject("PERMISSION_DENIED", "USB permission denied");
                        return;
                    }
                    WritableMap result = Arguments.createMap();
                    result.putInt("deviceId", deviceId);
                    result.putInt("portNumber", portNumber);
                    result.putInt("usbVendorId", driver.getDevice().getVendorId());
                    result.putInt("usbProductId", driver.getDevice().getProductId());
                    // Permission was just granted above, so this port is accessible.
                    result.putBoolean("hasPermission", true);
                    promise.resolve(result);
                }
            });
        }
    };

    private final BroadcastReceiver permissionReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (ACTION_USB_PERMISSION.equals(intent.getAction())) {
                int requestCode = intent.getIntExtra(EXTRA_REQUEST_CODE, -1);
                boolean granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false);
                Promise promise = pendingPermissions.remove(requestCode);
                if (promise != null) {
                    promise.resolve(granted);
                }
            }
        }
    };

    private final BroadcastReceiver usbStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (device == null) return;

            WritableMap event = Arguments.createMap();
            event.putInt("deviceId", device.getDeviceId());
            event.putInt("usbVendorId", device.getVendorId());
            event.putInt("usbProductId", device.getProductId());

            if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                sendEvent("connect", event);
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                // Close any open ports for this device.
                // The disconnect event is sent by UsbDetachReceiver.
                String prefix = device.getDeviceId() + ":";
                for (String key : new ArrayList<>(openPorts.keySet())) {
                    if (key.startsWith(prefix)) {
                        SerialInputOutputManager ioManager = ioManagers.remove(key);
                        if (ioManager != null) ioManager.stop();
                        UsbSerialPort port = openPorts.remove(key);
                        UsbDeviceConnection connection = openConnections.remove(key);
                        try { if (port != null) port.close(); } catch (Exception ignored) {}
                        try { if (connection != null) connection.close(); } catch (Exception ignored) {}
                    }
                }
            }
        }
    };

    public NativeUsbSerialModule(ReactApplicationContext reactContext) {
        super(reactContext);
        usbManager = (UsbManager) reactContext.getSystemService(Context.USB_SERVICE);

        IntentFilter permissionFilter = new IntentFilter(ACTION_USB_PERMISSION);
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
            reactContext.registerReceiver(permissionReceiver, permissionFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            reactContext.registerReceiver(permissionReceiver, permissionFilter);
        }

        reactContext.addActivityEventListener(activityEventListener);

        IntentFilter usbFilter = new IntentFilter();
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        reactContext.registerReceiver(usbStateReceiver, usbFilter);
    }

    // Helper to avoid implementing all Promise methods in anonymous classes
    private abstract static class PromiseWrapper implements Promise {
        private final Promise delegate;
        PromiseWrapper(Promise delegate) { this.delegate = delegate; }
        public abstract void onResolve(Object value);
        @Override public void resolve(Object value) { onResolve(value); }
        @Override public void reject(String c) { delegate.reject(c); }
        @Override public void reject(String c, String m) { delegate.reject(c, m); }
        @Override public void reject(String c, Throwable e) { delegate.reject(c, e); }
        @Override public void reject(String c, String m, Throwable e) { delegate.reject(c, m, e); }
        @Override public void reject(Throwable e) { delegate.reject(e); }
        @Override public void reject(Throwable e, WritableMap u) { delegate.reject(e, u); }
        @Override public void reject(String c, WritableMap u) { delegate.reject(c, u); }
        @Override public void reject(String c, String m, WritableMap u) { delegate.reject(c, m, u); }
        @Override public void reject(String c, Throwable e, WritableMap u) { delegate.reject(c, e, u); }
        @Override public void reject(String c, String m, Throwable e, WritableMap u) { delegate.reject(c, m, e, u); }
    }

    @Override
    public String getName() {
        return NAME;
    }

    // --- Helper ---

    private String portKey(int deviceId, int portNumber) {
        return deviceId + ":" + portNumber;
    }

    private UsbSerialPort getOpenPort(int deviceId, int portNumber, Promise promise) {
        UsbSerialPort port = openPorts.get(portKey(deviceId, portNumber));
        if (port == null) {
            promise.reject("PORT_NOT_OPEN", "Port " + portKey(deviceId, portNumber) + " is not open");
        }
        return port;
    }

    private void sendEvent(String eventName, WritableMap params) {
        getReactApplicationContext()
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit(eventName, params);
    }

    private UsbSerialDriver findDriver(int deviceId) {
        List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
        for (UsbSerialDriver driver : drivers) {
            if (driver.getDevice().getDeviceId() == deviceId) {
                return driver;
            }
        }
        return null;
    }

    // --- Spec implementation ---

    @Override
    public void findAllDrivers(Promise promise) {
        try {
            List<UsbSerialDriver> drivers = UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);
            WritableArray result = Arguments.createArray();
            for (UsbSerialDriver driver : drivers) {
                UsbDevice device = driver.getDevice();
                // Whether the app already holds Android USB permission for this
                // device. This is granted either via the system "use by default"
                // attach dialog or a prior requestPermission()/requestPort() flow.
                boolean hasPermission = usbManager.hasPermission(device);
                List<UsbSerialPort> ports = driver.getPorts();
                for (int i = 0; i < ports.size(); i++) {
                    WritableMap map = Arguments.createMap();
                    map.putInt("deviceId", device.getDeviceId());
                    map.putInt("portNumber", i);
                    map.putInt("usbVendorId", device.getVendorId());
                    map.putInt("usbProductId", device.getProductId());
                    map.putBoolean("hasPermission", hasPermission);
                    result.pushMap(map);
                }
            }
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("FIND_DRIVERS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void open(double deviceId, double portNumber, double baudRate, double dataBits, double stopBits, double parity, Promise promise) {
        try {
            int dId = (int) deviceId;
            int pNum = (int) portNumber;
            String key = portKey(dId, pNum);

            if (openPorts.containsKey(key)) {
                promise.reject("PORT_ALREADY_OPEN", "Port is already open");
                return;
            }

            UsbSerialDriver driver = findDriver(dId);
            if (driver == null) {
                promise.reject("DRIVER_NOT_FOUND", "No driver found for deviceId: " + dId);
                return;
            }

            if (!usbManager.hasPermission(driver.getDevice())) {
                // Permission not yet granted — request it and open the port when granted
                final double fDeviceId = deviceId;
                final double fPortNumber = portNumber;
                final double fBaudRate = baudRate;
                final double fDataBits = dataBits;
                final double fStopBits = stopBits;
                final double fParity = parity;
                requestPermission(deviceId, new PromiseWrapper(promise) {
                    @Override
                    public void onResolve(Object value) {
                        Boolean granted = (Boolean) value;
                        if (granted != null && granted) {
                            open(fDeviceId, fPortNumber, fBaudRate, fDataBits, fStopBits, fParity, promise);
                        } else {
                            promise.reject("PERMISSION_DENIED", "USB permission denied");
                        }
                    }
                });
                return;
            }

            UsbDeviceConnection connection = usbManager.openDevice(driver.getDevice());
            if (connection == null) {
                promise.reject("CONNECTION_FAILED", "Could not open USB connection");
                return;
            }

            UsbSerialPort port = driver.getPorts().get(pNum);
            port.open(connection);
            port.setParameters((int) baudRate, (int) dataBits, (int) stopBits, (int) parity);

            openPorts.put(key, port);
            openConnections.put(key, connection);

            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("OPEN_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void close(double deviceId, double portNumber, Promise promise) {
        try {
            int dId = (int) deviceId;
            int pNum = (int) portNumber;
            String key = portKey(dId, pNum);

            SerialInputOutputManager ioManager = ioManagers.remove(key);
            if (ioManager != null) {
                ioManager.stop();
            }

            UsbSerialPort port = openPorts.remove(key);
            UsbDeviceConnection connection = openConnections.remove(key);

            if (port != null) port.close();
            if (connection != null) connection.close();

            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("CLOSE_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public boolean isOpen(double deviceId, double portNumber) {
        UsbSerialPort port = openPorts.get(portKey((int) deviceId, (int) portNumber));
        return port != null && port.isOpen();
    }

    @Override
    public void write(double deviceId, double portNumber, ReadableArray data, double timeout, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;

            byte[] bytes = new byte[data.size()];
            for (int i = 0; i < data.size(); i++) {
                bytes[i] = (byte) data.getInt(i);
            }
            port.write(bytes, (int) timeout);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("WRITE_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void startReading(double deviceId, double portNumber, Promise promise) {
        try {
            int dId = (int) deviceId;
            int pNum = (int) portNumber;
            String key = portKey(dId, pNum);

            UsbSerialPort port = getOpenPort(dId, pNum, promise);
            if (port == null) return;

            if (ioManagers.containsKey(key)) {
                promise.resolve(null);
                return;
            }

            SerialInputOutputManager ioManager = new SerialInputOutputManager(port, new SerialInputOutputManager.Listener() {
                @Override
                public void onNewData(byte[] data) {
                    WritableArray bytes = Arguments.createArray();
                    for (byte b : data) {
                        bytes.pushInt(b & 0xFF);
                    }
                    WritableMap event = Arguments.createMap();
                    event.putInt("deviceId", dId);
                    event.putInt("portNumber", pNum);
                    event.putArray("data", bytes);
                    sendEvent("data", event);
                }

                @Override
                public void onRunError(Exception e) {
                    ioManagers.remove(key);
                    // If the port was already removed by the detach handler, this is a
                    // disconnect-related error — don't fire an error event
                    if (!openPorts.containsKey(key)) return;
                    WritableMap event = Arguments.createMap();
                    event.putInt("deviceId", dId);
                    event.putInt("portNumber", pNum);
                    event.putString("error", e.getMessage());
                    sendEvent("error", event);
                }
            });

            ioManager.start();
            ioManagers.put(key, ioManager);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("START_READING_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void stopReading(double deviceId, double portNumber, Promise promise) {
        String key = portKey((int) deviceId, (int) portNumber);
        SerialInputOutputManager ioManager = ioManagers.remove(key);
        if (ioManager != null) {
            ioManager.stop();
        }
        promise.resolve(null);
    }

    @Override
    public void setParameters(double deviceId, double portNumber, double baudRate, double dataBits, double stopBits, double parity, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.setParameters((int) baudRate, (int) dataBits, (int) stopBits, (int) parity);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("SET_PARAMETERS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void setDTR(double deviceId, double portNumber, boolean value, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.setDTR(value);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("SET_DTR_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void setRTS(double deviceId, double portNumber, boolean value, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.setRTS(value);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("SET_RTS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getDTR(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getDTR());
        } catch (Exception e) {
            promise.reject("GET_DTR_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getRTS(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getRTS());
        } catch (Exception e) {
            promise.reject("GET_RTS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getCD(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getCD());
        } catch (Exception e) {
            promise.reject("GET_CD_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getCTS(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getCTS());
        } catch (Exception e) {
            promise.reject("GET_CTS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getDSR(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getDSR());
        } catch (Exception e) {
            promise.reject("GET_DSR_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getRI(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getRI());
        } catch (Exception e) {
            promise.reject("GET_RI_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getControlLines(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            EnumSet<UsbSerialPort.ControlLine> lines = port.getControlLines();
            WritableArray result = Arguments.createArray();
            for (UsbSerialPort.ControlLine line : lines) {
                result.pushString(line.name());
            }
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("GET_CONTROL_LINES_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getSupportedControlLines(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            EnumSet<UsbSerialPort.ControlLine> lines = port.getSupportedControlLines();
            WritableArray result = Arguments.createArray();
            for (UsbSerialPort.ControlLine line : lines) {
                result.pushString(line.name());
            }
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("GET_SUPPORTED_CONTROL_LINES_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void setFlowControl(double deviceId, double portNumber, String flowControl, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.setFlowControl(UsbSerialPort.FlowControl.valueOf(flowControl));
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("SET_FLOW_CONTROL_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getFlowControl(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getFlowControl().name());
        } catch (Exception e) {
            promise.reject("GET_FLOW_CONTROL_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getSupportedFlowControl(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            EnumSet<UsbSerialPort.FlowControl> modes = port.getSupportedFlowControl();
            WritableArray result = Arguments.createArray();
            for (UsbSerialPort.FlowControl mode : modes) {
                result.pushString(mode.name());
            }
            promise.resolve(result);
        } catch (Exception e) {
            promise.reject("GET_SUPPORTED_FLOW_CONTROL_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void setBreak(double deviceId, double portNumber, boolean value, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.setBreak(value);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("SET_BREAK_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void purgeHwBuffers(double deviceId, double portNumber, boolean purgeWriteBuffers, boolean purgeReadBuffers, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            port.purgeHwBuffers(purgeWriteBuffers, purgeReadBuffers);
            promise.resolve(null);
        } catch (Exception e) {
            promise.reject("PURGE_HW_BUFFERS_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void getSerial(double deviceId, double portNumber, Promise promise) {
        try {
            UsbSerialPort port = getOpenPort((int) deviceId, (int) portNumber, promise);
            if (port == null) return;
            promise.resolve(port.getSerial());
        } catch (Exception e) {
            promise.reject("GET_SERIAL_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void requestPermission(double deviceId, Promise promise) {
        try {
            UsbSerialDriver driver = findDriver((int) deviceId);
            if (driver == null) {
                promise.reject("DRIVER_NOT_FOUND", "No driver found for deviceId: " + (int) deviceId);
                return;
            }
            if (usbManager.hasPermission(driver.getDevice())) {
                promise.resolve(true);
                return;
            }

            int requestCode = nextRequestCode++;
            pendingPermissions.put(requestCode, promise);

            Intent intent = new Intent(ACTION_USB_PERMISSION);
            intent.putExtra(EXTRA_REQUEST_CODE, requestCode);

            PendingIntent permissionIntent = PendingIntent.getBroadcast(
                getReactApplicationContext(),
                requestCode,
                intent,
                PendingIntent.FLAG_IMMUTABLE
            );
            usbManager.requestPermission(driver.getDevice(), permissionIntent);
        } catch (Exception e) {
            promise.reject("REQUEST_PERMISSION_ERROR", e.getMessage(), e);
        }
    }

    @Override
    public void showPortPicker(ReadableArray filters, ReadableMap labels, Promise promise) {
        Activity activity = getCurrentActivity();
        if (activity == null) {
            promise.reject("NO_ACTIVITY", "No current activity available");
            return;
        }
        if (pendingPortPickerPromise != null) {
            promise.reject("PICKER_ALREADY_OPEN", "Port picker is already open");
            return;
        }
        pendingPortPickerPromise = promise;
        Intent intent = new Intent(getReactApplicationContext(), PortPickerActivity.class);

        // Pass filters as parallel int arrays
        if (filters != null && filters.size() > 0) {
            int[] vendorIds  = new int[filters.size()];
            int[] productIds = new int[filters.size()];
            for (int i = 0; i < filters.size(); i++) {
                ReadableMap filter = filters.getMap(i);
                vendorIds[i]  = filter != null && filter.hasKey("usbVendorId")  ? filter.getInt("usbVendorId")  : -1;
                productIds[i] = filter != null && filter.hasKey("usbProductId") ? filter.getInt("usbProductId") : -1;
            }
            intent.putExtra(PortPickerActivity.EXTRA_FILTERS_VENDOR_IDS,  vendorIds);
            intent.putExtra(PortPickerActivity.EXTRA_FILTERS_PRODUCT_IDS, productIds);
        }

        // Pass optional label overrides to PortPickerActivity
        if (labels != null) {
            if (labels.hasKey("titleSelectPort"))
                intent.putExtra(PortPickerActivity.EXTRA_TITLE_SELECT_PORT,
                        labels.getString("titleSelectPort"));
            if (labels.hasKey("titleNoPortsAvailable"))
                intent.putExtra(PortPickerActivity.EXTRA_TITLE_NO_PORTS_AVAILABLE,
                        labels.getString("titleNoPortsAvailable"));
            if (labels.hasKey("messageNoPortsAvailable"))
                intent.putExtra(PortPickerActivity.EXTRA_MESSAGE_NO_PORTS_AVAILABLE,
                        labels.getString("messageNoPortsAvailable"));
        }

        try {
            activity.startActivityForResult(intent, PORT_PICKER_REQUEST_CODE);
        } catch (ActivityNotFoundException e) {
            pendingPortPickerPromise = null;
            promise.reject("ACTIVITY_NOT_FOUND", e.getMessage(), e);
        }
    }

    @Override
    public void addListener(String eventName) {}

    @Override
    public void removeListeners(double count) {}
}
