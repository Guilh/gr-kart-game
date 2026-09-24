# GR KART · Sakura Circuit — status and remaining work

Paused 2026-09-23 (second session). This file is the hand-off: what's built, what's verified, and what still needs building, checking and testing.

**Session 3 status (2026-09-24):** launch prep. Section 9 (thermal and performance) is done, section 7 hygiene is done except unit checks and git, and 10.1 (build, preview, smoke test) is done. Git: https://github.com/Guilh/gr-kart-game (public), connected to Vercel: every push to `main` deploys production (checked: the owner's force-push produced a Ready production deploy within a minute). Commit emails were rewritten to the GitHub no-reply `1447850+Guilh@users.noreply.github.com` (repo-local `user.email`); the GitHub API shows 0 commits with the old email. Caveat: the old commits (such as `47fae7c`) are still reachable on GitHub by direct SHA. Removing them means deleting and recreating the repo (then reconnecting Vercel) or asking GitHub Support. The license notices are live at `/third-party-licenses.md`. Open: the sound check and the GR-style logo decision.

**Session 2 status (2026-09-23):** sections 1 and 2 are done, and section 3 is done through item 6. Next is 3.7 (lap-1 pile-ups): the spin-location analysis is below, but no AI change has been made yet. At the end of the session `tsc`, `vite build` and `npm run sim:check` all pass.

## How to resume

Commands, project rules and git/deploy etiquette are in `AGENTS.md`; Claude-specific notes, including how to drive the game in the Browser pane, are in `CLAUDE.md`. This file tracks status and the backlog.

## Where things stand

Built, and seen working in the browser:
- Loading screen (about 2.4 s world build), attract-mode menu over a live AI race, race setup sheet.
- Full race loop: intro camera, 5-light start (HUD and gantry), racing, finish, results table, broadcast replay with director/TV/chase/helmet/heli cameras.
- HUD: standings tower with live gaps, lap/time/last/best, position, minimap, tachometer, G-meter, pedal bars.
- Procedural GR KART model built to the published dimensions, IK-rigged driver, showroom (mirror floor, hotspots, exploded view, dimension overlay, upright storage).
- Circuit, terrain, barriers, grandstand crowd, pit building, pond and torii, forest, Mt. Fuji, sky with clouds.

Verified in the headless harness:
- AI solo laps: Easy 50.8 s, Medium 47.3 s, Hard 44.8 s, with no spins and no off-tracks.
- 8-kart races over 6 seeds: 0 DNFs, 8–10 spins per race (mostly lap-1 incidents), rare marshal resets.
- Performance at 1280×760, High quality: 7–8 ms per frame including simulation, 1.7M triangles, about 670 draw calls.

Physics decisions worth keeping:
- The CG is rear-biased (58% rear). Rear cornering stiffness per unit load is kept about 20% above the front, which gives a positive understeer gradient. Breaking that relationship caused the early spins.
- Brakes act on the rear axle only. Torque is boosted about 20% above a realistic 215 cc engine, and 3.7 gearing gives roughly 87 km/h top speed.
- Player assists: anti-lock (brake capped at 85% of rear grip), stability control and counter-steer. The AI runs without assists.

## 1. In flight at pause (unverified)

- [x] `collapse()` in `src/kart/kartModel.ts` merges the wheel, axle and steering-wheel assemblies for race karts. It typechecks but hasn't been run. Check that wheels spin, the steering wheel turns, the sidewall decals still render, and the ghost kart still works. Re-measure draw calls; the baseline is about 670.
  - 2026-09-23: verified in the browser: wheels spin, the steering wheel and front wheels turn together, decals and bolts render, and the ghost is fine. Also folded the rear wheels into the axle group (`flatten()`) and split the multi-material brake disc inside `collapse()`. A kart went from 85 draw calls to 71 (collapse) to 64 (fold). The "about 670" baseline couldn't be reproduced, so there's a new method below.
- [x] Spatial chunking of the forest `InstancedMesh`es (about 180 m cells) in `src/track/scenery.ts`, and of the tire stacks in `src/track/trackBuilder.ts`, so frustum and shadow culling can skip chunks. Not started.
  - 2026-09-23: `chunkedInstances()` in `src/render/chunks.ts`. The forest uses 180 m cells (65 chunks). The tire stacks use 60 m cells (18 chunks), because the circuit only spans about two 180 m cells; the stacks' never-seen bottom cap is also dropped. Scenery only, averaged over 16 track views: triangles 538k → 426k main and 340k → 172k shadow; draw calls 90 → 133 main and 39 → 55 shadow. Frame time on this Mac didn't change measurably (3.3–3.5 ms scene plus shadows, synchronous readPixels timing), so the gain is for GPU-bound devices.

