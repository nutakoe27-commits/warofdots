/**
 * Application bootstrap: menu, match lifecycle and the wiring between the
 * simulation, the renderer, the HUD and input.
 *
 * A match owns its own renderer, minimap and HUD because all three are built
 * around a specific `World`. Starting a new match tears the old set down rather
 * than rebinding them, which keeps this file free of "is this still the same map?"
 * checks.
 *
 * `hud` and `loop` are nullable on the runtime only because they are constructed
 * after the callbacks that reach for them. By the time any callback can fire, both
 * are set.
 */

import './styles.css';

import { TICK_SEC } from './core/balance.ts';
import type { World } from './core/types.ts';
import { loadBundledMaps } from './content/maps.browser.ts';
import { listMapDefs } from './content/registry.ts';
import { centreOn, createCamera, resize as resizeCamera } from './render/camera.ts';
import type { Camera } from './render/camera.ts';
import { themeByName } from './render/theme.ts';
import type { ThemeName } from './render/theme.ts';
import { captureInterp, createInterpBuffer } from './render/frame.ts';
import type { FrameState, InterpBuffer } from './render/frame.ts';
import { createRenderer } from './render/renderer.ts';
import type { Renderer } from './render/renderer.ts';
import { createMinimap } from './render/minimap.ts';
import type { Minimap } from './render/minimap.ts';
import { createSelection, pruneSelection } from './game/selection.ts';
import type { SelectionState } from './game/selection.ts';
import { createInput } from './game/input.ts';
import type { InputContext, InputHandlers } from './game/input.ts';
import { createLoop } from './game/loop.ts';
import type { Loop } from './game/loop.ts';
import { createMatch, defaultSetup } from './game/match.ts';
import type { MatchSetup } from './game/match.ts';
import type { MatchSession } from './game/session.ts';
import { createHud } from './ui/hud.ts';
import type { Hud } from './ui/hud.ts';
import type { UiCallbacks } from './ui/types.ts';
import { createMenu } from './ui/menu.ts';
import type { MatchConfig, Menu } from './ui/menu.ts';
import { createEndScreen } from './ui/endscreen.ts';
import type { EndScreen } from './ui/endscreen.ts';
import { loadSettings, saveSettings } from './ui/settings.ts';
import type { Settings } from './ui/settings.ts';
import { setLocale } from './ui/i18n.ts';
import type { BotDebug } from './ai/types.ts';

interface Shell {
  canvas: HTMLCanvasElement;
  minimapCanvas: HTMLCanvasElement;
  hudRoot: HTMLElement;
  settings: Settings;
  menu: Menu;
  endScreen: EndScreen;
  active: ActiveMatch | null;
  lastSetup: MatchSetup;
}

interface ActiveMatch {
  session: MatchSession;
  dispose(): void;
}

interface MatchRuntime {
  shell: Shell;
  session: MatchSession;
  world: World;
  camera: Camera;
  selection: SelectionState;
  interp: InterpBuffer;
  renderer: Renderer;
  minimap: Minimap;
  frame: FrameState;
  ctx: InputContext;
  debugBuffer: BotDebug[];
  hud: Hud | null;
  loop: Loop | null;
  showAiDebug: boolean;
  showDebugPanel: boolean;
  menuOpen: boolean;
  ended: boolean;
  /** Theme the terrain bitmap was baked from; a change has to invalidate it. */
  bakedTheme: ThemeName;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html is missing #${id}`);
  return node as T;
}

function applyTheme(settings: Settings): void {
  document.documentElement.dataset.theme = settings.theme;
}

// ───────────────────────────────────────────────────────── match callbacks ──

function focusCity(rt: MatchRuntime, index: number): void {
  const city = rt.world.cities[index];
  if (city) centreOn(rt.camera, city.x, city.y, rt.world.map);
}

function setSpeed(rt: MatchRuntime, speed: 1 | 2 | 3): void {
  if (!rt.loop) return;
  rt.loop.speed = speed;
  rt.hud?.setSpeed(speed);
}

function togglePause(rt: MatchRuntime): void {
  if (!rt.loop) return;
  rt.loop.paused = !rt.loop.paused;
  rt.hud?.setPaused(rt.loop.paused);
}

