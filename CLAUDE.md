@AGENTS.md

## Claude Code

- Start servers with `preview_start` using the names in `.claude/launch.json`: `kart-dev` (:5173) or `kart-preview` (:4173, serves `dist/`, so run `npm run build` first). Don't start them from Bash, and stop them when you're done.
- `.claude/settings.json` pre-approves the build, typecheck and sim commands. Its release-guard hook makes pushes to `main`, force-pushes and production Vercel commands ask the owner, even in auto mode. Don't try to route around it.
- After a physics or AI change, run `npm run sim:check` yourself; don't ask the user to.

### Driving the game in the Browser pane

- Open the page with `?debug` (for example `/?debug&autopilot&laps=1`), or `window.app` won't exist.
- The pane reports `document.hidden === true`, and the loop skips frames while hidden. Stub it before testing: `Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })`.
- While the pane is hidden, `requestAnimationFrame` doesn't run at all and screenshots lag one render behind. Step the game by hand instead: set `window.requestAnimationFrame = () => 0`, then call `app.loop(t)` with `t` advancing 1000/60 per frame (a 1-lap race is about 60 s of game time). Render twice before a screenshot. Reload the page afterwards.
- Re-sync the clock at the start of every stepping block (`t = performance.now(); app.last = t; app.nextFrame = 0`). A visibility change resets `app.last` to real time; if your `t` has fallen behind, every step gets a near-zero `dt` and the race seems frozen.
- For the showroom, replace `app.showroom.update` with a no-op and step it by hand, or auto-rotate runs between steps.
- To import a module in the console, use the URL the app actually loaded: `performance.getEntriesByType('resource')` shows it, often with a `?t=` suffix after HMR. A plain `import('/src/core/settings.ts')` can give you a second copy of the module, so changing it does nothing.
- Widths under 768 px emulate a touch device, which shows the touch controls. iOS motion permission (`DeviceMotionEvent.requestPermission`) is denied outside a real tap; stub it to resolve `'granted'` (or `'denied'`, or throw, to test the failure messages), and drive tilt with synthetic `DeviceMotionEvent`s. Keep sending them while paused, as a real device does, or re-centring reads a stale pose.
- Drive UI flows by clicking the real buttons (`.menu-item[data-act=race]`, then the sheet's "Start race") rather than calling `app.startRace`, so the same code paths run. A scripted `.click()` still isn't a user gesture, which is why the permission stub above is needed.
