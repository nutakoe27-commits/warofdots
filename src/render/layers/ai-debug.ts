/**
 * The F3 bot overlay.
 *
 * Everything drawn here comes from `frame.aiDebug`, which is the bot's own view of
 * itself — the point of the overlay is to show what the bot believes, not what is
 * true, so it deliberately never recomputes anything from the world except the
 * positions it needs to anchor a marker.
 *
 * Draws nothing at all when no bot has published debug state.
 */

import type { World } from '../../core/types.ts';
import { DRAW_R } from '../../core/balance.ts';
import { cellCenterX, cellCenterY } from '../../core/influence.ts';
import { slotOfId } from '../../core/units.ts';
import type { BotDebug, GroupRoleId } from '../../ai/types.ts';
import { GroupRole } from '../../ai/types.ts';
import { worldToScreenX, worldToScreenY } from '../camera.ts';
import type { FrameState, Layer } from '../frame.ts';
import { lerpX, lerpY } from '../frame.ts';
import { playerColor } from '../theme.ts';

const TAU = Math.PI * 2;
const FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

const ROLES: readonly GroupRoleId[] = [
  GroupRole.Frontline,
  GroupRole.Reserve,
  GroupRole.Garrison,
  GroupRole.Raid,
  GroupRole.Escort,
];

const ROLE_COLORS: Record<GroupRoleId, string> = {
  frontline: '#ff7043',
  reserve: '#42a5f5',
  garrison: '#66bb6a',
  raid: '#ab47bc',
  escort: '#ffd54f',
};

const ROLE_GAP = 3;
const ROLE_WIDTH = 1.2;
const FRONT_R = 9;
const FRONT_WIDTH = 2;
/** Half-length of the crosshair through a front marker, and where its label sits. */
const FRONT_CROSS = FRONT_R * 1.6;
const FRONT_LABEL_X = FRONT_R * 1.8;
const ARROW_HEAD = 9;
/** Half-angle of the arrowhead, radians. */
const ARROW_SPREAD = 0.4;
const ARROW_WIDTH = 1.4;
const ENCIRCLE_MARK = 8;
const PANEL_X = 12;
const PANEL_Y = 12;
const PANEL_W = 172;
const PANEL_H = 44;
const PANEL_GAP = 6;
const PANEL_PAD = 6;
const BAR_H = 5;
const PANEL_BORDER_WIDTH = 1;
/** Baseline step between the two lines of panel text. */
const PANEL_LINE = 13;
const BAR_OVER = '#d94a4a';
const BAR_OK = '#5cb85c';

function drawRoleRings(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  debug: BotDebug,
): void {
  const u = world.units;
  const zoom = frame.camera.zoom;
  ctx.lineWidth = ROLE_WIDTH;
  for (const role of ROLES) {
    ctx.strokeStyle = ROLE_COLORS[role];
    ctx.beginPath();
    for (const [id, assigned] of debug.roles) {
      if (assigned !== role) continue;
      const slot = slotOfId(u, id);
      if (slot < 0 || !u.alive[slot]) continue;
      const x = worldToScreenX(frame.camera, lerpX(frame, slot));
      const y = worldToScreenY(frame.camera, lerpY(frame, slot));
      const r = DRAW_R[u.kind[slot]!]! * zoom + ROLE_GAP;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.stroke();
  }
}

function drawFronts(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  debug: BotDebug,
): void {
  const cam = frame.camera;
  const colour = playerColor(world.players[debug.player]?.colorIndex ?? 0);
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = FRONT_WIDTH;
  ctx.font = FONT;
  ctx.textBaseline = 'middle';
  for (const front of debug.fronts) {
    const x = worldToScreenX(cam, front.x);
    const y = worldToScreenY(cam, front.y);
    ctx.beginPath();
    ctx.moveTo(x + FRONT_R, y);
    ctx.arc(x, y, FRONT_R, 0, TAU);
    ctx.moveTo(x - FRONT_CROSS, y);
    ctx.lineTo(x + FRONT_CROSS, y);
    ctx.moveTo(x, y - FRONT_CROSS);
    ctx.lineTo(x, y + FRONT_CROSS);
    ctx.stroke();
    ctx.fillText(front.ratio.toFixed(2), x + FRONT_LABEL_X, y);
  }
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - Math.cos(a - ARROW_SPREAD) * ARROW_HEAD,
    y1 - Math.sin(a - ARROW_SPREAD) * ARROW_HEAD,
  );
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - Math.cos(a + ARROW_SPREAD) * ARROW_HEAD,
    y1 - Math.sin(a + ARROW_SPREAD) * ARROW_HEAD,
  );
}