/** Escape toggles the menu over a live match; the renderer keeps drawing behind it. */
function toggleMenu(rt: MatchRuntime): void {
  if (rt.ended) return;
  rt.menuOpen = !rt.menuOpen;
  rt.ctx.blocked = rt.menuOpen;
  if (!rt.menuOpen) {
    rt.shell.menu.hide();
    return;
  }
  if (rt.loop) rt.loop.paused = true;
  rt.hud?.setPaused(true);
  rt.shell.menu.show();
}

function hudCallbacks(rt: MatchRuntime): UiCallbacks {
  const viewer = rt.session.viewer;
  return {
    onProduction: (threshold, heavyShare) => {
      if (viewer > 0) rt.session.queue({ t: 'production', player: viewer, threshold, heavyShare });
    },
    onToggleCity: (city, active) => {
      if (viewer > 0) rt.session.queue({ t: 'cityActive', player: viewer, city, active });
    },
    onFocusCity: (city) => focusCity(rt, city),
    onSetSpeed: (speed) => setSpeed(rt, speed),
    onTogglePause: () => togglePause(rt),
    onResign: () => {
      if (viewer > 0) rt.session.queue({ t: 'resign', player: viewer });
    },
  };
}

function inputHandlers(rt: MatchRuntime): InputHandlers {
  return {
    emit: (cmd) => rt.session.queue(cmd),
    togglePause: () => togglePause(rt),
    setSpeed: (speed) => setSpeed(rt, speed),
    toggleAiDebug: () => {
      rt.showAiDebug = !rt.showAiDebug;
    },
    toggleDebugPanel: () => {
      rt.showDebugPanel = !rt.showDebugPanel;
      rt.hud?.setDebugVisible(rt.showDebugPanel);
    },
    toggleTerritory: () => {
      rt.shell.settings.showTerritory = !rt.shell.settings.showTerritory;
      saveSettings(rt.shell.settings);
    },
    escape: () => toggleMenu(rt),
    focusCity: (city) => focusCity(rt, city),
  };
}

// ────────────────────────────────────────────────────────────── the frames ──

function stepMatch(rt: MatchRuntime): void {
  captureInterp(rt.world, rt.interp);
  rt.session.advance();
  if (rt.session.viewer > 0) pruneSelection(rt.world, rt.selection, rt.session.viewer);
}

function renderMatch(rt: MatchRuntime, alpha: number, hoverX: number, hoverY: number): void {
  const settings = rt.shell.settings;
  if (rt.bakedTheme !== settings.theme) {
    rt.bakedTheme = settings.theme;
    rt.renderer.invalidateTerrain();
  }

  const frame = rt.frame;
  frame.alpha = alpha;
  frame.theme = themeByName(settings.theme);
  frame.colorblind = settings.colorblind;
  frame.showTerritory = settings.showTerritory;
  frame.hoverX = hoverX;
  frame.hoverY = hoverY;
  if (rt.loop) {
    frame.perf = rt.loop.perf;
    frame.perf.simMs = rt.session.lastSimMs || rt.loop.perf.simMs;
  }

  rt.debugBuffer.length = 0;
  if (rt.showAiDebug) for (const bot of rt.session.bots) rt.debugBuffer.push(bot.debug());
  frame.aiDebug = rt.debugBuffer;

  rt.renderer.draw(frame);
  rt.minimap.draw(frame);
  rt.hud?.update(frame);

  if (!rt.ended && rt.world.outcome !== null) {
    rt.ended = true;
    if (rt.loop) rt.loop.paused = true;
    rt.ctx.blocked = true;
    rt.shell.endScreen.show(rt.world, rt.session.viewer);
  }
}

function fitViewport(rt: MatchRuntime): void {
  const w = Math.max(1, rt.shell.canvas.clientWidth);
  const h = Math.max(1, rt.shell.canvas.clientHeight);
  resizeCamera(rt.camera, w, h, rt.world.map);
  rt.renderer.resize(w, h, window.devicePixelRatio || 1);
}

// ─────────────────────────────────────────────────────────── match assembly ──

