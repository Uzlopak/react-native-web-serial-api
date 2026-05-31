package dev.webserialapi;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbManager;
import android.os.Build;
import android.os.Bundle;

import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.fragment.app.DialogFragment;

import com.hoho.android.usbserial.driver.UsbSerialDriver;
import com.hoho.android.usbserial.driver.UsbSerialPort;
import com.hoho.android.usbserial.driver.UsbSerialProber;

import java.util.ArrayList;
import java.util.List;

public class PortPickerActivity extends AppCompatActivity {

    public static final String EXTRA_DEVICE_ID           = "dev.webserialapi.DEVICE_ID";
    public static final String EXTRA_PORT_NUMBER         = "dev.webserialapi.PORT_NUMBER";
    public static final String EXTRA_FILTERS_VENDOR_IDS  = "dev.webserialapi.FILTER_VENDOR_IDS";
    public static final String EXTRA_FILTERS_PRODUCT_IDS = "dev.webserialapi.FILTER_PRODUCT_IDS";
    public static final String EXTRA_TITLE_SELECT_PORT       = "dev.webserialapi.LABEL_DIALOG_TITLE";
    public static final String EXTRA_TITLE_NO_PORTS_AVAILABLE   = "dev.webserialapi.LABEL_NO_DEVICES_TITLE";
    public static final String EXTRA_MESSAGE_NO_PORTS_AVAILABLE = "dev.webserialapi.LABEL_NO_DEVICES_MESSAGE";

    private static final String DEFAULT_TITLE_SELECT_PORT        = "Select Serial Port";
    private static final String DEFAULT_TITLE_NO_PORTS_AVAILABLE   = "No devices found";
    private static final String DEFAULT_MESSAGE_NO_PORTS_AVAILABLE = "No USB serial devices are connected.";

    private static final String TAG_PICKER_DIALOG = "port_picker_dialog";

    private UsbManager usbManager;
    private int[]      filterVendorIds;
    private int[]      filterProductIds;
    private String     titleSelectPort;
    private String     titleNoPortsAvailable;
    private String     messageNoPortsAvailable;

