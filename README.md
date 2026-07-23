# ArenaSignage Player v1.6.12

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

### 1.5.11 — live TV left zone (USB HDMI capture, browser platforms)
- New content mode `livetv`: the left zone shows a USB HDMI capture
  device via getUserMedia. Prefers a video input whose label looks like
  a capture dongle over any built-in webcam; retries every 15s on
  failure or unplug, with a "Waiting for TV signal" card.
- Fullscreen TV (`livetv_fullscreen`): TV owns the whole viewport, side
  ads never run, fullscreen ads still interrupt as interval takeovers.
  TV is auto-muted during takeovers; `livetv_audio` controls TV sound
  otherwise.
- Windows Chrome kiosk must launch with
  --auto-accept-camera-and-microphone-capture so the camera permission
  prompt never appears.
- Platforms without a UVC camera bridge (LG SI, current Android APK)
  report `livetv_unsupported` once and keep showing the schedule.
- Browser DOM screenshots composite the live TV frame into the correct
  zone (capture streams never taint the canvas).
- Requires Worker v1.3.10 + database/livetv_capture_v1_6.sql.

### 1.5.12 — mode conflict guard for live TV
- "Fullscreen ads only" mode now fully disables live TV (stream stopped,
  audio off) instead of leaving the capture running under the ad board.

### 1.5.13 — TV audio continues under silent takeovers
- During a fullscreen ad takeover the TV now mutes only when the ad's
  own audio is enabled (fullscreen_audio). Silent ads play over
  continuing TV sound; audible ads duck the TV and it resumes after.

### 1.5.14 — YouTube live-stream override for the TV zone
- While livetv_yt_url is set (and livetv_yt_until has not passed), the
  TV zone shows a YouTube embed instead of the USB capture; the capture
  stream is released and re-acquired on switch-back. Expiry flips back
  within one second via a local timer; manual stop applies on the next
  content poll.
- Same audio rules as capture: muted unless TV audio is on; ducks under
  takeovers only when the ad's own audio is enabled.
- Kiosk Chrome needs --autoplay-policy=no-user-gesture-required for the
  embed to start with sound.
- Browser screenshots draw a "YouTube live stream" placeholder card —
  cross-origin iframes cannot be captured.
- Requires Worker v1.3.11 + database/livetv_youtube_override_v1_6.sql.

