/**
 * Wiring: input, render loop, HUD, panel.
 *
 * All game logic sits behind `tap()`, so the browser build and the headless
 * bots exercise exactly the same decisions.
 */

import './style.css';
import { TRAY_SLOTS, isFree } from './core/tiles';
import { rankTakes } from './ai/solver';
import { createGame, dangerOfGame, tap, type GameState } from './game/game';
import { BoardView } from './ui/render';
import { DirectorPanel } from './ui/panel';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('board');
const view = new BoardView(canvas);
const panel = new DirectorPanel($('panel-body'));

const els = {
  score: $('score'),
  level: $('level'),
  dangerBar: $('danger-bar'),
  dangerPct: $('danger-pct'),
  hint: $('hint'),
  panel: $('panel'),
  panelToggle: $<HTMLButtonElement>('panel-toggle'),
  gameover: $('gameover'),
  goTitle: $('go-title'),
  goScore: $('go-score'),
  goLevels: $('go-levels'),
  goTaps: $('go-taps'),
  goMatches: $('go-matches'),
  goRead: $('go-read'),
  restart: $<HTMLButtonElement>('restart'),
};

let game: GameState = createGame();
let panelOpen = false;

const DEFAULT_HINT =
  '같은 무늬 3개를 모으면 사라집니다. 회색으로 일렁이는 타일은 <b>아직 무늬가 정해지지 않은</b> 타일입니다.';

/* ---------------- input ---------------- */

let pressedId: number | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (game.over) return;
  const t = view.hitTest(game.board, e.clientX, e.clientY);
  if (t && !t.taken && t.face >= 0 && isFree(game.board, t)) {
    pressedId = t.id;
    view.setPressed(t.id);
  }
});

const release = (): void => {
  pressedId = null;
  view.setPressed(null);
};

canvas.addEventListener('pointerup', (e) => {
  if (game.over) return;
  const t = view.hitTest(game.board, e.clientX, e.clientY);
  const was = pressedId;
  release();
  if (t && t.id === was) doTap(t.id);
  else if (t && t.face < 0) {
    // Tapping a covered tile is the moment to explain the central idea.
    setHint('이 타일은 아직 무늬가 없습니다. 위에 덮인 타일을 먼저 치워야 결정됩니다.');
  }
});

canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', release);

function doTap(id: number): void {
  const now = performance.now();
  const before = game.level;
  const res = tap(game, id, Date.now());
  if (res.kind === 'ignored') return;

  view.addLift(id, now);
  if (res.matched !== null) {
    view.addClear(res.matched, now);
    setHint(game.combo >= 3 ? `${game.combo}연속 완성` : '');
  } else if (game.board.tray.length >= TRAY_SLOTS - 1) {
    view.addShake(now);
    setHint('슬롯이 하나 남았습니다 — 이제 AI가 완성패를 내려놓습니다.', true);
  } else {
    setHint('');
  }

  for (const r of res.reveals) view.addResolve(r.tileId, now);
  if (res.levelCleared) {
    view.clearEffects();
    view.layout(game.board);
    setHint(`레벨 ${before} 클리어 — 다음 판은 조금 더 커집니다.`);
  }

  updateHud(res.matched !== null);
  if (panelOpen) panel.render(game);
  if (res.gameOver) showGameOver();
}

/* ---------------- HUD ---------------- */

function setHint(html: string, alert = false): void {
  els.hint.innerHTML = html || DEFAULT_HINT;
  els.hint.classList.toggle('alert', alert);
}

function updateHud(pop = false): void {
  els.score.textContent = game.score.toLocaleString('ko-KR');
  els.level.textContent = String(game.level);
  const d = dangerOfGame(game);
  els.dangerBar.style.width = `${Math.round(d * 100)}%`;
  els.dangerPct.textContent = `${Math.round(d * 100)}%`;
  if (pop) {
    els.score.classList.remove('pop');
    void els.score.offsetWidth;
    els.score.classList.add('pop');
  }
}

/* ---------------- game over ---------------- */

