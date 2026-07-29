/**
 * Application bootstrap: menu, match lifecycle and the wiring between the
 * simulation, the renderer, the HUD and input.
 *
 * A match owns its own renderer, minimap and HUD because all three are built
 * around a specific `World`. Starting a new match tears the old set down rather
 * than trying to rebind them, which keeps this file free of "is this still the
 * same map?" checks.
 */

import './styles.css';

import { TICK_SEC } from './core/balance.ts';
import { loadBundledMaps } from './content/maps.browser.ts';
import { listMapDefs } from './content/registry.ts';
import { createCamera, centreOn, resize as resizeCamera } from './render/camera.ts';
import { themeByName } from './render/theme.ts';
import { captureInterp, createInterpBuffer } from './render/frame.ts';
import type { FrameState } from './render/frame.ts';
import { createRenderer } from './render/renderer.ts';
import { createMinimap } from './render/minimap.ts';
import { createSelection, pruneSelection } from './game/selection.ts';
import { createInput } from './game/input.ts';
import type { InputContext } from './game/input.ts';
import { createLoop } from './game/loop.ts';
import { createMatch, defaultSetup } from './game/match.ts';
import type { MatchSetup } from './game/match.ts';
import type { MatchSession } from './game/session.ts';
import { createHud } from './ui/hud.ts';
import { createMenu } from './ui/menu.ts';
import type { MatchConfig } from './ui/menu.ts';
import { createEndScreen } from './ui/endscreen.ts';
import { loadSettings, saveSettings } from './ui/settings.ts';
import type { Settings } from './ui/settings.ts';
import { setLocale } from './ui/i18n.ts';
import type { BotDebug } from './ai/types.ts';

interface ActiveMatch {
  session: MatchSession;
  dispose(): void;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html is missing #${id}`);
  return node as T;
}

function applyTheme(settings: Settings): void {
  document.documentElement.dataset.theme = settings.theme;
}

