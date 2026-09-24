# GR KART · Sakura Circuit

[![CI](https://github.com/Guilh/gr-kart-game/actions/workflows/ci.yml/badge.svg)](https://github.com/Guilh/gr-kart-game/actions/workflows/ci.yml) · **Play:** https://gr-kart-sakura-circuit.vercel.app

A browser racing demo. You race seven AI karts round a fictional 860 m circuit lined with cherry trees, under Mt. Fuji. The kart and driver, the circuit, the scenery, every texture and every sound are generated in code at runtime. The project ships no model, image or audio files.

It's built with Vite, TypeScript and Three.js.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # typecheck + production build into dist/
npm run preview    # serve dist/ locally
npm run sim:check  # headless physics/AI regression check (about 2 s)
```

## Controls

| Keyboard | Action |
|---|---|
| W / ↑ | Throttle |
| S / ↓ | Brake (hold when stopped to push backwards) |
| A / D, ← / → | Steer |
| C | Cycle camera: chase, far, helmet, bumper, TV |
| B | Look behind |
| R | Marshal reset to the track |
| Esc / P | Pause |
| M | Mute |
| H | Hide the HUD (photo mode) |
| Space, [ / ] | Replay: pause, previous or next kart |

**Gamepad:** RT throttle, LT brake, left stick steers, Y camera, X look back, Start pause.
**Touch:** on-screen controls appear on phones and tablets: a steering pad on the left, GAS and BRAKE on the right. In Settings, **Tilt to steer** lets you hold the screen like a steering wheel (right thumb gas, left thumb brake; the straight-ahead position is taken during the start countdown), and **Auto-accelerate** holds the throttle for you. On iPad and iPhone, *Add to Home Screen* opens the game full screen.

## URL flags

| Flag | Effect |
|---|---|
| `?autopilot` | The AI drives your kart, for hands-free demos and testing |
| `?laps=N` | Race length, overriding the setting |
| `?debug` | Exposes `window.app` and `window.THREE` in the console and logs world-build timings |

Flags can be combined, for example `?autopilot&laps=1`.

## Graphics and battery

Settings → Graphics offers Auto, Low, Medium, High and **Battery saver**. Battery saver renders at 1× resolution with no MSAA or bloom, 1024 px shadows and 60 fps. The frame rate is capped at 60 by default (Settings → Frame rate cap: 30 / 60 / Off). The menu's background race runs at 30 fps, and nothing renders while the tab is hidden.

## Architecture

```
src/
  main.ts          App shell: loading → attract-mode menu → race / time trial / showroom; frame loop and frame cap
  core/            Input (keyboard, gamepad, touch), settings (localStorage), math helpers, ?debug flag
  track/           Circuit centreline, racing-line optimiser, track mesh, kerbs, barriers, terrain, scenery
  kart/            Kart physics (tyre model, drivetrain), procedural kart model, IK-rigged driver, specs
  game/            Race rules and timing, AI drivers, collisions, cameras and replay director, replay/ghost recording
  render/          Renderer and post chain (MSAA → bloom → ACES → speed FX), dynamic resolution, sky/lighting,
                   particles and skid marks, procedural textures, loft geometry
  audio/           Web Audio: AudioWorklet single-cylinder engine (4 voices, nearest karts), tyres, wind, crowd
  ui/              Menu, HUD, results, replay controls, minimap, showroom
scripts/           Headless harnesses (solo laps, 8-kart races, keyboard driver) and sim:check
```

Physics runs at a fixed 240 Hz step, independent of the frame rate. The same physics and AI code runs headless in `scripts/`, which is how `npm run sim:check` checks lap times, spins and DNFs without a browser.

## Contributing

Project rules, the regression check, and git and deploy etiquette (pushing `main` deploys the live site) are in [`AGENTS.md`](AGENTS.md), which is also the instruction file for coding agents. [`PLAN.md`](PLAN.md) tracks status and the backlog.

## Disclaimer

This is a fan-made tech demo, not affiliated with or endorsed by Toyota Motor Corporation or Toyota Gazoo Racing. "GR" and "GR KART" are used only to name the kart it's modelled on; the model is built from published dimensions. Sakura Circuit is fictional. It's a non-commercial project.

## Credits

- [Three.js](https://threejs.org) (MIT)
- [Titillium Web](https://fonts.google.com/specimen/Titillium+Web) and [Chakra Petch](https://fonts.google.com/specimen/Chakra+Petch) typefaces (SIL Open Font License), via [Fontsource](https://fontsource.org)
- [Vite](https://vite.dev) and [TypeScript](https://www.typescriptlang.org)
- Built with Claude Opus 5.5

The full license texts of the bundled libraries and fonts ship with the site at `/third-party-licenses.md`. `npm run build` generates the file.