/** Centre of mass of the bot's army, the natural tail for a "go there" arrow. */
function armyCentre(world: World, player: number, out: { x: number; y: number }): boolean {
  const u = world.units;
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < u.capacity; i++) {
    if (!u.alive[i] || u.owner[i] !== player) continue;
    sx += u.x[i]!;
    sy += u.y[i]!;
    n++;
  }
  if (n === 0) return false;
  out.x = sx / n;
  out.y = sy / n;
  return true;
}

const centre = { x: 0, y: 0 };

function drawTargets(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  debug: BotDebug,
): void {
  const cam = frame.camera;
  const colour = playerColor(world.players[debug.player]?.colorIndex ?? 0);
  ctx.strokeStyle = colour;
  ctx.lineWidth = ARROW_WIDTH;
  ctx.beginPath();

  if (armyCentre(world, debug.player, centre)) {
    const x0 = worldToScreenX(cam, centre.x);
    const y0 = worldToScreenY(cam, centre.y);
    for (const index of debug.targetCities) {
      const city = world.cities[index];
      if (!city) continue;
      drawArrow(ctx, x0, y0, worldToScreenX(cam, city.x), worldToScreenY(cam, city.y));
    }
  }

  if (debug.encircleCell >= 0) {
    const x = worldToScreenX(cam, cellCenterX(world, debug.encircleCell));
    const y = worldToScreenY(cam, cellCenterY(world, debug.encircleCell));
    ctx.moveTo(x - ENCIRCLE_MARK, y - ENCIRCLE_MARK);
    ctx.lineTo(x + ENCIRCLE_MARK, y + ENCIRCLE_MARK);
    ctx.moveTo(x + ENCIRCLE_MARK, y - ENCIRCLE_MARK);
    ctx.lineTo(x - ENCIRCLE_MARK, y + ENCIRCLE_MARK);
    ctx.moveTo(x + ENCIRCLE_MARK, y);
    ctx.arc(x, y, ENCIRCLE_MARK, 0, TAU);
  }
  ctx.stroke();
}

function drawPanel(
  ctx: CanvasRenderingContext2D,
  frame: FrameState,
  world: World,
  debug: BotDebug,
  row: number,
): void {
  const x = PANEL_X;
  const y = PANEL_Y + row * (PANEL_H + PANEL_GAP);
  ctx.fillStyle = frame.theme.panel;
  ctx.fillRect(x, y, PANEL_W, PANEL_H);
  ctx.strokeStyle = frame.theme.panelBorder;
  ctx.lineWidth = PANEL_BORDER_WIDTH;
  ctx.strokeRect(x + 0.5, y + 0.5, PANEL_W - 1, PANEL_H - 1);

  const score = debug.modeScores[debug.mode];
  ctx.font = FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = playerColor(world.players[debug.player]?.colorIndex ?? 0);
  ctx.fillText(debug.profile, x + PANEL_PAD, y + PANEL_PAD);
  ctx.fillStyle = frame.theme.text;
  const mode = score === undefined ? debug.mode : `${debug.mode} ${score.toFixed(1)}`;
  ctx.fillText(mode, x + PANEL_PAD, y + PANEL_PAD + PANEL_LINE);

  const barW = PANEL_W - PANEL_PAD * 2;
  const barY = y + PANEL_H - PANEL_PAD - BAR_H;
  const used = debug.apmBudget > 0 ? debug.apmSpent / debug.apmBudget : 0;
  ctx.fillStyle = frame.theme.panelBorder;
  ctx.fillRect(x + PANEL_PAD, barY, barW, BAR_H);
  ctx.fillStyle = used > 1 ? BAR_OVER : BAR_OK;
  ctx.fillRect(x + PANEL_PAD, barY, barW * Math.min(1, used), BAR_H);
}

export function createAiDebugLayer(world: World): Layer {
  return {
    name: 'ai-debug',
    draw(ctx: CanvasRenderingContext2D, frame: FrameState): void {
      if (frame.aiDebug.length === 0) return;
      for (let row = 0; row < frame.aiDebug.length; row++) {
        const debug = frame.aiDebug[row]!;
        drawRoleRings(ctx, frame, world, debug);
        drawFronts(ctx, frame, world, debug);
        drawTargets(ctx, frame, world, debug);
        drawPanel(ctx, frame, world, debug, row);
      }
    },
  };
}
