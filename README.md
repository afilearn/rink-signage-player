# ArenaSignage Player v1.4.14

All files live flat in the repo root — upload every file below together
(no subfolders). After Cloudflare Pages finishes deploying, verify by opening
https://post-signage.pages.dev/version.json — it must say 1.4.14 — then press
Reload on each screen in the dashboard and confirm the Player card shows
v1.4.14 before testing anything else.

## Files
- `index.html` — the player (schedule, ads, remote commands, power control)
- `version.json` — player version marker (use it to verify the deploy)
- `_headers` — Cloudflare Pages headers
- `logo.png` — fallback logo
- `lg-cordova.webos.js` — LG luna-bus bridge (loaded lazily, LG SI only)
- `lg-signage.js` — LG SCAP Signage API (captureScreen)
- `lg-power.js` — LG SCAP Power API (kept for timer APIs; power calls now go
  direct to the luna bus)

`player-inline.js` from older versions is unused and can be deleted.

## Remote commands by platform
| Command | Android (APK 1.5.1+) | LG SI | Browser |
|---|---|---|---|
| Reload | yes | yes | yes |
| Screenshot (webp + webm) | yes — native PixelCopy incl. video | yes — SCAP captureScreen | yes — DOM + frame composite |
| Restart app | yes | — | — |
| Screen on / off | — | yes (tvpower) | — |
| Power schedule | — | yes (player-local, panel time) | — |
| Power cycle | — | yes (soft: off → on → reload) | — |

## Version history

### 1.4.14 — LG power, final
- "Reboot panel" is now a **soft power cycle**: backlight off → on → full
  player reload. True OS reboot is blocked for URL-mode (SI Server URL) apps
  on LG signage firmware — every power service (tvpower/reboot,
  machineReboot) accepts the call and then powers the panel down without
  restarting. Verified on 49UM5N via the power_reboot_attempt log trail.
  A true reboot requires an installed IPK app (future milestone).
- Every failure path in the power cycle still forces a player reload, so the
  screen can never be left dark by this command.

### 1.4.10 – 1.4.13 — LG power plumbing
- Power operations call the luna bus directly with candidate chains
  (modern `com.webos.service.tvpower` first) instead of the SCAP power
  library, whose hardcoded `com.webos.service.tv.signage` no longer exists
  on webOS 3.0+ signage firmware.
- Screen on/off confirmed working via tvpower turnOnScreen/turnOffScreen;
  the handling service is recorded in each command's ack (`via`).
- Weekly on/off schedule runs inside the player (panel-local time, checked
  every 30s) using the backlight — LG's native on-timers would wake the
  panel into an HDMI input instead of the SI app. Screen-off keeps webOS and
  the player running, so heartbeats and remote control continue.
- Boot-time best effort: `powerOnStatus=power_on` and `wolEnable=1` written
  via the storage service so panels boot straight into the player after
  power loss.
- Reboot attempts are logged to player_errors before each luna call fires.

### 1.4.8 – 1.4.9 — power commands + browser screenshot fix
- New LG commands: `reboot` (now soft cycle), `display_power`,
  `set_power_schedule`; capabilities advertised to the dashboards.
- Image-ad screenshots fetch the image as a Blob through the media proxy —
  fixes Chrome's cached-non-CORS-image failure that silently drew the
  proof-of-play card. Failures now log `screenshot_image`.

### 1.4.4 – 1.4.7 — screenshots with video ads
- LG SI: SCAP `Signage.captureScreen` (compositor capture incl. video plane),
  html2canvas fallback, `screenshot_scap` errors on failure.
- Android: DOM capture with a decoded video frame on older APKs; APK 1.5.1+
  advertises `screenshot_video` and uses native PixelCopy with the ExoPlayer
  surface composited in (`pixelcopy_window_video`).
- All frame-decode failures log `screenshot_video_frame` with the reason.

### Unchanged throughout
Live playback, layout, ticker, NativePlayer bridge, Worker, dashboard, and
Supabase schema (beyond the documented command types) are untouched.