function showGameOver(): void {
  els.goTitle.textContent = '트레이가 가득 찼습니다';
  els.goScore.textContent = game.score.toLocaleString('ko-KR');
  els.goLevels.textContent = String(game.cleared);
  els.goTaps.textContent = String(game.taps);
  els.goMatches.textContent = String(game.matches);
  els.goRead.textContent = playerRead();
  els.gameover.hidden = false;
}

/**
 * What the assigner concluded about this player.
 *
 * The estimate exists whether or not anyone looks at it; showing it at the end
 * turns "that got hard" into "that got hard *because of this*".
 */
function playerRead(): string {
  const k = game.skill;
  const grade = k.theta > 0.75 ? '숙련' : k.theta > 0.55 ? '중급' : k.theta > 0.35 ? '입문' : '첫 판';
  const strong =
    k.foresight >= k.efficiency
      ? '고를 때마다 뒤를 보는 편입니다'
      : '트레이를 깨끗하게 유지하는 편입니다';
  const weak =
    k.foresight < 0.5
      ? '다만 지금 당장 사라지는 쪽을 자주 골랐습니다'
      : k.efficiency < 0.5
        ? '다만 외톨이 무늬를 오래 들고 있었습니다'
        : '판단이 안정적이었습니다';
  return (
    `${game.taps}번의 탭을 관측한 결과 — ${grade} (θ ${Math.round(k.theta * 100)}%). ` +
    `${strong}. ${weak}. ` +
    `이 판에서 AI가 즉석에서 결정한 타일은 ${game.revealCount}개입니다.`
  );
}

els.restart.addEventListener('click', () => {
  game = createGame();
  els.gameover.hidden = true;
  view.clearEffects();
  view.setHint([]);
  view.layout(game.board);
  setHint('');
  updateHud();
  if (panelOpen) panel.render(game);
});

/* ---------------- panel ---------------- */

function setPanel(open: boolean): void {
  panelOpen = open;
  els.panel.hidden = !open;
  els.panelToggle.setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('panel-open', open);
  requestAnimationFrame(() => view.layout(game.board));
  if (open) panel.render(game);
  else view.setHint([]);
}

els.panelToggle.addEventListener('click', () => setPanel(!panelOpen));
$('panel-close').addEventListener('click', () => setPanel(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setPanel(!panelOpen);
  if (e.key === 'Escape') setPanel(false);
});

/* ---------------- loop ---------------- */

const ro = new ResizeObserver(() => view.layout(game.board));
ro.observe(canvas);
window.addEventListener('load', () => view.layout(game.board));
window.addEventListener('orientationchange', () => setTimeout(() => view.layout(game.board), 120));

let warmup = 8;
let hintAt = 0;

function frame(now: number): void {
  if (warmup > 0) {
    warmup--;
    view.layout(game.board);
  }
  // The panel reflows the board, and CSS transitions mean the new size arrives
  // over several frames rather than on the click.
  view.layoutIfNeeded(game.board);
  // While the panel is open, outline the tiles the assigner most recently
  // wrote — it makes "the AI decided these, just now" legible on the board.
  if (panelOpen && now - hintAt > 200) {
    hintAt = now;
    view.setHint(game.lastReveals.map((r) => r.tileId));
    panel.refreshChart(game);
  }
  view.render(game.board, now);
  requestAnimationFrame(frame);
}

/* ---------------- capture mode ---------------- */

/** `?autoplay=N&panel=1` plays N bot taps so documentation screenshots show a
 *  real mid-run board produced by the engine rather than a mock-up. */
function capture(): void {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('autoplay') ?? 0);
  for (let i = 0; i < n && !game.over; i++) {
    const ranked = rankTakes(game.board);
    if (ranked.length === 0) break;
    doTap(ranked[Math.min(ranked.length - 1, i % 2)].tile.id);
  }
  if (n > 0) {
    view.clearEffects();
    setHint('');
  }
  if (params.get('panel') === '1') setPanel(true);
}

view.layout(game.board);
updateHud();
setHint('');
capture();
requestAnimationFrame(frame);