**Draw-call method (from 2026-09-23):** `renderer.info` with `autoReset` off, one `renderer.render(scene, camera)` with the shadow map forced (main plus shadow), then one with `shadowMap.autoUpdate` off (main only). The composer's post passes are not counted. Race grid, chase cam, High quality, 1280×760:

| Step | Draw calls (main + shadow) | Triangles |
|---|---|---|
| Before `collapse()` | 1,271 (549 + 722) | 1.83M |
| `collapse()` plus rear-wheel fold | 1,000 (454 + 546) | 1.83M |
| Plus chunking | 1,076 (503 + 573) | 1.25M |

The 8 karts (64 draw calls each, times two passes) are now about 90% of the draw calls on the grid.

## 2. Model and showroom changes made but not re-checked visually

- [x] Reshaped nose, fairing and sidepods, plus the higher loft resolution: view from several angles.
  - 2026-09-23: checked front, front ¾, side, rear ¾, rear and top. Clean and symmetric, with no seams or holes. One nit: the nose number reads soft and grey head-on (256 px texture plus env reflection at roughness 0.45).
- [x] Bumper stripe keyed to the section angle, the fairing crown band, and removal of the nose-tip stripe.
  - 2026-09-23: the rear-bumper band follows the surface cleanly, the crown band is crisp, and the nose has only its centre stripe.
- [x] Exploded view: the driver's arms should hold the driving pose (IK target fix).
  - 2026-09-23: confirmed; the hands hold the grip positions while the column flies off, and hotspots are hidden.
- [x] Upright storage: pivot, camera framing, contact shadow fade.
  - 2026-09-23: fixed the kart floating: it lifted up to 8 cm while tipping and sat 2.5 cm up when upright, because the pivot is empty space and there was a `+0.02` lift. `lowProfile()` now keeps the lowest point on the floor at every angle (within 2 mm). Framing and the contact shadow fade (to 0) are fine.
- [x] Hotspots are smaller and hidden during exploded view, dimensions and upright; the dimensions camera is closer.
  - 2026-09-23: hotspots hide correctly. At 1280×760 the HEIGHT label sat on the toolbar and the LENGTH label under the feature card. The camera is reframed to (2.05, 1.45, 2.05) looking at (0, 0.1, 0), found by a search with every label inside the free area, and the feature card now hides when dimensions turn on.
- [x] Driver-fit slider at 135 cm and 185 cm: arms reach the wheel, feet reach the pedals, no clipping.
  - 2026-09-23: feet were always fine, but hands left the grips once the wheel turned: 2–10 cm at 175 cm from 0.15 rad of steer, which affected races too, and up to 13 cm at 135 cm. The arms were short (0.56 m against about 0.63 m for a real adult). Now 0.31 + 0.30 m, plus the shoulder rolls up to 5 cm forward near full lock (`DriverModel.solve`). Result: 0 mm at 155–185 cm across the whole ±0.42 rad range; at 135 cm, 0 mm up to ±0.16 and 12 mm at the showroom's ±0.25 demo. Elbows now bend naturally. No knee or column clipping at 135 or 185.
- [x] Feature focus: highlight pulse, restoring materials on the next focus, and the automatic fit sweep for the pedals and steering features.
  - 2026-09-23: the pulse and the restore work. The sweep jumped 175 → 184 cm on the first frame and 185 → 175 at the end, and it always reset to 175. It now goes current → 135 → 185 → current with no jumps, and moving the slider cancels it.
- [x] Auto-rotate and fly-to tween fighting each other (the camera ended up in unexpected places once).
  - 2026-09-23: the real cause was that a feature clicked while upright (or mid-explode) aimed at the part's anchor at that moment, and the kart then moved away (target 1.17 m off). The camera now follows the focused part until the user grabs the controls (`follow`). Auto-rotate and damping were fine: leftover drag momentum leaves a 3 mm error, and no fly-to gets within 35 cm of the kart.

## 3. Known issues to fix

