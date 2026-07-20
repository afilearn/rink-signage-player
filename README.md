# ArenaSignage Player v1.5.10

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

### 1.5.0 — ad engine: fullscreen, dayparting, house slots, portrait
- Campaign placement: side rail or fullscreen. Fullscreen ads form their own
  weighted rotation automatically from targeting + weight.
- Per-screen ad layout (set in admin → Devices → Ad layout):
  off = schedule + side ads; interval = fullscreen takeover every N minutes
  (counted from the end of the previous takeover, never cuts a side ad off
  mid-play, GPU-composited slide in/out); always = fullscreen ad board.
- Dayparting (time-of-day window, overnight wrap supported) and day-of-week
  targeting, evaluated in panel-local time and re-checked continuously.
- House ads play only when no paid ad is eligible for the same slot.
- Fullscreen video audio is a per-screen toggle (browser/LG; Android native
  volume follows the device).
- Orientation per screen: auto-detect (portrait viewports already stack the
  layout), or force portrait/landscape for panels whose viewport does not
  match their mounting.
- Takeovers reuse the existing playback engine — LG decoder handling,
  NativePlayer bridge, crossfade, screenshots, and proof-of-play all apply
  unchanged. Requires Worker 1.3.7.

### 1.5.2 — offline resilience
- New file `sw.js` (service worker) — upload it with the rest; `_headers` now
  serves it no-cache so SW updates roll out immediately.
- Ad media is cached on-device (cache-first — safe because media URLs are
  immutable; new campaign = new URL = fresh download). Max 40 items, oldest
  evicted, and anything no longer scheduled is pruned automatically.
- Schedule/ads JSON stays strictly network-first: updates propagate exactly
  as fast as before; the cached copy is served ONLY when the network is down.
- During an outage the screen keeps playing the last-known schedule and all
  cached ads. The player tracks the outage window and, on reconnect, reports
  "was offline from/to, played from cache" in its device status.
- Proof-of-play during an outage is queued locally with real timestamps and
  flushed on reconnect (requires Worker 1.3.8, which dedupes by the original
  play minute). Plays older than ~47h are dropped rather than backdated.

### 1.5.3 — facility slides + transitions
- New per-screen content mode: Schedule (default) or Slides. In Slides mode
  the left zone plays the facility's own image playlist (webp/jpg/png,
  per-slide duration) full-bleed; header hidden, ticker and the ad rail
  unchanged, admin takeovers unchanged. Never active in combined mode.
- Slides are images only by design — one hardware video pipeline per panel
  is reserved for the ad rail and takeovers.
- Selectable transition (fade / slide / zoom / none, GPU-only) applied to
  the fullscreen-only ad board and the slide zone. Set per screen.
- Slide media is cached by the service worker for offline playback.
  Requires Worker 1.3.9.

### 1.5.4 — transition + orientation fixes
- Fade is a real animation now and transitions apply to image ads in
  fullscreen modes (previously only videos got the class, and fade merely
  re-timed the existing crossfade — visually a no-op).
- Note: the per-screen Orientation setting affects split layouts only
  (schedule + ads, slides + ads). In Fullscreen-only mode ads fill the
  viewport regardless — rotate vertically-mounted panels at the panel level
  (LG OSD Rotation / Android display settings).

### 1.5.5 — CSS portrait for fullscreen-only
- Orientation = Portrait in Fullscreen-only mode now rotates the ad output
  90° in CSS — no panel hardware rotation needed. LG and browser rotate
  everything; Android boxes serve image ads only when rotated (the native
  video surface cannot be CSS-rotated).

### 1.5.6 — native rotation handshake
- With Android APK 1.5.2+, rotated fullscreen-only screens play webm too:
  the player calls NativePlayer.setRotation(90) and the app renders video
  through a rotatable TextureView. Older APKs keep the image-only filter.

### 1.5.7 — branded loading screen
- Animated branding while the first payload loads: drop `branding.gif` or
  `branding.webp` into the repo root (checked in that order; falls back to
  logo.png with a gentle pulse if neither exists). Cached by the service
  worker so it also shows on offline boots. Hides on first render, on the
  pairing screen, and after a 25s failsafe — it can never stick.

### 1.5.9 — softer fullscreen ad animations
- Fullscreen takeover slide in/out slowed from 0.45s to 0.9s with a
  gentler ease; JS exit timeout matched so the schedule never snaps
  back mid-animation.
- Per-ad transitions in fullscreen modes (fade/slide/zoom) slowed from
  0.6–0.7s to 1.2–1.4s with softer easing. All animations remain
  GPU-only (opacity/transform) for LG panel smoothness.

### 1.5.10 — browser fullscreen screenshot fix
- Desktop Chrome DOM screenshots assumed the 70/30 schedule/ad split even
  in fullscreen ad modes, compositing the ad as a narrow side column.
  screenshotAdRect now returns the full canvas when fs-only or
  fs-takeover is active. LG (SCAP) and Android (PixelCopy) were already
  correct and are unchanged.
