package dev.webserialapi;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;

import com.facebook.react.ReactApplication;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class UsbDetachReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!UsbManager.ACTION_USB_DEVICE_DETACHED.equals(intent.getAction())) return;

        UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
        if (device == null) return;

        ReactApplication app = (ReactApplication) context.getApplicationContext();
        ReactContext reactContext = app.getReactHost().getCurrentReactContext();
        if (reactContext == null) return;

        WritableMap event = Arguments.createMap();
        event.putInt("deviceId", device.getDeviceId());
        event.putInt("usbVendorId", device.getVendorId());
        event.putInt("usbProductId", device.getProductId());

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit("disconnect", event);
    }
}
