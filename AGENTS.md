# AGENTS.md

GR KART · Sakura Circuit: a browser go-kart racer. Vite 8 (Rolldown), TypeScript (strict), Three.js r186, no framework. Live at https://gr-kart-sakura-circuit.vercel.app. `README.md` covers controls and architecture; `PLAN.md` is the status file and backlog.

## Commands

```bash
npm run dev                          # http://localhost:5173
npm run build                        # tsc --noEmit + vite build → dist/ (must finish with no warnings)
npm run preview                      # serve dist/ on :4173
npm run typecheck                    # tsc only
npm run sim:check                    # headless physics/AI regression gate, ~2 s
npx tsx scripts/sim.ts 0.925 3       # one AI kart: skill, laps
npx tsx scripts/sim8.ts 0.95 3 1     # 8-kart race: base skill, laps, seed (SPINLOG=1 logs spins)
npx tsx scripts/simkb.ts assist 0.9  # keyboard-style driver, assists on/off
npx tsx scripts/where.ts             # dump track geometry, racing line, speeds
```

Node 24 (`.nvmrc`, `engines`). There's no unit-test framework. Verification is `npm run build`, `npm run sim:check`, and driving the game in a browser. GitHub Actions (`.github/workflows/ci.yml`) runs the build, failing on any Vite warning, and `sim:check` on every push; a red check on `main` means the live site has a regression.

## Rules that aren't obvious from the code

- **Everything is procedural.** Models, textures and audio are generated at runtime; don't add model, texture or audio files. The only static files are in `public/`: icons, the og:image and the web-app manifest.
- **Physics and AI:** run `npm run sim:check` after any change to `src/kart/kartPhysics.ts`, `src/game/ai.ts`, `src/game/collisions.ts`, `src/track/` or `src/core/math.ts`, or to anything they import. It fails on a DNF, more than 14 spins per 8-kart race, a solo spin or off-track, or a lap outside ±1 s of the recorded bands. Physics steps at a fixed 240 Hz.
- **Headless-safe modules:** the harnesses run in Node and import `core/math`, `track/{track,trackData,racingLine}`, `kart/kartPhysics` and `game/{ai,collisions}`. Keep those free of DOM access at load time. They may use `import type` from browser-only modules (`core/input`, which pulls in `core/tilt` with `matchMedia`, and `game/racer`), but never a value import.
- **Tuning to keep:** the rear-biased CG (58%) with rear cornering stiffness about 20% above the front. Breaking that ratio brings the spins back. The AI runs without the player assists.
- **Performance is a feature.** The game used to run a MacBook's fans hard. Keep the 60 fps default cap, the 1.5× resolution ceiling on High, no rendering while `document.hidden`, the 30 fps menu, and the 4-voice engine audio pool. Measure draw calls and frame time with the method in `PLAN.md` section 1 before and after rendering changes.
- **Debug hooks** exist only with `?debug`: `window.app`, `window.THREE` and the world-build timing log. Other URL flags: `?autopilot` (AI drives your kart) and `?laps=N`.
- **Touch and tilt:** `src/core/tilt.ts` steers from the gravity vector's rotation in the screen plane, relative to the pose held during the countdown. Touch input only drives while it's the last device used, so a paired keyboard or gamepad keeps working.
- **Bundle:** three.js ships as two chunks, `three-core` and `three`, via `codeSplitting` in `vite.config.ts`, which keeps each under Vite's 500 kB warning. Don't raise `chunkSizeWarningLimit` to hide a warning.
- **Legal:** keep the "fan-made, not affiliated with Toyota" footer and disclaimer. Third-party license texts are generated into `dist/third-party-licenses.md` at build time; keep that working if you add dependencies or fonts.

## Code style

Match the surrounding code: 2-space indent, single quotes, semicolons, long lines are fine, short `//` comments that explain why rather than what. `strict` TypeScript with no `any` escapes where a real type fits. No new runtime dependencies without a good reason: the bundle is about 1 MB and three.js is most of it.

## Git and deploys

- **`main` is production.** Vercel deploys every push to `main` to the public site. Pushes that only touch `*.md`, `.claude/`, `.github/` or `.editorconfig` skip the Vercel build (`scripts/vercel-ignore-build.sh`).
- Work on a short-lived branch; a pushed branch gets CI and a private Vercel preview at `gr-kart-sakura-circuit-git-<branch>-guilh1s-projects.vercel.app` (Vercel login required). Merge into `main` with a fast-forward once CI is green, then delete the branch locally and on GitHub. `main` stays the only long-lived branch.
- Ask the owner before pushing to `main`, force-pushing, or running `vercel --prod`, `promote`, `rollback`, `alias` or `remove`. A PreToolUse hook (`.claude/hooks/guard-release.mjs`) enforces this for Claude Code.
- Commit as the GitHub no-reply address `1447850+Guilh@users.noreply.github.com` (already set as this repo's `user.email`). The owner's personal email must not appear in commits.
- Never commit `.env*`, `.vercel/`, `dist/` or `node_modules/`.
- When you finish a `PLAN.md` item, tick it and add a one-line dated note saying what changed and how it was verified.