- [x] TV cameras beside the main straight shoot through the catch fence. Raise spots next to concrete walls (height plus about 4.5 m) or move them inside.
  - 2026-09-23: raycast check: 4 spots had 14–43% of their sight lines through the fence. Fenced-side spots now sit 1.2 m behind the wall at 6.2 m above the track (`trackBuilder.ts`), and every spot is 0–2% blocked. Raising by 4.5 m alone still left 21% blocked on spot 0.
- [x] The heli camera can clip through the grandstand roof and the pit building. Clamp its height or add a simple obstacle check.
  - 2026-09-23: `World.obstacles` holds boxes around the tall structures and is passed to `CameraRig`. The heli climbs 3 m at a time (8 steps at most) until the camera is outside every box and can see the kart, and skips the climb while the kart is under the gantry or bridge. Blocked samples went from 140 to 2 of 5,675.
- [x] Mt. Fuji may now be too big over the gantry. Consider about 850 m height. Check it at every time of day.
  - 2026-09-23: kept 1,000 m. At 850 m Fuji hides behind the gantry beam from the grid, and at 1,000 m it fills 14° of sky, close to real views (about 12° from Gotemba). The real problem was golden hour: bloom spread the low sun's halo and washed Fuji and the pit building out. The bloom input is now clamped to 3.0 (`renderer.ts`) and Fuji shows as a backlit silhouette. Possible follow-up: a true 'Diamond Fuji' needs the golden sun at about 14° elevation and 248.3° azimuth (it's at 6.5° and 250° now), but that currently whites out even with the clamp.
- [x] Results panel sits over the live HUD. Hide the dash, pedals and G-meter while results are showing.
  - 2026-09-23: added the `#hud.results-open` class (0.3 s fade). It's set in `showResults` and cleared on restart or quit.
- [x] Standings show "+0.0" before the first 10 m marker. Show "—" instead.
  - 2026-09-23: `Racer.gap` starts as NaN and the tower shows "—" until a gap is timed. Markers behind the line are now ignored: karts further back on the grid were the first to cross them, so they timed themselves against themselves and showed +0.0.
- [x] Attract "Live" label infers the camera from the FOV. Expose the rig mode properly.
  - 2026-09-23: added `RIG_LABELS` in `cameras.ts`, used by the label and the C-key camera message.

Items 3.7–3.10 moved to the post-launch backlog (session 3).

## 7. Engineering hygiene

