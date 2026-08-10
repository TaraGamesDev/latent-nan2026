/**
 * Wiring: input, render loop, HUD, panel.
 *
 * All game logic sits behind `tap()`, so the browser build and the headless
 * bots exercise exactly the same decisions.
 */

import './style.css';
import { HOLDERS, isReachable } from './core/plates';
import { rankTurns } from './ai/solver';
import { createGame, dangerOfGame, tap, type GameState } from './game/game';
import { WallScene } from './ui/scene';
import { loadAssets } from './ui/assets';
import { DirectorPanel } from './ui/panel';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>('board');
const panel = new DirectorPanel($('panel-body'));

// The parts are real models, so the first frame has to wait for them. It is a
// couple of hundred kilobytes and the hint line says what is happening, which is
// better than a blank canvas.
const scene = new WallScene(canvas, await loadAssets());

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
  '나사를 눌러 풀면 같은 색 홀더로 들어갑니다. <b>회색 나사는 아직 색이 정해지지 않은</b> 나사입니다.';

scene.build(game.board);
scene.resize();

/* ---------------- input ---------------- */

canvas.addEventListener('pointermove', (e) => {
  if (game.over) return;
  scene.setHovered(scene.pick(game.board, e.clientX, e.clientY));
});

canvas.addEventListener('pointerdown', (e) => {
  if (game.over) return;
  const id = scene.pick(game.board, e.clientX, e.clientY);
  if (id !== null) doTap(id);
  else {
    const covered = game.board.screws.find(
      (s) => !s.removed && s.colour < 0 && !isReachable(game.board, s),
    );
    if (covered) setHint('회색 나사는 아직 색이 없습니다. 위에 덮인 판을 먼저 떼어내야 정해집니다.');
  }
});

function doTap(id: number): void {
  const holderBefore = game.board.holders.map((h) => ({ ...h }));
  const res = tap(game, id, Date.now());
  if (res.kind === 'ignored') return;

  if (res.gameOver) {
    scene.sync(game.board);
    updateHud();
    showGameOver();
    return;
  }

  // Find where the screw actually landed so the animation flies to that socket.
  let landed = -1;
  let socket = 0;
  for (let i = 0; i < HOLDERS; i++) {
    const before = holderBefore[i];
    const after = game.board.holders[i];
    if (after.count !== before.count || after.colour !== before.colour) {
      landed = i;
      socket = res.completed ? 2 : Math.max(0, after.count - 1);
      break;
    }
  }
  scene.animateUnscrew(id, landed, socket);
  for (const p of res.fallen) scene.animatePlateFall(p);
  for (const r of res.reveals) scene.animateReveal(r.screwId, r.colour);

  if (res.completed) setHint(game.combo >= 3 ? `${game.combo}연속 완성` : '');
  else if (res.fallen.length > 0) setHint(`판 ${res.fallen.length}장이 떨어졌습니다.`);
  else setHint('');

  scene.sync(game.board);
  if (res.levelCleared) {
    scene.build(game.board);
    scene.resize();
    setHint('벽 하나 완료 — 다음 벽은 조금 더 두껍습니다.');
  }

  updateHud(res.completed);
  if (panelOpen) panel.render(game);
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
  els.goTitle.textContent = '홀더가 가득 찼습니다';
  els.goScore.textContent = game.score.toLocaleString('ko-KR');
  els.goLevels.textContent = String(game.cleared);
  els.goTaps.textContent = String(game.taps);
  els.goMatches.textContent = String(game.completions);
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
      ? '풀 때마다 다음을 보는 편입니다'
      : '홀더를 오래 비워두지 않는 편입니다';
  const weak =
    k.foresight < 0.5
      ? '다만 눈앞에서 완성되는 쪽을 자주 골랐습니다'
      : k.efficiency < 0.5
        ? '다만 반쯤 찬 홀더를 여럿 안고 다녔습니다'
        : '판단이 안정적이었습니다';
  return (
    `${game.taps}번의 탭을 관측한 결과 — ${grade} (θ ${Math.round(k.theta * 100)}%). ` +
    `${strong}. ${weak}. ` +
    `이 판에서 AI가 즉석에서 색을 정한 나사는 ${game.revealCount}개입니다.`
  );
}

els.restart.addEventListener('click', () => {
  game = createGame();
  els.gameover.hidden = true;
  scene.build(game.board);
  scene.resize();
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
  requestAnimationFrame(() => scene.resize());
  if (open) panel.render(game);
  else scene.setHighlight([]);
}

els.panelToggle.addEventListener('click', () => setPanel(!panelOpen));
$('panel-close').addEventListener('click', () => setPanel(false));
window.addEventListener('keydown', (e) => {
  if (e.key === 'd' || e.key === 'D') setPanel(!panelOpen);
  if (e.key === 'Escape') setPanel(false);
});

/* ---------------- loop ---------------- */

const ro = new ResizeObserver(() => scene.resize());
ro.observe(canvas);
window.addEventListener('load', () => scene.resize());
window.addEventListener('orientationchange', () => setTimeout(() => scene.resize(), 120));

let hintAt = 0;

function frame(now: number): void {
  if (panelOpen && now - hintAt > 200) {
    hintAt = now;
    scene.setHighlight(game.lastReveals.map((r) => r.screwId));
    panel.refreshChart(game);
  }
  scene.render(now);
  requestAnimationFrame(frame);
}

/* ---------------- capture mode ---------------- */

/** `?autoplay=N&panel=1` plays N bot taps so documentation screenshots show a
 *  real mid-run wall produced by the engine rather than a mock-up. */
function capture(): void {
  const params = new URLSearchParams(location.search);
  const n = Number(params.get('autoplay') ?? 0);
  for (let i = 0; i < n && !game.over; i++) {
    const ranked = rankTurns(game.board);
    if (ranked.length === 0) break;
    doTap(ranked[Math.min(ranked.length - 1, i % 2)].screw.id);
  }
  if (n > 0) {
    scene.settle();
    setHint('');
  }
  if (params.get('panel') === '1') setPanel(true);
}

updateHud();
setHint('');
capture();
requestAnimationFrame(frame);
