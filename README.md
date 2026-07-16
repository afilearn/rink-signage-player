# ArenaSignage Player v1.4.8

All files live flat in the repo root — upload every file on this level together
(no subfolders needed).

## Files
- `index.html` — the player (schedule + ad column + remote commands)
- `version.json` — player version marker
- `_headers` — Cloudflare Pages headers
- `logo.png` — fallback logo
- `lg-cordova.webos.js` — LG SCAP bridge (loaded lazily, only on LG SI panels)
- `lg-signage.js` — LG SCAP Signage API (captureScreen)
- `lg-power.js` — LG SCAP Power API (reboot, display on/off)

`player-inline.js` from older versions is no longer used and can be deleted.

## Changes in 1.4.4 → 1.4.6

### Screenshots with video ads (webm)
- **LG SI:** screenshots now use LG's SCAP `Signage.captureScreen` first — a
  compositor-level capture that includes the hardware video plane. webOS
  Chrome cannot draw video frames to canvas (always black), so this is the
  only way to capture a playing webm on LG. If SCAP is unavailable the player
  falls back to the previous html2canvas + proof-of-play path and logs a
  `screenshot_scap` player error with the reason.
- **Android:** when a video ad is on screen the player prefers DOM capture and
  composites a decoded frame of the current video (PixelCopy cannot see the
  hole-punched video surface — it captures black). The frame is fetched
  through the Cloudflare media proxy as a Blob to avoid WebView canvas-taint
  bugs. Image ads still use native PixelCopy. `dom` capture type on a video
  screenshot is expected and correct.
- Frame-decode failures are reported as `screenshot_video_frame` player
  errors, visible in the platform admin under the screen's Recent player
  errors.

### Unchanged
Live playback, layout, ticker, NativePlayer bridge, reload commands, Worker,
dashboard, and Supabase are untouched.

## 1.4.7
- When the Android APK reports `screenshot_video` (APK 1.5.1+), video-ad
  screenshots use native PixelCopy with the video surface composited in —
  full quality, exact on-screen frame. Older APKs keep the DOM fallback.

## 1.4.8 — LG power control
- New remote commands on LG SI panels: `reboot`, `display_power` (backlight
  on/off), and `set_power_schedule` (weekly on/off times, panel-local time).
- Scheduled on/off is executed by the player via SCAP `setDisplayMode` —
  LG's native on-timers would wake the panel into an HDMI input instead of
  the SI app. Screen-off keeps webOS and the player running, so heartbeats
  and remote control keep working while the backlight is off.
- New file `lg-power.js` (SCAP Power API) — upload it with the others.
- Screenshot capture paths are untouched.
