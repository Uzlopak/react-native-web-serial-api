#!/usr/bin/env bash
#
# Build and install a standalone RELEASE build of the example app.
#
# A release build embeds the JS bundle (assets/index.android.bundle) into the
# APK, so the app runs WITHOUT Metro / a dev server. The JS bundler runs once
# at build time; after install the app is fully self-contained.
#
# To avoid shipping a STALE bundle, every build first clears Metro's caches and
# deletes the previously generated JS-bundle artifacts, so the bundle is always
# re-transformed from the current source (see "force a fresh JS bundle" below).
# Pass --keep-cache to skip that and reuse caches for a faster incremental build.
#
# Usage (run from the example/ directory):
#   ./deploy-release.sh                # build, install on the connected device, launch
#   ./deploy-release.sh --build        # build the APK only (no install)
#   ./deploy-release.sh --no-launch
#   ./deploy-release.sh --keep-cache   # reuse Metro/bundle caches (faster, may be stale)
#   DEVICE=192.168.1.50:5555 ./deploy-release.sh   # target a specific adb device
#
# Environment overrides (auto-detected if unset):
#   JAVA_HOME      - JDK 17 (RN 0.85 / Gradle 8.13 require JDK 17-21)
#   ANDROID_HOME   - Android SDK location
#   NODE_BIN       - directory containing a Node >= 20 binary (RN 0.85 metro needs it)
#
set -euo pipefail

APP_ID="dev.react_native_web_serial_api.example"
MAIN_ACTIVITY="${APP_ID}/.MainActivity"

# Resolve paths relative to this script so it works from any CWD.
# This script lives in <repo>/example; that is the buildable app
# (the repo-root android/ is the library module and has no gradlew).
EXAMPLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$EXAMPLE_DIR/android"
APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"

# --- arg parsing ---------------------------------------------------------
DO_INSTALL=1
DO_LAUNCH=1
KEEP_CACHE=0
for arg in "$@"; do
  case "$arg" in
    --build)      DO_INSTALL=0; DO_LAUNCH=0 ;;
    --no-launch)  DO_LAUNCH=0 ;;
    --keep-cache) KEEP_CACHE=1 ;;
    -h|--help)   grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# --- toolchain auto-detection -------------------------------------------
# JDK 17 (only override if the current java isn't already 17-21).
if [ -z "${JAVA_HOME:-}" ]; then
  for d in /usr/lib/jvm/java-17-openjdk-amd64 /usr/lib/jvm/java-21-openjdk-amd64 \
           /usr/lib/jvm/temurin-17-jdk-amd64; do
    [ -d "$d" ] && export JAVA_HOME="$d" && break
  done
fi
[ -n "${JAVA_HOME:-}" ] && echo "JAVA_HOME=$JAVA_HOME"

# Android SDK.
if [ -z "${ANDROID_HOME:-}" ]; then
  for d in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk" "${ANDROID_SDK_ROOT:-}"; do
    [ -n "$d" ] && [ -d "$d" ] && export ANDROID_HOME="$d" && break
  done
fi
if [ -z "${ANDROID_HOME:-}" ]; then
  echo "ERROR: Android SDK not found. Set ANDROID_HOME." >&2
  exit 1
fi
echo "ANDROID_HOME=$ANDROID_HOME"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# Node >= 20 (RN 0.85 metro-config uses Array.prototype.toReversed()).
need_node() { node -e 'process.exit(typeof [].toReversed==="function"?0:1)' 2>/dev/null; }
if [ -n "${NODE_BIN:-}" ]; then
  export PATH="$NODE_BIN:$PATH"
fi
if ! command -v node >/dev/null 2>&1 || ! need_node; then
  # Try the newest nvm-managed Node >= 20.
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for v in $(ls -1 "$HOME/.nvm/versions/node" | sort -Vr); do
      if "$HOME/.nvm/versions/node/$v/bin/node" -e 'process.exit(typeof [].toReversed==="function"?0:1)' 2>/dev/null; then
        export PATH="$HOME/.nvm/versions/node/$v/bin:$PATH"
        break
      fi
    done
  fi
