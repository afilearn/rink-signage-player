# Live TV on LG webOS Signage — constraints & decisions

Hard-won field knowledge from the 49UM5N-EP (webOS 6.0, Chrome 79 engine).
Read this before touching the ad engine or TV-zone code.

## The one rule that explains everything

**Planes are free. Decoders are not.**

| Source              | What it costs the panel                  |
|---------------------|------------------------------------------|
| HDMI external input | Hardware *plane* (pass-through, no decode) |
| webm ad             | Hardware *decoder* pipeline               |
| YouTube embed       | Hardware *decoder* pipeline (VP9/H264 in the iframe) |
| webp / image ad     | Nothing (GPU texture only)                |

LG's spec sheet says 4 concurrent video tags. In practice on the UM5N,
**one decoder is reliable**. Two active decoders — or even one active +
one loaded-but-idle — destabilizes the media stack; webOS then relaunches
the whole SI app (looks like the player "crashing/rebooting").

## What therefore works and doesn't

- HDMI TV + webm ads: **works** — TV is a plane, the webm is the only
  decoder. Requires strict sequencing (see below).
- HDMI TV + webp ads: works.
- YouTube TV + webp ads: works.
- YouTube TV + any ads: **product rule (1.5.30): the stream is an
  exclusive mode** — always fullscreen, zero side ads, zero takeovers,
  on every platform. This defines away the LG decoder conflict (the
  stream is the only media pipeline) and keeps the feature meaning one
  thing everywhere. The structural webm gates remain underneath as
  defense in depth. For "stream + ads" needs, use the streaming-stick
  → HDMI setup below.

## Rules encoded in the player (do not regress)

1. **Strict one-decoder sequencing on lg_si** (1.5.24): fade out → pause
   → fully release (`removeAttribute('src')` + `load()`) the old webm
   BEFORE loading the next. Never preload the hidden buffer on LG.
2. **Plane overhang** (1.5.20): hardware planes don't crop like
   `object-fit:cover`; media wider than its element bleeds outside it.
   While `tv-hdmi` is active, ads render `contain`. Standardize side
   creatives at 576×1080 to avoid letterboxing.
3. **External-input elements lie** (1.5.16): `paused`/`stalled`/`waiting`
   are meaningless on `ext://hdmi` video tags. Only a real `video.error`
   object justifies rebuilding the element (rebuilds blank the plane ~1s).
4. **Never re-assign `.muted` with an unchanged value** on webOS — the
   property write touches the native audio pipeline.
5. **The `texture` attribute is a trap** on UM5N firmware 03.72.30: it
   blanked the HDMI plane for ~1 minute at a time (tried 1.5.18,
   reverted 1.5.19).
6. **Override transitions are debounced** (1.5.29): a single stale/failed
   poll must never tear the stream down or re-admit webm; the override
   drops only after two consecutive payloads without it. Gate resets fire
   on the *transition* into YT mode only, never per-poll (the 1.5.26→28
   lesson: a per-poll reset restarts the rotation at index 0 forever).

## Production recommendations (LG screens)

- **Wire the panel.** The Saputo panel runs Wi-Fi at ~190ms RTT; stale
  poll fallbacks are what caused stream flapping. Ethernet removes the
  whole failure class.
- **Future is webm ads + streams?** Two clean options:
  1. **Streaming stick → HDMI** (Chromecast/Fire TV playing the stream).
     The stream becomes an external-input *plane*, webm ads keep their
     decoder, everything coexists — this is the robust answer, ~$40/screen.
  2. **Animated webp creatives** for campaigns that must run during
     browser-based streams: comparable size to webm, animated, plays in
     an `<img>`, costs zero decoders.
- SCAP screenshots can never capture the HDMI plane (LG excludes external
  inputs from capture) — the player stamps an "HDMI N live" card instead.
  YouTube zones stamp a placeholder for the same reason (cross-origin).