function boot(): void {
  loadBundledMaps();
  const settings = loadSettings();
  applyTheme(settings);
  setLocale(settings.locale);

  const canvas = element<HTMLCanvasElement>('game');
  const minimapCanvas = element<HTMLCanvasElement>('minimap');
  const hudRoot = element('hud');
  const overlay = element('overlay');

  const maps = listMapDefs().map((d) => ({ id: d.id, name: d.name, players: d.players }));
  let active: ActiveMatch | null = null;
  let lastSetup: MatchSetup = defaultSetup(maps[0]?.id ?? 'crossing');

  const endScreen = createEndScreen({
    onRestart: () => void startMatch(lastSetup),
    onExitToMenu: () => {
      active?.dispose();
      active = null;
      endScreen.hide();
      menu.show();
    },
  });

  const menu = createMenu({
    maps,
    settings,
    onStart: (cfg: MatchConfig) => void startMatch(cfg),
    onSettingsChange: (next) => {
      Object.assign(settings, next);
      saveSettings(settings);
      applyTheme(settings);
      setLocale(settings.locale);
    },
  });

  overlay.append(menu.root, endScreen.root);
  menu.show();

  async function startMatch(setup: MatchSetup): Promise<void> {
    lastSetup = setup;
    active?.dispose();
    active = null;
    menu.hide();
    endScreen.hide();
    try {
      active = await runMatch(setup);
    } catch (error) {
      console.error('не удалось запустить матч', error);
      menu.show();
    }
  }

  async function runMatch(setup: MatchSetup): Promise<ActiveMatch> {
    const session = await createMatch(setup);
    const world = session.world;
    const camera = createCamera(world.map, canvas.clientWidth || 1, canvas.clientHeight || 1);
    const selection = createSelection();
    const interp = createInterpBuffer(world.units.capacity);
    const renderer = createRenderer(canvas, world);
    const minimap = createMinimap(minimapCanvas, world);
    let showAiDebug = false;
    let showDebugPanel = false;
    let menuOpen = false;
    let ended = false;
    // The terrain bitmap is baked from the palette, so a theme switch has to
    // throw it away rather than just changing the colours drawn on top of it.
    let bakedTheme = settings.theme;

    const hud = createHud({
      viewer: session.viewer,
      callbacks: {
        onProduction: (threshold, heavyShare) => {
          if (session.viewer > 0) {
            session.queue({ t: 'production', player: session.viewer, threshold, heavyShare });
          }
        },
        onToggleCity: (city, isActive) => {
          if (session.viewer > 0) {
            session.queue({ t: 'cityActive', player: session.viewer, city, active: isActive });
          }
        },
        onFocusCity: (city) => {
          const target = world.cities[city];
          if (target) centreOn(camera, target.x, target.y, world.map);
        },
        onSetSpeed: (speed) => {
          loop.speed = speed;
          hud.setSpeed(speed);
        },
        onTogglePause: () => togglePause(),
        onResign: () => {
          if (session.viewer > 0) session.queue({ t: 'resign', player: session.viewer });
        },
      },
    });
    hudRoot.append(hud.root);

    const context: InputContext = {
      world,
      camera,
      selection,
      viewer: session.viewer,
      cameraSpeed: settings.cameraSpeed,
      blocked: false,
    };

    const input = createInput(canvas, context, {
      emit: (cmd) => session.queue(cmd),
      togglePause: () => togglePause(),
      setSpeed: (speed) => {
        loop.speed = speed;
        hud.setSpeed(speed);
      },
      toggleAiDebug: () => {
        showAiDebug = !showAiDebug;
      },
      toggleDebugPanel: () => {
        showDebugPanel = !showDebugPanel;
        hud.setDebugVisible(showDebugPanel);
      },
      toggleTerritory: () => {
        settings.showTerritory = !settings.showTerritory;
        saveSettings(settings);
      },
      // Escape toggles the menu over a live match. The renderer keeps drawing
      // behind it, so the map stays on screen while the match is halted.
      escape: () => {
        if (ended) return;
        menuOpen = !menuOpen;
        context.blocked = menuOpen;
        if (menuOpen) {
          loop.paused = true;
          hud.setPaused(true);
          menu.show();
        } else {
          menu.hide();
        }
      },
      focusCity: (city) => {
        const target = world.cities[city];
        if (target) centreOn(camera, target.x, target.y, world.map);
      },
    });
    input.attach();

    const frame: FrameState = {
      world,
      camera,
      theme: themeByName(settings.theme),
      selection,
      interp,
      alpha: 0,
      viewer: session.viewer,
      colorblind: settings.colorblind,
      showTerritory: settings.showTerritory,
      aiDebug: [],
      hoverX: 0,
      hoverY: 0,
      perf: { fps: 0, simMs: 0, renderMs: 0, ticksThisFrame: 0 },
    };

    const debugBuffer: BotDebug[] = [];

    const loop = createLoop({
      beforeFrame: (dtSec) => {
        context.cameraSpeed = settings.cameraSpeed;
        input.update(dtSec);
      },
      step: () => {
        captureInterp(world, interp);
        session.advance();
        if (session.viewer > 0) pruneSelection(world, selection, session.viewer);
      },
      render: (alpha) => {
        if (bakedTheme !== settings.theme) {
          bakedTheme = settings.theme;
          renderer.invalidateTerrain();
        }
        frame.alpha = alpha;
        frame.theme = themeByName(settings.theme);
        frame.colorblind = settings.colorblind;
        frame.showTerritory = settings.showTerritory;
        frame.hoverX = input.hoverX;
        frame.hoverY = input.hoverY;
        frame.perf = loop.perf;
        frame.perf.simMs = session.lastSimMs || loop.perf.simMs;

        debugBuffer.length = 0;
        if (showAiDebug) for (const bot of session.bots) debugBuffer.push(bot.debug());
        frame.aiDebug = debugBuffer;

        renderer.draw(frame);
        minimap.draw(frame);
        hud.update(frame);

        if (!ended && world.outcome !== null) {
          ended = true;
          loop.paused = true;
          context.blocked = true;
          endScreen.show(world, session.viewer);
        }
      },
    });

    function togglePause(): void {
      loop.paused = !loop.paused;
      hud.setPaused(loop.paused);
    }

    function fit(): void {
      const w = Math.max(1, canvas.clientWidth);
      const h = Math.max(1, canvas.clientHeight);
      resizeCamera(camera, w, h, world.map);
      renderer.resize(w, h, window.devicePixelRatio || 1);
    }

    const observer = new ResizeObserver(fit);
    observer.observe(canvas);
    fit();

    const onMinimapClick = (event: PointerEvent): void => {
      const rect = minimapCanvas.getBoundingClientRect();
      const hit = minimap.hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (hit) centreOn(camera, hit.x, hit.y, world.map);
    };
    minimapCanvas.addEventListener('pointerdown', onMinimapClick);
    loop.start();

    return {
      session,
      dispose(): void {
        loop.stop();
        input.detach();
        observer.disconnect();
        minimapCanvas.removeEventListener('pointerdown', onMinimapClick);
        hud.destroy();
        hudRoot.replaceChildren();
      },
    };
  }

  // Keep the tick rate discoverable from the console during tuning sessions.
  Object.assign(window as unknown as Record<string, unknown>, {
    dotfront: {
      tickSeconds: TICK_SEC,
      session: () => active?.session ?? null,
    },
  });
}

boot();
