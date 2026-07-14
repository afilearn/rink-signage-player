# ArenaSignage Player v1.3.8

Player-only deployment for Cloudflare Pages.

Changes from v1.3.7:
- Uses the Android PixelCopy bridge exposed as either `AndroidBridge` or `PostSignageNative`.
- Reads the APK-injected `__POSTSIGNAGE_NATIVE__` capability object instead of depending only on `typeof` checks that fail on some older Android WebView versions.
- Tries `captureScreenDataUrl()`, `captureScreenBase64()`, and legacy `captureScreen()` methods.
- Retries briefly when a screenshot command arrives before the native bridge-ready event.
- Reports `screenshot_native`, `screenshot_method`, and native app version in device status.
- Keeps the v1.3.7 DOM/browser screenshot fixes and proof-of-play fallback.

Deploy `index.html`, `logo.png`, `_headers`, `version.json`, and this README at the repository root.