function createRuntime(shell: Shell, session: MatchSession): MatchRuntime {
  const world = session.world;
  const canvas = shell.canvas;
  const camera = createCamera(world.map, canvas.clientWidth || 1, canvas.clientHeight || 1);
  const selection = createSelection();

  const rt: MatchRuntime = {
    shell,
    session,
    world,
    camera,
    selection,
    interp: createInterpBuffer(world.units.capacity),
    renderer: createRenderer(canvas, world),
    minimap: createMinimap(shell.minimapCanvas, world),
    frame: {
      world,
      camera,
      theme: themeByName(shell.settings.theme),
      selection,
      interp: createInterpBuffer(0),
      alpha: 0,
      viewer: session.viewer,
      colorblind: shell.settings.colorblind,
      showTerritory: shell.settings.showTerritory,
      aiDebug: [],
      hoverX: 0,
      hoverY: 0,
      perf: { fps: 0, simMs: 0, renderMs: 0, ticksThisFrame: 0 },
    },
    ctx: {
      world,
      camera,
      selection,
      viewer: session.viewer,
      cameraSpeed: shell.settings.cameraSpeed,
      blocked: false,
    },
    debugBuffer: [],
    hud: null,
    loop: null,
    showAiDebug: false,
    showDebugPanel: false,
    menuOpen: false,
    ended: false,
    bakedTheme: shell.settings.theme,
  };
  rt.frame.interp = rt.interp;
  return rt;
}

async function runMatch(shell: Shell, setup: MatchSetup): Promise<ActiveMatch> {
  const session = await createMatch(setup);
  const rt = createRuntime(shell, session);
  const canvas = shell.canvas;

  rt.hud = createHud({ viewer: session.viewer, callbacks: hudCallbacks(rt) });
  shell.hudRoot.append(rt.hud.root);

  const input = createInput(canvas, rt.ctx, inputHandlers(rt));
  input.attach();

  rt.loop = createLoop({
    beforeFrame: (dtSec) => {
      rt.ctx.cameraSpeed = shell.settings.cameraSpeed;
      input.update(dtSec);
    },
    step: () => stepMatch(rt),
    render: (alpha) => renderMatch(rt, alpha, input.hoverX, input.hoverY),
  });

  const observer = new ResizeObserver(() => fitViewport(rt));
  observer.observe(canvas);
  fitViewport(rt);

  const onMinimapClick = (event: PointerEvent): void => {
    const rect = shell.minimapCanvas.getBoundingClientRect();
    const hit = rt.minimap.hitTest(event.clientX - rect.left, event.clientY - rect.top);
    if (hit) centreOn(rt.camera, hit.x, hit.y, rt.world.map);
  };
  shell.minimapCanvas.addEventListener('pointerdown', onMinimapClick);
  rt.loop.start();

  return {
    session,
    dispose(): void {
      rt.loop?.stop();
      input.detach();
      observer.disconnect();
      shell.minimapCanvas.removeEventListener('pointerdown', onMinimapClick);
      rt.hud?.destroy();
      shell.hudRoot.replaceChildren();
    },
  };
}

// ──────────────────────────────────────────────────────────────────── boot ──

async function startMatch(shell: Shell, setup: MatchSetup): Promise<void> {
  shell.lastSetup = setup;
  shell.active?.dispose();
  shell.active = null;
  shell.menu.hide();
  shell.endScreen.hide();
  try {
    shell.active = await runMatch(shell, setup);
  } catch (error) {
    console.error('не удалось запустить матч', error);
    shell.menu.show();
  }
}

function boot(): void {
  loadBundledMaps();
  const settings = loadSettings();
  applyTheme(settings);
  setLocale(settings.locale);

  const maps = listMapDefs().map((d) => ({ id: d.id, name: d.name, players: d.players }));
  const shell = {
    canvas: element<HTMLCanvasElement>('game'),
    minimapCanvas: element<HTMLCanvasElement>('minimap'),
    hudRoot: element('hud'),
    settings,
    active: null,
    lastSetup: defaultSetup(maps[0]?.id ?? 'crossing'),
  } as Shell;

  shell.endScreen = createEndScreen({
    onRestart: () => void startMatch(shell, shell.lastSetup),
    onExitToMenu: () => {
      shell.active?.dispose();
      shell.active = null;
      shell.endScreen.hide();
      shell.menu.show();
    },
  });

  shell.menu = createMenu({
    maps,
    settings,
    onStart: (cfg: MatchConfig) => void startMatch(shell, cfg),
    onSettingsChange: (next) => {
      Object.assign(settings, next);
      saveSettings(settings);
      applyTheme(settings);
      setLocale(settings.locale);
    },
  });

  element('overlay').append(shell.menu.root, shell.endScreen.root);
  shell.menu.show();

  // Handy during tuning sessions: the live session from the browser console.
  Object.assign(window as unknown as Record<string, unknown>, {
    dotfront: { tickSeconds: TICK_SEC, session: () => shell.active?.session ?? null },
  });
}

boot();