    // No dialog handle needed – the DialogFragment manages its own lifecycle
    private final BroadcastReceiver usbStateReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action) ||
                    UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                // Dismiss stale dialog and rebuild with the updated device list
                PortPickerDialogFragment old =
                        (PortPickerDialogFragment) getSupportFragmentManager()
                                .findFragmentByTag(TAG_PICKER_DIALOG);
                if (old != null) old.dismissAllowingStateLoss();
                showPickerDialog();
            }
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        usbManager            = (UsbManager) getSystemService(Context.USB_SERVICE);
        filterVendorIds       = getIntent().getIntArrayExtra(EXTRA_FILTERS_VENDOR_IDS);
        filterProductIds      = getIntent().getIntArrayExtra(EXTRA_FILTERS_PRODUCT_IDS);
        titleSelectPort        = getIntent().getStringExtra(EXTRA_TITLE_SELECT_PORT);
        titleNoPortsAvailable  = getIntent().getStringExtra(EXTRA_TITLE_NO_PORTS_AVAILABLE);
        messageNoPortsAvailable = getIntent().getStringExtra(EXTRA_MESSAGE_NO_PORTS_AVAILABLE);

        // RECEIVER_NOT_EXPORTED is required from Android 14 (API 34) onwards
        IntentFilter usbFilter = new IntentFilter();
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        usbFilter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            registerReceiver(usbStateReceiver, usbFilter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(usbStateReceiver, usbFilter);
        }

        // Show dialog only on first launch, not after a configuration change (e.g. rotation)
        if (savedInstanceState == null) {
            showPickerDialog();
        }
    }

    private List<UsbSerialDriver> getFilteredDrivers() {
        List<UsbSerialDriver> drivers =
                UsbSerialProber.getDefaultProber().findAllDrivers(usbManager);

        if (filterVendorIds == null || filterVendorIds.length == 0) {
            return drivers;
        }

        // Guard against mismatched array lengths to avoid ArrayIndexOutOfBoundsException
        int filterCount = Math.min(filterVendorIds.length,
                filterProductIds != null ? filterProductIds.length : 0);

        List<UsbSerialDriver> filtered = new ArrayList<>();
        for (UsbSerialDriver driver : drivers) {
            int vid = driver.getDevice().getVendorId();
            int pid = driver.getDevice().getProductId();
            for (int i = 0; i < filterCount; i++) {
                boolean vidMatch = vid == filterVendorIds[i];
                boolean pidMatch = filterProductIds[i] == -1 || pid == filterProductIds[i];
                if (vidMatch && pidMatch) {
                    filtered.add(driver);
                    break;
                }
            }
        }
        return filtered;
    }

    private void showPickerDialog() {
        PortPickerDialogFragment dialog = PortPickerDialogFragment.newInstance(
                this,
                getFilteredDrivers(),
                resolve(titleSelectPort,        DEFAULT_TITLE_SELECT_PORT),
                resolve(titleNoPortsAvailable,  DEFAULT_TITLE_NO_PORTS_AVAILABLE),
                resolve(messageNoPortsAvailable, DEFAULT_MESSAGE_NO_PORTS_AVAILABLE)
        );
        dialog.show(getSupportFragmentManager(), TAG_PICKER_DIALOG);
    }

    private static String resolve(String override, String defaultValue) {
        return (override != null && !override.isEmpty()) ? override : defaultValue;
    }

    /** Called by the DialogFragment when the user selects a port. */
    void onPortSelected(UsbDevice device, int portNumber) {
        Intent result = new Intent();
        result.putExtra(EXTRA_DEVICE_ID,   device.getDeviceId());
        result.putExtra(EXTRA_PORT_NUMBER, portNumber);
        setResult(RESULT_OK, result);
        finish();
    }

    /** Called by the DialogFragment when the user cancels. */
    void onPickerCancelled() {
        setResult(RESULT_CANCELED);
        finish();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        try { unregisterReceiver(usbStateReceiver); } catch (Exception ignored) {}
    }

    // -------------------------------------------------------------------------
    // Static DialogFragment – survives configuration changes such as rotation
    // -------------------------------------------------------------------------
    public static class PortPickerDialogFragment extends DialogFragment {

        // Not passed via Bundle argument because UsbSerialDriver is not Serializable/Parcelable
        private List<UsbSerialDriver> drivers;
        private PortPickerActivity    host;
        private String                titleSelectPort;
        private String                titleNoPortsAvailable;
        private String                messageNoPortsAvailable;

        static PortPickerDialogFragment newInstance(
                PortPickerActivity host,
                List<UsbSerialDriver> drivers,
                String titleSelectPort,
                String titleNoPortsAvailable,
                String messageNoPortsAvailable) {
            PortPickerDialogFragment f = new PortPickerDialogFragment();
            f.host             = host;
            f.drivers          = drivers;
            f.titleSelectPort        = titleSelectPort;
            f.titleNoPortsAvailable  = titleNoPortsAvailable;
            f.messageNoPortsAvailable = messageNoPortsAvailable;
            return f;
        }

        @Override
        public android.app.Dialog onCreateDialog(Bundle savedInstanceState) {
            Context ctx = requireContext();

            if (drivers == null || drivers.isEmpty()) {
                return new AlertDialog.Builder(ctx)
                        .setTitle(titleNoPortsAvailable)
                        .setMessage(messageNoPortsAvailable)
                        .setPositiveButton(android.R.string.ok, (d, w) -> cancelAndFinish())
                        .setOnCancelListener(d -> cancelAndFinish())
                        .create();
            }

            List<String>          labels          = new ArrayList<>();
            List<UsbSerialDriver> flatDrivers     = new ArrayList<>();
            List<Integer>         flatPortNumbers = new ArrayList<>();

            for (UsbSerialDriver driver : drivers) {
                UsbDevice           device = driver.getDevice();
                List<UsbSerialPort> ports  = driver.getPorts();
                String driverName = driver.getClass().getSimpleName()
                        .replace("SerialDriver", "")
                        .replace("Serial", "");
                for (int i = 0; i < ports.size(); i++) {
                    String label = ports.size() > 1
                            ? String.format("%s  ·  VID 0x%04X / PID 0x%04X  ·  Port %d",
                                    driverName, device.getVendorId(), device.getProductId(), i)
                            : String.format("%s  ·  VID 0x%04X / PID 0x%04X",
                                    driverName, device.getVendorId(), device.getProductId());
                    labels.add(label);
                    flatDrivers.add(driver);
                    flatPortNumbers.add(i);
                }
            }

            return new AlertDialog.Builder(ctx)
                    .setTitle(titleSelectPort)
                    .setItems(labels.toArray(new String[0]), (d, which) -> {
                        if (host != null) {
                            host.onPortSelected(
                                    flatDrivers.get(which).getDevice(),
                                    flatPortNumbers.get(which));
                        }
                    })
                    .setNegativeButton(android.R.string.cancel, (d, w) -> cancelAndFinish())
                    .setOnCancelListener(d -> cancelAndFinish())
                    .create();
        }

        private void cancelAndFinish() {
            if (host != null) host.onPickerCancelled();
        }
    }
}