- [x] Run `npm run build` (tsc plus the Vite production build); it hasn't been run yet. Then `npm run preview` and a smoke test.
  - 2026-09-23: `tsc` and `vite build` pass (built into a scratch folder: a 986 kB JS chunk, 269 kB gzipped, with Vite's chunk-size warning). `npm run preview` and the smoke test are not done yet.
  - 2026-09-24: done; see 10.1.
- [x] Turn the harnesses into a regression check (for example `npm run sim:check`) that fails on any DNF, on more than 14 spins per 8-kart race, or on lap times outside the per-difficulty bands above.
  - 2026-09-23: `scripts/simcheck.ts` (`npm run sim:check`) runs the existing harnesses in parallel. Solo bands are ±1 s around 50.8, 47.3 and 44.8. It also fails on a solo spin or off-track, and on a keyboard-with-assists spin, and prints the pack spin total against the recorded 55.
- [x] Ship third-party license notices (post-deploy review).
  - 2026-09-24: minification stripped three.js's `@license` header, and the fonts ship with no notice. `build.license` in `vite.config.ts` writes `dist/third-party-licenses.md` (three, MIT), and a small `font-licenses` plugin appends the two Fontsource OFL texts (build.license only sees JS modules). Credited in the README. Live since the owner's push to the Git-connected project.
- [ ] Small unit checks: track projection round-trip, racing-line limits, ghost encode/decode.
  - 2026-09-24: not in session 3's scope; still open.
- [x] Remove leftovers: unused `void` statements, the `lerp` re-export in `kartModel.ts`, the `DIM` re-export in `race.ts`, the unused `flags` array and `lastLapFlash`. Gate `window.app` behind `?debug`.
  - 2026-09-24: removed all of them, plus what only they kept alive: the `track`/`w` locals in `race.ts`, the `private` on Showroom's unused `renderer`/`canvas`, and the now-unused `DIM`/`clamp`/`lerp` imports. Kept `void card.offsetWidth` (a deliberate reflow). `src/core/debug.ts` exports `DEBUG` (`?debug`); `window.app` and `window.THREE` exist only with it. Also removed the 4 three.js "already non-indexed" warnings per load (`nonIndexed()` in `loft.ts`; identical output, since three returns `this`).
- [x] Keep or trim the build-timing `console.info` in `world.ts`.
  - 2026-09-24: kept, only with `?debug`.
- [x] Split three.js into its own chunk to clear Vite's chunk-size warning.
  - 2026-09-24: Vite 8 builds with Rolldown, where `manualChunks` is deprecated, so this uses `build.rolldownOptions.output.codeSplitting.groups`. One three chunk was still 797 kB, over the 500 kB warning, so it's split along three's own module boundary: `three-core` 377 kB (101 kB gzipped) and `three` (the WebGL renderer plus addons) 425 kB (105 kB gzipped). The app chunk is 193 kB (68 kB gzipped). No warning, and the old `chunkSizeWarningLimit: 2000`, which only hid it, is gone.
- [x] Meta description, Open Graph and Twitter tags, favicon, og:image.
  - 2026-09-24: `public/favicon.svg` (the old inline icon), `public/apple-touch-icon.png` (180 px), and `public/og-image.jpg` (1200×630, 107 kB: a chase-cam frame from the attract race with Fuji, rendered on High, with a title band). og:url and og:image need absolute URLs: `index.html` uses `__SITE_URL__`, filled at build time from `SITE_URL`, or on Vercel from `VERCEL_PROJECT_PRODUCTION_URL`; locally it's empty (relative URLs).
- [x] Keep the "fan-made, not affiliated with Toyota" footer visible.
  - 2026-09-24: unchanged in the menu footer. Also in the README and the meta description.
- [x] README: controls, architecture overview, URL flags, the fan-made/not-affiliated disclaimer, credits.
  - 2026-09-24: `README.md`; it also covers the graphics/battery options and the `npm` scripts.
- [x] The project isn't a git repo yet. `git init` and a first commit, if the owner wants that.
  - 2026-09-24: approved by the owner. `git init -b main`, first commit `47fae7c` (52 files; no `node_modules`, `dist` or `.DS_Store`). No GitHub remote yet; the owner doesn't have a repo. The Vercel CLI deploy doesn't need one.

## 9. Thermal and performance (session 3)

Goal: stop the game from running an M4 MacBook's fans hard.

- [x] Frame cap setting, default 60 fps.
  - 2026-09-24: `fpsCap` setting (30 / 60 / Off, default 60), in Settings as "Frame rate cap". The loop schedules against `nextFrame` instead of the last frame, so the average is right on 60, 120 and 144 Hz displays (measured 60 / 60 / 60). Dynamic resolution now reads the cap (`Renderer.targetFps`): it steps down above 1.2× the cap interval and steps back up at most every 4 s while frames hold the cap.
- [x] High quality renders at no more than 1.5× device pixel ratio; dynamic resolution handles the rest.
  - 2026-09-24: High and Medium are both capped at 1.5×. Dynamic resolution still runs only in Auto, unchanged. Also fixed: a quality change at runtime never resized the shadow map (Low kept 4096). It now follows the preset through `onQualityChange` (High 4096, Medium 2048, Low and Battery saver 1024).
- [x] No rendering while the tab is hidden (`document.hidden`); the menu's background race runs at 30 fps.
  - 2026-09-24: the loop returns early while `document.hidden` is true, and the menu caps at 30. The AudioContext is also suspended while hidden and resumed on return (`audio.setBackground`); before, the engines kept running with no picture.
- [x] "Battery saver" quality preset: 60 fps, 1× resolution, no MSAA, no bloom, 1024 shadows.
  - 2026-09-24: `quality: 'battery'`. It builds world geometry at the Medium tier and keeps the SpeedFX pass. Its 60 fps limit applies even with the cap Off.
- [x] Engine sound only for the nearest 4 karts.
  - 2026-09-24: `Race` owns a pool of 4 `EngineVoice`s, and `assignVoices()` gives them to the focused kart plus the nearest to the camera, with a 20% bias toward karts that already have a voice. A voice fades in at its new kart (`handover`). Bigger find: the worklet's `process()` always returned true and `dispose()` only disconnected, so every discarded voice kept running. Each race or attract restart added 8 more. The worklet now stops on a `'stop'` port message, checked in an OfflineAudioContext (peak 0.445 before, 0 after). Three races in a row keep 4 worklets alive; the old code would have left 32. Not listened to (see backlog 5).
- [x] Before/after measurements: frame time, rendered frames per second, draw calls.
  - 2026-09-24, in the Browser pane at 1280×760 with `devicePixelRatio` forced to 2 (M4 Retina). Rendered fps comes from driving `app.loop` with synthetic 120 Hz rAF timestamps (ProMotion). Frame time is sim plus world update plus the full composer render, synced with a 1 px `readPixels`, as the median of 60 race-grid frames in chase cam. The GPU clock drifts between runs, so the frame-time rows are same-session A/B over 3 rounds. Draw calls use the method in section 1.

| Config | Buffer | Frame time (ms) | Rendered fps: race / menu / hidden tab | Draw calls (main + shadow) |
|---|---|---|---|---|
| Before: High (2×, MSAA 4, bloom, 4096 shadows) | 2560×1520 | 20.1–21.7 | 120 / 120 / 120 | 1,168 (588 + 580) |
| After: High (1.5×) | 1920×1140 | 16.8–17.8 | 60 / 30 / 0 | 1,168 (588 + 580) |
| After: Medium / Auto on Retina (1.5×, 2048 shadows) | 1920×1140 | 16.3–17.5 | 60 / 30 / 0 | 1,168 |
| After: Battery saver (1×, no MSAA, no bloom, 1024 shadows) | 1280×760 | 5.6–11.9 | 60 / 30 / 0 | 1,168 |

  Draw calls don't change: none of these settings removes geometry. Roughly, per-second GPU work on High falls from about 120 × 21 ms (GPU-bound, since it can't actually reach 120) to 60 × 17 ms, and to 60 × 6–12 ms on Battery saver. Engine worklets drop from 8 per race and growing to 4 in total. `sim:check` was not run, as no physics or AI code changed.

