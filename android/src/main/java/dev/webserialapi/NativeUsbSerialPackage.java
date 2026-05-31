package dev.webserialapi;

import androidx.annotation.Nullable;
import com.facebook.react.BaseReactPackage;
import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;

import java.util.HashMap;
import java.util.Map;

// `implements ReactPackage` is redundant (BaseReactPackage already implements
// it) but lets the React Native CLI's autolinking detect this package class —
// its matcher only recognizes `implements ReactPackage` / `extends TurboReactPackage`.
public class NativeUsbSerialPackage extends BaseReactPackage implements ReactPackage {

    @Nullable
    @Override
    public NativeModule getModule(String name, ReactApplicationContext reactContext) {
        if (name.equals(NativeUsbSerialModule.NAME)) {
            return new NativeUsbSerialModule(reactContext);
        }
        return null;
    }

    @Override
    public ReactModuleInfoProvider getReactModuleInfoProvider() {
        return () -> {
            Map<String, ReactModuleInfo> map = new HashMap<>();
            map.put(
                NativeUsbSerialModule.NAME,
                new ReactModuleInfo(
                    NativeUsbSerialModule.NAME,
                    NativeUsbSerialModule.NAME,
                    false,
                    false,
                    false,
                    true
                )
            );
            return map;
        };
    }
}
