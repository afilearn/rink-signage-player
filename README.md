# ArenaSignage Player v1.4.3

LG SI screenshot correction only.

- Image campaigns are fetched through the existing Cloudflare media proxy as a Blob and drawn into the right-side ad column.
- The active campaign is snapshotted before the live LG ad layer is hidden, preventing Chrome 79 from incorrectly selecting the proof-of-play fallback.
- LG hardware-video screenshots retain the proof-of-play panel when a frame cannot be captured.
- Android PixelCopy, Windows/browser screenshot capture, live playback, layout, reload commands, Worker, dashboard, and Supabase are unchanged.
