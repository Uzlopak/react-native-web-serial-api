npx react-native bundle \
  --platform android \
  --dev false \
  --entry-file index.js \
  --bundle-output android/app/src/main/assets/index.android.bundle \
  --assets-dest android/app/src/main/res

cd android && ./gradlew assembleDebug && cd ..
npm run android -- --deviceId 192.168.178.73:5555