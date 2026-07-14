# ArenaSignage Player v1.3.9

This player adds a robust native PixelCopy bridge path for the Android APK. It recognizes the injected native capture wrapper, validates the returned JPEG before upload, and falls back to DOM capture only when the native bridge is unavailable.

Expected Android status after the v1.3.9 APK is installed:

- `native_app_version: 1.3.9`
- `screenshot_native: true`
- `screenshot_method: pixelcopy_window`
- screenshot capture type: `native`
