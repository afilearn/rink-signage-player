# ArenaSignage Player v1.3.4

Deploy these files together at the root of the Cloudflare Pages player project:

- `index.html`
- `logo.png`
- `_headers`
- `version.json`

Open a screen with `https://post-signage.pages.dev/?code=SCREEN_CODE&v=134`.

The no-cache headers and version manifest are important for Android WebView devices.


## v1.3.5

- Fixed duplicated and mispositioned advertisements in browser DOM screenshots.
- The screenshot renderer now blanks the cloned ad media and composites the active ad exactly once.
- Added fixed viewport coordinates to keep browser captures aligned.