## 10. Ship (session 3)

- [x] Production build, `npm run preview`, smoke test (`?autopilot&laps=1` to results, showroom, no console errors), 375 px glance.
  - 2026-09-24: `npm run build` is clean with no warnings (JS 193 + 377 + 425 kB, 68 + 101 + 105 kB gzipped; CSS 42 kB). `npm run preview` runs as `kart-preview` in `.claude/launch.json` (port 4173). Smoke test on the preview build at `?autopilot&laps=1&debug`, with `document.hidden` stubbed (see `CLAUDE.md`) so the real rAF loop ran: clicked Race, then Start race; it ran in real time at 60 rendered fps and finished P3 in 54.15 s, and the results screen showed 8 rows. Main menu, then Showroom: it opens and renders. The console showed only the `?debug` timing log, with no errors or warnings, and every request returned 200. At 375×812 (mobile preset): no horizontal scroll, the disclaimer footer is fully visible, and the menu fits. Nit for the backlog: in Settings the segmented controls (Graphics, Frame rate cap, Camera, Time of day) wrap onto 2–4 lines. They're usable but busy.
- [x] Deploy plan (Vercel; Cloudflare Pages as fallback). Ask before `git init`, the first commit and any deploy.
  - 2026-09-24, deployed: `vercel link` created `guilh1s-projects/gr-kart-sakura-circuit`, and one `vercel deploy` was run for the approved preview. **Vercel made it production anyway**, because a new CLI project's first deploy becomes production. It's live and public at https://gr-kart-sakura-circuit.vercel.app (deployment `dpl_A85gdgn6MnWdNc5AxuD7MZpfRDxS`); the owner was told. Checked: page and assets 200; `/assets/*` gets `max-age=31536000, immutable`; the HTML revalidates; og tags are absolute on the production URL; `.env.local` returns 404. The live page loads to the menu with no console errors, and its asset hashes match the locally smoke-tested build. Added `.vercelignore` (node_modules, dist, .env*, .DS_Store, .claude); `vercel link` wrote an OIDC token to `.env.local`, which is gitignored.
  - 2026-09-24: prepared, waiting for the owner's go-ahead. Nothing is committed or deployed.
    - `vercel.json`: Vite framework, `npm ci`, `npm run build`, output `dist`, and `Cache-Control: public, max-age=31536000, immutable` on `/assets/*` (hashed files). Other files keep Vercel's default (revalidate).
    - `package.json` `engines.node` is `24.x`, matching local Node 24.11. The lockfile already has the linux-x64 native binaries (Rolldown, lightningcss, esbuild, TypeScript 7).
    - OG URLs become absolute from `VERCEL_PROJECT_PRODUCTION_URL` at build time (checked with a fake value). `.gitignore` now covers `.vercel` and `.env*`.
    - The Vercel CLI 56.3.2 is installed but not logged in (invalid token), so the owner logs in.
    - Steps: `vercel login`, `vercel link` (new project `gr-kart-sakura-circuit`), `vercel deploy` (preview; Hobby previews sit behind Vercel login by default), check it, `vercel deploy --prod`. After deploy: `curl -I` an `/assets/*.js` for the immutable header, view-source for absolute og tags, and a smoke test on the live URL.
    - Cloudflare Pages fallback: `public/_headers` with the same `/assets/*` rule, `SITE_URL=https://<project>.pages.dev npm run build`, then `npx wrangler pages deploy dist`.