fi
if ! need_node; then
  echo "ERROR: need Node >= 20 (found $(node -v 2>/dev/null || echo none)). Set NODE_BIN." >&2
  exit 1
fi
echo "node=$(node -v)"

# --- pick adb device -----------------------------------------------------
adb_target=()
if [ -n "${DEVICE:-}" ]; then
  adb connect "$DEVICE" >/dev/null 2>&1 || true
  adb_target=(-s "$DEVICE")
fi

# --- force a fresh JS bundle (avoid embedding a stale one) ----------------
# A release build embeds the JS bundle at build time, and two caches can make
# that embedded bundle STALE:
#   1. Metro's transform / file-map cache (in os.tmpdir()).
#   2. Gradle treating its bundle task (createBundleReleaseJsAndAssets) as
#      up-to-date. That task's inputs are the example app's JS, but the LIBRARY
#      source lives outside example/ (at the repo root, aliased in via
#      babel module-resolver), so edits there don't mark the task out of date.
# Clearing Metro's caches and deleting the generated/merged bundle artifacts
# forces a full re-transform from current source. Only JS-bundle artifacts are
# removed, so the (slow) native build stays incrementally cached.
if [ "$KEEP_CACHE" -eq 1 ]; then
  echo "==> --keep-cache: reusing Metro/bundle caches (build may be stale)."
else
  echo "==> Clearing Metro caches and stale JS-bundle artifacts…"
  metro_tmp="$(node -e 'process.stdout.write(require("os").tmpdir())' 2>/dev/null || echo "${TMPDIR:-/tmp}")"
  rm -rf "$metro_tmp"/metro-cache "$metro_tmp"/metro-file-map-* \
         "$metro_tmp"/haste-map-* "$metro_tmp"/metro-symbolicate* 2>/dev/null || true
  rm -rf "$ANDROID_DIR"/app/build/generated/assets/react \
         "$ANDROID_DIR"/app/build/generated/res/react \
         "$ANDROID_DIR"/app/build/generated/sourcemaps/react \
         "$ANDROID_DIR"/app/build/intermediates/assets/release \
         "$ANDROID_DIR"/app/build/intermediates/merged_assets/release \
         "$ANDROID_DIR"/app/build/intermediates/compressed_assets/release 2>/dev/null || true
fi

# --- build ---------------------------------------------------------------
echo "==> Building release APK (embeds JS bundle)…"
( cd "$ANDROID_DIR" && ./gradlew :app:assembleRelease )

if [ ! -f "$APK" ]; then
  echo "ERROR: APK not found at $APK" >&2
  exit 1
fi
echo "==> Built: $APK ($(du -h "$APK" | cut -f1))"

[ "$DO_INSTALL" -eq 1 ] || { echo "Build-only mode; done."; exit 0; }

# --- install -------------------------------------------------------------
echo "==> Installing on device…"
# Capture output instead of piping into `grep -q`: under `set -o pipefail`,
# grep closing the pipe early can make a successful install report failure.
install_out="$(adb "${adb_target[@]}" install -r "$APK" 2>&1)" || true
echo "$install_out"
if ! grep -q "Success" <<<"$install_out"; then
  echo "==> Reinstall failed (likely signature mismatch); uninstalling and retrying…"
  adb "${adb_target[@]}" uninstall "$APP_ID" >/dev/null 2>&1 || true
  adb "${adb_target[@]}" install "$APK"
fi

[ "$DO_LAUNCH" -eq 1 ] || { echo "Installed (not launched)."; exit 0; }

# --- launch --------------------------------------------------------------
echo "==> Launching $MAIN_ACTIVITY…"
adb "${adb_target[@]}" shell am start -n "$MAIN_ACTIVITY" >/dev/null
echo "==> Done. The app runs standalone (no Metro needed)."
