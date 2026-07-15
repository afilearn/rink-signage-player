# ArenaSignage Player v1.4.6

All files live flat in the repo root — upload every file on this level together
(no subfolders needed).

## Files
- `index.html` — the player (schedule + ad column + remote commands)
- `version.json` — player version marker
- `_headers` — Cloudflare Pages headers
- `logo.png` — fallback logo
- `lg-cordova.webos.js` — LG SCAP bridge (loaded lazily, only on LG SI panels)
- `lg-signage.js` — LG SCAP Signage API (captureScreen)

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