## 11. iPad play (session 3, after launch)

- [x] Tilt steering, with thumb-zone pedals.
  - 2026-09-24: `src/core/tilt.ts` (`TiltSteer`) reads `devicemotion` gravity and steers by its rotation within the device's x–y plane, relative to the pose held during the intro and countdown (`recenter()` every frame in those states). Because it's relative and in-plane, it reads the same in portrait, either landscape and upside down, at any backward lean, and whether the platform reports gravity or its reaction; checked with synthetic events in all six cases. Tuning: 2.5° deadzone, full lock at 28°, response curve ^1.2, ~40 ms low-pass. Below 2.5 m/s² of in-plane gravity (held flat) it stops reading, eases to centre and shows a "hold the screen up" hint. The Settings row "Tilt to steer" (touch devices with `DeviceMotionEvent` only) asks for motion access inside the tap; iOS's `requestPermission` is called again on every race start (also a tap). If declined, or no sensor answers within 1.5 s, it falls back to the steering pad with a message. In tilt mode the touch layout is two tall edge zones, left BRAKE and right GAS, starting 32% down to clear the HUD buttons. Checked by stepping `app.loop` with streamed synthetic motion: 15° gives ±0.43 steer and the kart turns; the brake zone takes 45 → 34 km/h.
- [x] Auto-accelerate (touch only).
  - 2026-09-24: `autoGas` setting. Throttle is 1 unless braking; the GAS pad or zone is hidden and BRAKE moves to its place. Holding throttle on the grid only revs, with no false-start rule.
- [x] Touch no longer overrides a keyboard or gamepad on touch devices.
  - 2026-09-24: bug: `Input.update` used touch values whenever touch controls existed, i.e. always on a tablet, so a Magic Keyboard or controller did nothing. Touch now drives only while `lastDevice === 'touch'` (set when the controls appear and on any touch). Checked: a keyboard press takes over and a tap hands control back.
- [x] Auto quality detects iPads.
  - 2026-09-24: iPadOS Safari sends a Mac user agent, so iPads got Medium. `Macintosh` plus `maxTouchPoints > 1` now counts as mobile, giving Low (touch-screen Windows laptops are unaffected).
- [x] Home-screen web app.
  - 2026-09-24: `public/manifest.webmanifest` (fullscreen, landscape, icons) plus `apple-mobile-web-app-capable`, `status-bar-style` (black-translucent) and `apple-mobile-web-app-title`.
- [x] Safe-area padding for touch controls.
  - 2026-09-24: the pads, steering pad and zones use `env(safe-area-inset-*)`; their inline positions moved to CSS. Pixel positions at 740×390 are unchanged from before.
