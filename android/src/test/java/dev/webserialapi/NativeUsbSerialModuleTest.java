package dev.webserialapi;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import android.app.Activity;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.hardware.usb.UsbManager;

import androidx.annotation.Nullable;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.JavaOnlyArray;
import com.facebook.react.bridge.JavaOnlyMap;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.Implementation;
import org.robolectric.annotation.Implements;

/**
 * Robolectric unit tests for {@link NativeUsbSerialModule}.
 *
 * Robolectric supplies a real-enough Android runtime (UsbManager shadow, etc.)
 * so the module's UsbManager access and lifecycle can be exercised on the JVM
 * with no device. The {@link ReactApplicationContext} (abstract in this RN
 * version) is a Mockito mock that delegates the one system service the module
 * needs and lets us verify teardown. {@link ShadowArguments} swaps the
 * JNI-backed Arguments factory for pure-Java Writable* implementations.
 */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34, shadows = {NativeUsbSerialModuleTest.ShadowArguments.class})
public class NativeUsbSerialModuleTest {

    private ReactApplicationContext ctx;
    private NativeUsbSerialModule module;

    @Before
    public void setUp() {
        Application app = RuntimeEnvironment.getApplication();
        UsbManager usbManager = (UsbManager) app.getSystemService(Context.USB_SERVICE);

        ctx = mock(ReactApplicationContext.class);
        when(ctx.getSystemService(Context.USB_SERVICE)).thenReturn(usbManager);

        module = new NativeUsbSerialModule(ctx);
    }

    @After
    public void tearDown() {
        // Release the module's background executor (and receivers) so its
        // non-daemon worker thread doesn't outlive the test.
        try {
            module.invalidate();
        } catch (Exception ignored) {
            // already invalidated by the test under exercise
        }
    }

    @Test
    public void exposesStableModuleName() {
        assertEquals("NativeUsbSerial", module.getName());
    }

    @Test
    public void findAllDriversResolvesEmptyWhenNoDevicesAttached() {
        RecordingPromise promise = new RecordingPromise();
        module.findAllDrivers(promise);

        assertTrue(promise.resolved);
        assertTrue(promise.value instanceof WritableArray);
        assertEquals(0, ((WritableArray) promise.value).size());
    }

    @Test
    public void openRejectsWhenNoDriverForDeviceId() {
        RecordingPromise promise = new RecordingPromise();
        module.open(999, 0, 9600, 8, 1, 0, promise);

        assertTrue(promise.rejected);
        assertEquals("DRIVER_NOT_FOUND", promise.rejectCode);
    }

    @Test
    public void isOpenIsFalseForAPortThatWasNeverOpened() {
        assertFalse(module.isOpen(1, 0));
    }

    @Test
    public void portOperationsRejectCleanlyWhenPortIsNotOpen() {
        // The shared getOpenPort() guard must reject (not crash) for every
        // control method when nothing is open.
        RecordingPromise write = new RecordingPromise();
        module.write(1, 0, new JavaOnlyArray(), 2000, write);
        assertEquals("PORT_NOT_OPEN", write.rejectCode);

        RecordingPromise dtr = new RecordingPromise();
        module.setDTR(1, 0, true, dtr);
        assertEquals("PORT_NOT_OPEN", dtr.rejectCode);

        RecordingPromise cts = new RecordingPromise();
        module.getCTS(1, 0, cts);
        assertEquals("PORT_NOT_OPEN", cts.rejectCode);
    }

    @Test
    public void requestPermissionRejectsForUnknownDevice() {
        RecordingPromise promise = new RecordingPromise();
        module.requestPermission(999, promise);

        assertTrue(promise.rejected);
        assertEquals("DRIVER_NOT_FOUND", promise.rejectCode);
    }

    @Test
    public void closeAndStopReadingResolveGracefullyWhenNothingIsOpen() {
        RecordingPromise close = new RecordingPromise();
        module.close(1, 0, close);
        assertTrue(close.resolved);
        assertNull(close.value);

        RecordingPromise stop = new RecordingPromise();
        module.stopReading(1, 0, stop);
        assertTrue(stop.resolved);
    }

    @Test
    public void showPortPickerDoesNotWedgeWhenLaunchFails() {
        Activity activity = mock(Activity.class);
        when(ctx.getCurrentActivity()).thenReturn(activity);
        when(ctx.getPackageName()).thenReturn("dev.webserialapi");
        // A non-ActivityNotFoundException failure to launch the picker.
        doThrow(new RuntimeException("launch boom"))
                .when(activity).startActivityForResult(any(Intent.class), anyInt());

        RecordingPromise first = new RecordingPromise();
        module.showPortPicker(null, null, first);
        assertTrue("a failed launch must settle the promise", first.rejected);

        // The failed launch must clear the pending slot; a second attempt must
        // proceed rather than be rejected with PICKER_ALREADY_OPEN.
        Activity activity2 = mock(Activity.class);
        when(ctx.getCurrentActivity()).thenReturn(activity2);
        RecordingPromise second = new RecordingPromise();
        module.showPortPicker(null, null, second);
        assertFalse(
                "picker must not stay wedged after a failed launch",
                "PICKER_ALREADY_OPEN".equals(second.rejectCode));
    }

    @Test
    public void invalidateUnregistersReceiversAndActivityListener() {
        // The module registers two BroadcastReceivers and one ActivityEventListener
        // in its constructor; invalidate() must release every one of them.
        module.invalidate();

        verify(ctx, times(2)).unregisterReceiver(any(BroadcastReceiver.class));
        verify(ctx).removeActivityEventListener(any());
    }

    /** Captures the outcome of a TurboModule Promise for assertions. */
    private static final class RecordingPromise implements Promise {
        boolean resolved;
        boolean rejected;
        @Nullable Object value;
        @Nullable String rejectCode;
        @Nullable String rejectMessage;

        @Override
        public void resolve(@Nullable Object value) {
            this.resolved = true;
            this.value = value;
        }

        @Override
        public void reject(String code, String message) {
            this.rejected = true;
            this.rejectCode = code;
            this.rejectMessage = message;
        }

        @Override public void reject(String code) { reject(code, (String) null); }
        @Override public void reject(String code, Throwable e) { reject(code, e == null ? null : e.getMessage()); }
        @Override public void reject(String code, String message, Throwable e) { reject(code, message); }
        @Override public void reject(Throwable e) { reject("EUNSPECIFIED", e == null ? null : e.getMessage()); }
        @Override public void reject(Throwable e, WritableMap userInfo) { reject("EUNSPECIFIED", e == null ? null : e.getMessage()); }
        @Override public void reject(String code, WritableMap userInfo) { reject(code, (String) null); }
        @Override public void reject(String code, Throwable e, WritableMap userInfo) { reject(code, e == null ? null : e.getMessage()); }
        @Override public void reject(String code, String message, WritableMap userInfo) { reject(code, message); }
        @Override public void reject(String code, String message, Throwable e, WritableMap userInfo) { reject(code, message); }
    }

    /** Replaces the native Arguments factory with pure-Java equivalents. */
    @Implements(Arguments.class)
    public static class ShadowArguments {
        @Implementation
        public static WritableArray createArray() {
            return new JavaOnlyArray();
        }

        @Implementation
        public static WritableMap createMap() {
            return new JavaOnlyMap();
        }
    }
}