### 1.5.15 — live TV on LG panels via external HDMI input
- On lg_si the live TV zone plays the panel's own HDMI port through the
  webOS external-input video tag (ext://hdmi:N, service/webos-external) —
  no capture dongle. Per-screen livetv_hdmi_input selects HDMI 1-4.
- Gentle watchdog retries play() every 5s and recreates the element only
  after a problem persists 12s (cable pulled), matching the verified
  on-panel test behavior.
- Same audio rules: muted unless TV audio is on; ducks under takeovers
  only when the ad's own audio is enabled.
- SCAP captures exclude the HDMI hardware plane, so screenshots stamp an
  "HDMI N live" card over the TV region instead of showing black.
- YouTube overrides also run on LG (browser engine) and take priority
  over the HDMI input while active.
- Requires Worker v1.3.12 + database/livetv_lg_hdmi_v1_6.sql.

### 1.5.16 — fix periodic black flash on LG HDMI live TV
- webos-external video elements report soft states (stalled/waiting,
  paused) that do not reflect the actual picture, sending the watchdog
  into a rebuild loop that blanked the HDMI plane for ~1s every cycle.
  The watchdog now acts only on a hard error object, and .muted is never
  reassigned with an unchanged value.

### 1.5.17 — fix white-strip plane bleed next to LG HDMI live TV
- With HDMI live TV active, a paused side-ad webm still held a hardware
  video plane; HDMI + active ad + paused ad = 3 planes, overflowing the
  49UM5N compositor so the spare plane bled a strip into the TV zone
  (visible on light-background ads). On lg_si with HDMI TV active, the
  outgoing ad now fully releases its media (src removed + load()) after
  each swap. Also replaced unsupported `inset:0` with explicit top/left
  on the ad-column video elements and ad image.

### 1.5.18 — texture-mode ads while LG HDMI TV is live
- While tv-hdmi is active on lg_si, the side-ad <video> elements get the
  webOS `texture` attribute (Signage 4.1+): they render in the GPU
  compositor instead of claiming hardware video planes, so they can
  never collide with the HDMI plane. Removed automatically when live TV
  is off — every other path keeps hardware-plane playback. Combined with
  the 1.5.17 plane release, this is the documented fix for the white
  strip artifact.

### 1.5.19 — revert texture-mode ads
- The `texture` attribute destabilized the UM5N media pipeline (HDMI TV
  plane blanked for ~1 minute at a time). Reverted; behavior is now
  identical to 1.5.17 (plane release on swap + explicit positioning),
  which is the state to evaluate against the white-strip artifact.

### 1.5.20 — plane overhang fix + faster HDMI attach
- Side ads wider than the 576px column overhung their element on the
  hardware plane (cover-crop is a browser concept; planes map the full
  frame), bleeding a strip over the HDMI TV picture. While tv-hdmi is
  active, ads render object-fit:contain so the plane never exceeds its
  rect. Ads sized exactly 576x1080 render identically to before.
- Restored the gentle 5s play() retry for the HDMI element (removed in
  1.5.16 alongside the rebuild loop, but the nudge itself was harmless)
  and added pipeline-event-driven play() starts — cuts the 15s+ TV
  attach delay after a reload.

### 1.5.22 — image takeovers never duck live TV audio
- Based on 1.5.20 (the 1.5.21 instant-boot experiment is not included).
- TV ducking during a fullscreen takeover now requires the active
  takeover item to be a VIDEO with fullscreen audio enabled. Static
  image takeovers (webp/jpg/png) make no sound and no longer mute the
  live TV. Applies to USB capture, LG HDMI, and YouTube sources alike.

### 1.5.23 — sequential fade between side ads
- Every side-ad transition now fades: the outgoing ad (webm or webp)
  fades to black over 0.4s, then the incoming one fades in over 0.4s —
  all four combos covered. Image ads use the same opacity/class
  mechanics as videos (previously display:none hard cuts).
- Opacity-only transitions (GPU-composited) for smoothness on LG SI,
  Windows Chrome kiosk, and the Android WebView.
- The outgoing webm keeps playing through its fade-out; pause — and the
  LG+HDMI hardware-plane release from 1.5.17 — happen only after the
  fade completes, so LG panels fade instead of flashing.
- Android note: native webm playback renders above the WebView, so a
  fading image + appearing native video is a fade-out/cut; a true
  native fade-in needs a future APK bridge addition.

### 1.5.24 — LG strict one-decoder fade sequencing (fixes SI crash loop)
- 1.5.23's fade kept the outgoing webm decoding while the incoming webm
  also decoded — two ad pipelines beside the HDMI plane crashed the
  webOS 6.0 media stack and the OS relaunched the SI app in a loop.
- On lg_si, ad transitions now sequence strictly: fade out, pause, fully
  release the old ad's media, THEN load and fade in the next. Hidden-
  buffer preloads are disabled on LG entirely (an idle loaded webm
  pipeline destabilizes webOS beside the HDMI plane). A brief black beat
  in the ad column between fades is covered by the fade-in.
- Windows Chrome and Android WebView keep the 1.5.23 overlapped fade.

### 1.5.25 — video ads sit out during YouTube overrides on LG
- A YouTube override decodes through the same webOS media stack; a webm
  ad starting beside it crashed the media pipeline and relaunched the
  SI app on every video ad. (HDMI is an external-input plane, not a
  decoder, which is why webm ads coexist with it under 1.5.24's strict
  sequencing.)
- On lg_si while tv-yt is active, both ad pools (side and fullscreen)
  exclude video ads: images keep rotating, videos resume automatically
  when the override ends or expires. Other platforms unaffected.

### 1.5.26 — hard gates: webm can never start beside a YouTube stream on LG
- Defense in depth on top of 1.5.25's pool filter. Three independent
  gates: (1) playCurrentAd refuses to start any non-image ad while
  tv-yt is active on lg_si and rebuilds the rotation image-only on the
  spot; (2) activating a YouTube override on LG silences all ad media
  and forces a filtered rotation rebuild before the stream claims the
  decoder; (3) beginTakeover skips a cycle if its chosen item is a
  video during an active override. A webm structurally cannot reach the
  decoder while YouTube runs, regardless of stale lists, queued
  takeovers, or timing races.

### 1.5.27 — image-ad load failures retry and report
- 1.5.23's image fade skipped a failed image silently, which made load
  failures look like ads "not playing" with no trace. A failed image now
  retries once directly from storage (bypassing the media proxy), and if
  it still fails, reports ad_image_load to player_errors with the
  campaign, URL, and whether a YouTube override was active — then skips.

### 1.5.28 — fix rotation restart loop during YouTube overrides (LG)
- 1.5.26's override-activation gate ran on EVERY content poll while the
  stream was active, silencing ad media and rebuilding the rotation from
  index 0 each cycle — only the first ad ever completed, and the others
  appeared "skipped" (killed mid-display by the next poll). The gate now
  fires only on the transition into YouTube mode (tv-yt not yet set).
  The other two gates (playCurrentAd hard gate, takeover item check) are
  unchanged and keep webm structurally off the decoder during streams.

### 1.5.29 — override flap guard + LG live TV documentation
- On marginal networks a failed poll served a stale cached payload with
  no YouTube fields, tearing the stream down for one cycle and — worse —
  deactivating the webm filter mid-stream (black webm slots, decoder
  stress), then rebuilding the stream on the next good poll. The
  override now drops only after TWO consecutive payloads without it;
  expiry timestamps still end it exactly on time.
- Added LIVETV-LG-NOTES.md: the plane-vs-decoder model, all encoded LG
  rules, and production recommendations (ethernet; streaming stick into
  HDMI as the robust "stream + webm ads" setup; animated webp as the
  zero-decoder ad format during browser streams).

### 1.5.30 — YouTube stream is an exclusive fullscreen mode
- Product rule, all platforms: while a YouTube override is active the
  stream plays fullscreen with ZERO ads — no side rotation, no
  takeovers. Ads resume automatically the moment the override ends or
  expires. This defines away the LG one-decoder conflict entirely (the
  stream is the only media pipeline on the panel) and makes the feature
  behave identically everywhere. The webm hard gates remain underneath
  as defense in depth.

### 1.5.31 — branded splash minimum display time
- The boot splash (branding.gif) now holds for at least 4 seconds from
  the moment the branding image appears, instead of flashing for a
  sub-second on fast loads. Content renders underneath and the splash
  lifts on schedule with its existing fade. The 25s failsafe bypasses
  the minimum. Adjust via BOOT_SPLASH_MIN_MS.

### 1.5.32 — power schedule enforces state, not just moments
- The schedule was edge-triggered: it only acted in the exact on/off
  minute, so anything that woke the panel mid-dark-window (app reloads
  from player updates, panel reboots, power blips) left the screen on
  until the next boundary. Enforcement is now level-triggered: the
  player computes the desired state (lit between on_time and off_time
  on scheduled days, overnight wrap supported) every 30s AND ~20s after
  every boot, correcting drift within half a minute. One attempt and
  one error report per state change; unscheduled days stay hands-off.
- Note: on scheduled days the schedule is authoritative — a screen
  manually woken with the remote during the dark window turns back off
  within 30s. Clear or adjust the schedule for special hours.

### 1.6.0 — custom canvas layouts (Phase 1)
- New zone renderer: when a screen has a custom layout assigned (admin
  Layouts tab), the player renders its zones — Schedule (the preset
  stack transform-scaled into the rect, GPU-only), Media (per-zone
  webm/webp/image rotation with fades; on LG only the first media zone
  decodes video), Live TV (HDMI on LG / USB capture on Windows,
  rect-positioned), Ticker (repositioned). Zones use percentage rects
  from a reusable named layout.
- Preset mode is byte-identical when no layout is assigned: the new
  #preset-stage wrapper carries no styles by default, and every custom
  code path is gated on the payload's custom_layout. The preset ad
  engine, takeovers, slides, and YouTube overrides pause while a custom
  layout is active and resume instantly when unassigned (ad zones ship
  in Phase 2).
- Requires Worker v1.3.13 + admin v1.6.0 + database/screen_layouts_v1_7.sql.

### 1.6.1 — media zones accept mp4
- Zone playlists detect .webm/.mp4/.m4v as video; every other URL is
  tried as an image, so extensionless direct image links (e.g. CDN URLs)
  work. Videos still need a real file extension in the URL.

### 1.6.2 — layouts Phase 2: ad-campaign zones
- New "Ad campaigns" zone type: the full side-ad engine — eligibility,
  weights, dayparting, house fillers, sequential fades, proof-of-play —
  runs confined to the zone rect. One per layout; takeovers remain off
  in custom layouts.
- LG decoder arbitration: with an ads zone present, all media zones on
  lg_si render images only (the ad engine owns the hardware decoder);
  without one, the first media zone may decode video as before.
- Browser screenshots composite ads at the zone rect in custom mode.
- Admin: media zones gain a storage library with in-place Upload and
  Browse/Add (URLs still accepted); preset controls and the YouTube
  override now hide entirely while a custom layout is assigned.

### 1.6.3 — ticker zone settings
- Ticker zones carry per-zone settings: text size (0.5-2x, scales the
  4vh base), speed (slow 0.6x / normal / fast 1.7x of the px-per-second
  scroll rate), and optional override text that replaces the screen's
  own ticker while the zone is active. With no override, the zone shows
  the screen's ticker text and time-scheduled Announcements as before.
- Admin: the Layout select in the Ad layout card is now staged — picking
  Preset or a custom layout applies nothing until Save layout, so preset
  settings can be adjusted before committing the switch.

### 1.6.4 — ticker zone positioning fix; content owned by the facility
- Base #ticker is statically positioned; the zone rect was ignored and
  the bar rendered at the top of the page over the header. Ticker zones
  now pin position:fixed inline (cleared on leave/preset).
- Removed the zone override-text path: ticker content has one owner —
  the facility's Live ticker default message + scheduled Announcements.
  Zones control placement, text size, and speed only, and stay hidden
  while there is no message to show.

### 1.6.5 — YouTube zones, soft power everywhere, ticker in screenshots
- New "YouTube" zone type for custom layouts on Windows/Android: a
  rect-positioned live-stream embed with optional audio, coexisting
  with ad and media zones (those platforms decode multiple streams).
  LG panels skip the zone entirely — one decoder; the fullscreen stream
  override remains the LG path. Continuous streams use ~3-5 Mbps.
- Soft power on Windows/Android: display on/off commands and the power
  schedule now work on every platform. Non-LG screens sleep under a
  pure-black overlay with ALL media pipelines stopped (ads, zones, TV,
  streams); polling, heartbeats and remote commands keep running, and
  waking rebuilds everything. Same level-triggered schedule enforcement
  as LG, including boot-time correction.
- Browser screenshots now draw the ticker bar and its current text
  (CSS-animated content is invisible to DOM capture), using the theme's
  ticker colors, in both preset and custom-layout positions.

### 1.6.6 — fix off-platform Cordova alert; schedule visible in dialogs
- 1.6.5's schedule handler loaded the LG Cordova/SCAP library on every
  platform; on Windows/Android it alerted "PalmSystem is not defined",
  and the blocking dialog froze polling so screens showed offline while
  content kept playing. The library now loads on lg_si only.
- The device report includes power_schedule_state, so the Power schedule
  dialog (admin and arena dashboard) opens prefilled with the screen's
  active schedule and shows a status line; Clear schedule removes it and
  the status clears on the next report.

### 1.6.7 — pairing screen redesign (split panel)
- New pairing layout: giant code on the left over an optional
  pairing-bg.jpg (repo root — drop in any image; a dark overlay fades it
  to #121212 at the divider, and the screen degrades to a clean flat
  split if the file is absent), numbered steps rail on the right, pulsing
  "Waiting for pairing" dot, arenasignage wordmark bottom-right. Fixes
  the logo/title overlap. Portrait stacks the panels vertically.
  Chrome 79-safe: flex + explicit offsets, opacity-only animation.

### 1.6.8 — pairing screen sizing fix + brand logo
- The split pairing screen relied on flex:1 and collapsed to content
  height in some load paths (everything squished to the top third).
  It now owns the viewport explicitly (100vw x 100vh).
- The bottom-right mark is the real logo.png (new Arena Signage brand
  logo shipped in this build); the styled text wordmark renders only if
  the file is missing.

### 1.6.9 — preset ticker pinned to the bottom
- The preset ticker had no position property and sat at the bottom only
  by document flow; the 1.6.0 preset-stage wrapper changed that flow and
  the bar floated up beneath the schedule content. The base ticker is
  now position:fixed at left 0 / bottom 0 / 100vw, which also activates
  the existing portrait (bottom:30vh above bottom ads) and forced-
  orientation rules as originally written. Custom ticker zones are
  unaffected — their inline rect overrides the base.

### 1.6.10 — preset YouTube streaming returns on Windows/Android
- The YouTube override on preset screens is exclusive-fullscreen only on
  LG SI (single-decoder rule). On browser (Windows Chrome) and Android
  the stream now plays in the live-TV zone like before 1.5.30: side ads
  keep rotating (video ads included), takeovers run (stream audio ducks
  under video takeovers via the existing arbitration), and fullscreen
  follows the screen's live-TV fullscreen toggle instead of being
  forced. LG behavior is unchanged.

### 1.6.11 — YouTube hover chrome suppressed
- The YT iframe now has pointer-events:none: focus bouncing through the
  Android WebView when a native webm ad starts was read as a hover and
  painted the video title bar over the stream. The player controls
  YouTube exclusively via the JS API, so the iframe needs no input.

### 1.6.12 — Android stream smoothness
- Reverted 1.6.11's pointer-events change on the YouTube iframe.
- Root cause of the choppy stream + periodic title chrome on Android:
  the stick cannot decode a YouTube stream and a webm ad concurrently;
  every stutter recovery makes YouTube repaint its title bar. Android
  now takes the same medicine as LG during a stream: video ads (side and
  takeover pools) sit out, image/webp ads keep rotating, videos resume
  when the stream ends. Windows Chrome behavior is unchanged.
