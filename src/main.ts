/**
 * Wiring: input, render loop, HUD, panel.
 *
 * All game logic lives behind `tap()`; this file is deliberately thin so the
 * browser build and the headless bots exercise the same decisions.
 */

import './style.css';
import { type Move } from './core/grid';
import { exitClosure } from './ai/solver';
import { createGame, intensityOf, tap, type GameState } from './game/game';
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
  combo: $('combo'),
  intensityBar: $('intensity-bar'),
  intensityPct: $('intensity-pct'),
  hint: $('hint'),
  panel: $('panel'),
  panelToggle: $<HTMLButtonElement>('panel-toggle'),
  gameover: $('gameover'),
  goTitle: $('go-title'),
  goScore: $('go-score'),
  goTaps: $('go-taps'),
  goExits: $('go-exits'),
  goCombo: $('go-combo'),
  goRead: $('go-read'),
  restart: $<HTMLButtonElement>('restart'),
};

let game: GameState = createGame();
let panelOpen = false;

/* ---------------- input ---------------- */

let pressedCell: number | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (game.over) return;
  const cell = view.cellFromPoint(e.clientX, e.clientY);
  if (cell !== null && game.grid[cell] !== 0) {
    pressedCell = cell;
    view.setPressed(cell);
  }
});

const releasePress = (): void => {
  pressedCell = null;
  view.setPressed(null);
};

canvas.addEventListener('pointerup', (e) => {
  if (game.over) return;
  const cell = view.cellFromPoint(e.clientX, e.clientY);
  const wasPressed = pressedCell;
  releasePress();
  // Only fire when the release lands on the arrow the press started on, so a
  // slip off the tile reads as a cancel rather than a mistap.
  if (cell !== null && cell === wasPressed) doTap(cell);
});

canvas.addEventListener('pointercancel', releasePress);
canvas.addEventListener('pointerleave', releasePress);

function doTap(cell: number): void {
  const now = performance.now();
  const res = tap(game, cell, Date.now());

  if (res.kind === 'jam') {
    view.addJam(cell, now);
    setHint('막혔습니다 — 앞이 비어 있는 화살표를 눌러 보세요.', true);
  } else if (res.move) {
    view.addSlide(res.move, now);
    if (res.kind === 'exit') {
      view.addFloat(cell, `+${res.points}`, now);
      setHint(game.combo >= 3 ? `${game.combo}연속 탈출` : '');
    } else {
      setHint('막혀서 도중에 멈췄습니다 — 이제 다른 화살표의 길이 바뀝니다.');
    }
  }

  view.addSpawns(res.spawned, now);
  updateHud(res.kind === 'exit');
  if (panelOpen) panel.render(game);
  if (res.gameOver) showGameOver();
}

/* ---------------- HUD ---------------- */

function setHint(text: string, alert = false): void {
  els.hint.textContent =
    text || '화살표를 누르면 그 방향으로 미끄러집니다. 판 밖으로 나가면 득점.';
  els.hint.classList.toggle('alert', alert);
}

function updateHud(pop = false): void {
  els.score.textContent = game.score.toLocaleString('ko-KR');
  els.combo.textContent = game.combo > 0 ? `×${game.combo}` : '—';
  const i = intensityOf(game);
  els.intensityBar.style.width = `${Math.round(i * 100)}%`;
  els.intensityPct.textContent = `${Math.round(i * 100)}%`;
  if (pop) {
    els.score.classList.remove('pop');
    void els.score.offsetWidth;
    els.score.classList.add('pop');
  }
}

/* ---------------- game over ---------------- */

function showGameOver(): void {
  const overflow = game.lastDecision?.overflow ?? false;
  els.goTitle.textContent = overflow ? '보드가 가득 찼습니다' : '모든 화살표가 막혔습니다';
  els.goScore.textContent = game.score.toLocaleString('ko-KR');
  els.goTaps.textContent = String(game.taps);
  els.goExits.textContent = String(game.exits);
  els.goCombo.textContent = String(game.bestCombo);
  els.goRead.textContent = playerRead();
  els.gameover.hidden = false;
}

/**
 * One paragraph on what the director concluded about this player.
 *
 * The estimate exists whether or not anyone sees it; showing it at the end is
 * what turns "the game got harder" into "the game got harder *because of this*".
 */
function playerRead(): string {
  const k = game.skill;
  const grade = k.theta > 0.75 ? '숙련' : k.theta > 0.55 ? '중급' : k.theta > 0.35 ? '입문' : '첫 판';
  const strength =
    k.foresight >= k.efficiency && k.foresight >= k.tempo
      ? '수를 멀리 봅니다'
      : k.efficiency >= k.tempo
        ? '탈출로를 잘 찾아냅니다'
        : '판단이 빠릅니다';
  const weak =
    k.foresight <= k.efficiency && k.foresight <= k.tempo
      ? '다만 한 수 뒤에 길이 막히는 배치를 자주 고릅니다'
      : k.efficiency <= k.tempo
        ? '다만 득점 기회를 흘려보내는 편입니다'
        : '다만 결정에 시간이 걸립니다';

  return (
    `${game.taps}번의 탭을 관측한 결과 — ${grade} (θ ${Math.round(k.theta * 100)}%). ` +
    `${strength}. ${weak}. ` +
    `디렉터는 이 추정에 맞춰 목표 난이도를 ${Math.round((game.history.at(-1)?.target ?? 0.5) * 100)}%까지 조정했습니다.`
  );
}

els.restart.addEventListener('click', () => {
  game = createGame();
  els.gameover.hidden = true;
  view.setChain([]);
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
  // The board resizes when the layout reflows around the panel.
  requestAnimationFrame(() => view.resize());
  if (open) panel.render(game);
  else view.setChain([]);
}

els.panelToggle.addEventListener('click', () => setPanel(!panelOpen));
$('panel-close').addEventListener('click', () => setPanel(false));

window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setPanel(!panelOpen);
  if (e.key === 'Escape') setPanel(false);
});

/* ---------------- loop ---------------- */

const ro = new ResizeObserver(() => view.resize());
ro.observe(canvas);
window.addEventListener('orientationchange', () => setTimeout(() => view.resize(), 120));

let chainRefreshedAt = 0;

function frame(now: number): void {
  // The proved exit chain is only drawn while the panel is open - it is an
  // explanation of the guarantee, not a hint the player is meant to lean on.
  if (panelOpen && now - chainRefreshedAt > 250) {
    chainRefreshedAt = now;
    view.setChain(exitClosure(game.grid).sequence.slice(0, 6) as Move[]);
    panel.refreshChart(game);
  }
  view.render(game.grid, now);
  requestAnimationFrame(frame);
}

updateHud();
setHint('');
requestAnimationFrame(frame);