- [x] Pre-launch review of the iPad branch (the owner can't test on a device yet).
  - 2026-09-24: found and fixed a stacking bug: the touch layer was re-appended on top of the UI whenever it was rebuilt mid-race (changing Tilt or Auto-accelerate from the pause menu's Settings), so on a phone in landscape the GAS zone covered the sheet's toggles. It's now `prepend`ed, so it sits under the HUD, sheets and results. Hit-tested at 740×390 with every Settings toggle and segment, the pause buttons, the results buttons and the HUD pause/camera buttons: all reachable, including where they overlap the zones. Status bar style changed from `black-translucent` to `black`, because the HUD doesn't pad for a translucent bar in home-screen mode. Desktop regression on the production build: no touch UI, keyboard steers, a 1-lap autopilot race to results (54.62 s, 8 rows), the showroom opens, the tilt settings are hidden, and no console errors. The manifest is served as `application/manifest+json`. `sim:check` was not needed (input and UI only).
- [x] Touch HUD layout (owner's iPad feedback).
  - 2026-09-24: on the owner's iPad the steering pad sat under the bottom-left minimap and GAS/BRAKE under the bottom-right speedometer. Both worked, but it looked messy. With touch controls on, `#hud.touch-mode` now hides the speedometer, pedal bars and G-meter and shows a compact bottom-centre readout (`.tspeed`: speed, units, thin rpm bar that turns red near the limiter). Above 760 px it also hides the bottom-left minimap and skips drawing it; phones keep theirs top-right. Checked at 1180×820 (iPad Air landscape) in pad and tilt layouts, and at 740×390 (phone): the readout sits between the controls with no overlap. Desktop is unchanged (all four gauges back, minimap redraws), the readout fades on the results screen like the other gauges, and there are no console errors.
- [x] Tilt didn't work on the owner's iPad; screen rotated while steering.
  - 2026-09-24: root cause of the silence: every tilt failure was reported through the race HUD's message line, which is hidden in the menu, so a refused permission just flipped the switch back off. Likely cause of the failure itself: Safari refusing motion access (declined once, or the device's Motion & Orientation setting). This is unconfirmed, because the pane can't emulate iPad Safari. Fixes: `TiltSteer` now records why (`failure`: blocked or needs-tap) and exposes `status` (off, blocked, needs-tap, waiting, no-sensor, flat, ok) and a signed `angle`. Settings › Tilt to steer shows a live check under the switch: a meter that follows the device, a plain-language status line (including what to do when blocked), and a Rotation Lock tip, since iPad Safari can't lock orientation. In races: a one-time tip to hold the screen like a wheel during the countdown; on a screen rotation, a message to turn on Rotation Lock and pause/resume; and resuming from pause re-centres on the current grip. Rotation deliberately doesn't re-centre automatically, because whether Safari reports device- or screen-relative motion is unconfirmed. All 9 Settings states were checked with stubbed permission answers and synthetic motion; steering is 0 at the countdown pose and ±0.43 at ±15°, and the same after a pause/resume re-grip at 30°. No console errors.
- [x] Test on a real iPad: tilt feel (deadzone and full-lock angle), zone size, sound unlock, performance on Low.
  - 2026-09-24: the owner confirmed on their iPad that "it all works" after the tilt-diagnostics release: tilt steering, the thumb zones and pad, and the new touch HUD. The current tuning (2.5° deadzone, 28° full lock) is kept. Sound wasn't specifically reported, so listening checks stay in backlog section 5.

## 12. Agent setup (session 3)

- [x] `AGENTS.md`, `CLAUDE.md`, `.claude/settings.json`, release-guard hook, Vercel ignored build step.
  - 2026-09-24: following code.claude.com/docs (memory, permissions, hooks). `AGENTS.md` holds the tool-neutral instructions; `CLAUDE.md` imports it with `@AGENTS.md` and adds Claude-only notes. With both present, Claude Code reads `CLAUDE.md` by default, so nothing loads twice. The PLAN "How to resume" commands and "Testing notes" moved there. `.claude/settings.json` allows build, typecheck and sim commands, has ask rules for force-push, pushes to main and production Vercel commands, and a PreToolUse hook (`.claude/hooks/guard-release.mjs`, exec form so the space in the path is safe). The hook uses a quote-aware lexer and recurses into `sh -c`, because Bash rules only match command text (`git -c … push` slips past `Bash(git push *)`). It returns `"ask"`, which the docs say still prompts in auto mode. 37/37 test commands classified correctly, including the exact `git -c credential.helper=… push origin main` form, bare `git push` on main, and commit messages that only mention `vercel --prod`; bad input fails open. `scripts/vercel-ignore-build.sh` (`ignoreCommand`) skips the build only when every change since `VERCEL_GIT_PREVIOUS_SHA` is `*.md` or `.claude/`, and builds when that SHA is empty or missing from the depth-10 clone; 9/9 cases checked in a scratch clone. `.gitignore` gains `CLAUDE.local.md` and `.claude/settings.local.json`. While writing the headless-module rule I found `core/input` (now importing `core/tilt`, which calls `matchMedia` at load) is imported by `kartPhysics` and `ai`. Both are `import type`, so it's safe; `sim:check` passes at the exact baseline (55 spins, laps in band) and the rule is now in `AGENTS.md`.
- [x] Repo clean-up and maintenance guardrails.
  - 2026-09-24: deleted the merged `claude-setup` and `ipad-tilt` branches (0 unmerged commits each), locally and on GitHub; `main` is the only branch. Added GitHub Actions CI (`.github/workflows/ci.yml`: `npm ci`, build failing on any Vite warning, `sim:check`; actions v7, Node from the new `.nvmrc`). Green in 21 s, and the Linux runner reproduces the Mac results exactly (47.27 s medium lap, 55 spins). Added `.editorconfig` codifying the existing style; the tree already conformed (no trailing whitespace, CRLF or tabs). The Vercel ignore step also skips `.github/` and `.editorconfig`-only pushes. GitHub repo: description, topics, delete-branch-on-merge on, and the unused Wiki and Projects tabs off (docs live in the repo). README has a CI badge. `AGENTS.md` documents CI and the short-lived-branch flow.

## Post-launch backlog

Deferred in session 3 (2026-09-24) to ship the first pass. Notes are kept as they were; nothing here was worked on.

### From section 3 (known issues)

- [ ] Lap-1 pile-ups in the esses (s≈180) and at the T4 exit (s≈320). Options: more AI caution on lap 1, and a grid stagger.
  - 2026-09-23 analysis (`SPINLOG=1`, seeds 1–6, 55 spins): s≈180 13 (lap 1); s≈320 10 on lap 1 plus 7 later; **s≈615 14 (mostly lap 1, on track at lat −3 to −5)**; s≈690 5. All are low speed (3–15 m/s) with karts running side by side and pushed beyond the edge (lat 4–7). Suspects in `ai.ts`: the "alongside: give a little room" rule moves `lateralTarget` outward with no clamp to the track edge (only ±5 from the line), and overtakes pick the outside in the esses. No change made yet; run `npm run sim:check` after any change.
- [ ] AI at skill 1.0 spins on the back straight (s≈355). Skill is capped at 0.99 for now; the cause is still unknown.
- [ ] Most corners are flat out; there are only about 3 real braking zones (hairpin, T7, carousel). Consider tightening T1, T4 or the esses, then re-run the sims.
- [ ] Brake boards: confirm the "50/100" placement makes sense for each braking zone.

### 4. Features untested in the browser

- [ ] Time trial: rolling start from −60 m, timer starting at the line, sector splits, live delta, ghost spawn, save and reload from localStorage, the "NEW BEST" message.
- [ ] Pause menu: resume, restart, settings, quit. Esc/P with results open. The H key (photo mode).
- [ ] Runtime settings changes: quality switch (MSAA sample change and target disposal), time-of-day switch (environment re-bake), units, camera default, assist toggle mid-race.
- [ ] R reset, the stuck hint, the wrong-way warning, B look-back in chase and helmet cams, C camera cycling (including the bumper cam).
- [ ] Replay controls: scrub, ¼×/½×/2× speed, pause, previous/next kart, each camera chip, Exit back to results. Also the player's AI cool-down lap after the finish.
- [ ] Effects, not yet looked at in motion: tire smoke, grass dirt, sparks on impacts, skid marks (fade and ring buffer), rubbered racing line, kerb shake.
- [ ] Other time-of-day presets (morning, noon, golden hour / "Diamond Fuji") and Low quality.
- [ ] Dynamic resolution in Auto mode. It needs a visible pane to measure; with the pane hidden, `requestAnimationFrame` pauses.

### 5. Audio (nothing has been listened to yet)

- [ ] AudioWorklet engine timbre across the rev range, the limiter stutter and overrun pops.
- [ ] Positional AI engines (PannerNode) and the listener following the camera.
- [ ] Tire squeal, wind, kerb rumble, grass, impacts, crowd, start beeps, UI clicks, mute (M), volume slider.
- [ ] Autoplay unlock on first input, and ducking while paused or in the showroom.
- [ ] CPU cost of 8 worklet voices; consider voicing only the nearest 3–4 AI karts.

### 6. Input and devices

- [ ] Gamepad: triggers, stick curve, buttons, rumble.
- [ ] Touch controls at the mobile preset: steering pad, pedals, pause and camera buttons, layout at 375 px wide.
- [ ] Mobile performance on Low quality, and the menu and HUD at small heights (a CSS fix for 760 px went in; not re-checked).
- [ ] Settings sheet at 375 px: the segmented controls wrap onto 2–4 lines (seen 2026-09-24). Consider a select or a stacked layout on narrow screens.

### 8. Nice-to-haves (not started)

- [ ] Real rear-view mirrors in the helmet cam via a low-res render target (High quality only).
- [ ] A big screen on the control tower showing a live TV-camera feed.
- [ ] A replay director that follows the closest battle instead of picking at random.
- [ ] Shorter terrain build (about 1.5 s now): cache projections or reduce resolution.
