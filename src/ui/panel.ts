/**
 * The glass-box director panel.
 *
 * A difficulty system that quietly helps is worth less than one that can show
 * its work, so everything the director used to make its last decision is on
 * screen: the estimate it holds of the player, the target it derived, the
 * batches it considered, the one it picked and why, and the invariant it
 * checked before committing.
 */

import { DIR_NAME, type Dir } from '../core/grid';
import { exitClosure } from '../ai/solver';
import type { SpawnCandidate } from '../ai/director';
import type { GameState } from '../game/game';

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export class DirectorPanel {
  private chart: HTMLCanvasElement | null = null;

  constructor(private body: HTMLElement) {}

  render(s: GameState): void {
    const d = s.lastDecision;

    if (!d) {
      this.body.innerHTML = `<p class="empty-note">화살표를 한 번 누르면 디렉터가 첫 판단을 내립니다.<br />이 패널은 그 판단의 근거를 그대로 보여줍니다.</p>`;
      this.chart = null;
      return;
    }

    const c = d.constraints;
    const closure = exitClosure(s.grid);

    this.body.innerHTML = `
      ${this.skillBlock(s)}
      ${this.flowBlock()}
      ${this.decisionBlock(c.rationale, c.tags)}
      ${this.candidatesBlock(d.considered, d.chosen)}
      ${this.invariantBlock(d.playable, d.evaluated, d.rejectedForMobility, closure.count, c.preferredExits)}
      ${this.readoutBlock(s, closure.count)}
    `;

    this.chart = this.body.querySelector('#flow-chart');
    this.drawChart(s);
  }

  /** Redraw only the parts that move every frame. */
  refreshChart(s: GameState): void {
    if (this.chart) this.drawChart(s);
  }

  private skillBlock(s: GameState): string {
    const k = s.skill;
    const gauge = (label: string, v: number, cls = ''): string => `
      <div class="gauge">
        <div class="gauge-row"><span>${label}</span><b>${pct(v)}</b></div>
        <div class="gauge-track"><div class="gauge-fill ${cls}" style="width:${pct(v)}"></div></div>
      </div>`;

    return `<div class="pblock">
      <h3>플레이어 추정 · ${k.samples}탭 관측</h3>
      ${gauge('숙련도 θ', k.theta, 'theta')}
      ${gauge('계획성 (수순당 후회의 역수)', k.foresight)}
      ${gauge('효율 (탭당 탈출률)', k.efficiency)}
      ${gauge('템포 (판단 속도)', k.tempo)}
      <div class="kv">
        <span>좌절도</span><b>${pct(s.mood.frustration)}</b>
        <span>지루함</span><b>${pct(s.mood.boredom)}</b>
      </div>
    </div>`;
  }

  private flowBlock(): string {
    return `<div class="pblock">
      <h3>플로우 채널</h3>
      <canvas id="flow-chart"></canvas>
      <div class="legend">
        <span><i style="background:#46e0a0"></i>숙련도 θ</span>
        <span><i style="background:#56e1ff"></i>목표 난이도</span>
        <span><i style="background:#ffb23e"></i>실제 난이도</span>
      </div>
    </div>`;
  }

  private decisionBlock(rationale: string, tags: string[]): string {
    const chips = tags
      .map((t) => {
        const cls = t === '구제' || t === '완화' ? 'cool' : t === '압박' || t === '종반' ? 'hot' : '';
        return `<span class="tag ${cls}">${t}</span>`;
      })
      .join('');
    return `<div class="pblock">
      <h3>이번 스폰의 판단</h3>
      <div class="rationale">${rationale}</div>
      ${chips ? `<div class="tags">${chips}</div>` : ''}
    </div>`;
  }

  private candidatesBlock(considered: SpawnCandidate[], chosen: SpawnCandidate | null): string {
    if (considered.length === 0) {
      return `<div class="pblock"><h3>후보 비교</h3><p class="empty-note">이번 탭은 스폰이 없었습니다.</p></div>`;
    }
    const rows = considered
      .map((cand) => {
        const win = cand === chosen;
        const arrows =
          cand.placements.length === 0
            ? '—'
            : cand.placements.map((p) => DIR_NAME[p.dir as Dir]).join(' ');
        return `<tr class="${win ? 'win' : ''}">
          <td class="arrows-cell">${win ? '▸ ' : ''}${arrows}</td>
          <td>${pct(cand.challenge)}</td>
          <td>${cand.closure}</td>
          <td>${cand.mobility}</td>
          <td>${cand.score.toFixed(1)}</td>
        </tr>`;
      })
      .join('');

    return `<div class="pblock">
      <h3>후보 비교 · 상위 ${considered.length}개</h3>
      <table class="cands">
        <thead><tr><th>배치</th><th>난이도</th><th>탈출</th><th>가동</th><th>점수</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private invariantBlock(
    playable: boolean,
    evaluated: number,
    rejected: number,
    closure: number,
    preferred: number,
  ): string {
    return `<div class="pblock">
      <h3>불변식 검증</h3>
      <div class="invariant ${playable ? '' : 'bad'}">
        <i class="dot"></i>
        <div>
          <b>스폰 직후 최소 1수 이동 가능</b> — ${playable ? '충족' : '위반'}<br />
          후보 ${evaluated}개 검토 · ${rejected}개 기각(가동 불가)
        </div>
      </div>
      <div class="kv">
        <span>현재 보장된 탈출 체인</span><b>${closure}수</b>
        <span>이번 목표 탈출로 (선호)</span><b>${preferred}수</b>
      </div>
    </div>`;
  }

  private readoutBlock(s: GameState, closure: number): string {
    return `<div class="pblock">
      <h3>런 상태</h3>
      <div class="kv">
        <span>탭 / 탈출 / 잼</span><b>${s.taps} / ${s.exits} / ${s.jams}</b>
        <span>압력 (강도 램프)</span><b>${pct(s.lastDecision?.constraints.intensity ?? 0)}</b>
        <span>스폰 레이트</span><b>${(s.lastDecision?.constraints.spawnRate ?? 0).toFixed(2)}/탭</b>
        <span>보드 위 화살표</span><b>${countArrows(s)}</b>
        <span>보장 탈출 체인</span><b>${closure}수</b>
        <span>시드</span><b>${s.seed}</b>
      </div>
    </div>`;
  }

  /**
   * Skill against target against realised difficulty, over the run.
   *
   * The claim the whole project rests on is that the orange line tracks the
   * blue one. Drawing all three together is the fastest way for someone to
   * check that claim rather than take it on faith.
   */
  private drawChart(s: GameState): void {
    const canvas = this.chart;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);
    const padX = 6 * dpr;
    const padY = 8 * dpr;
    const plotW = w - padX * 2;
    const plotH = h - padY * 2;

    ctx.strokeStyle = 'rgba(125,135,158,0.16)';
    ctx.lineWidth = dpr;
    for (let i = 0; i <= 4; i++) {
      const y = padY + (plotH * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - padX, y);
      ctx.stroke();
    }

    const pts = s.history.slice(-90);
    if (pts.length < 2) return;

    const line = (get: (p: (typeof pts)[number]) => number, color: string, width: number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = padX + (plotW * i) / (pts.length - 1);
        const y = padY + plotH * (1 - Math.min(1, Math.max(0, get(p))));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    line((p) => p.challenge, '#ffb23e', 1.6);
    line((p) => p.target, '#56e1ff', 1.8);
    line((p) => p.theta, '#46e0a0', 1.8);
  }
}

function countArrows(s: GameState): number {
  let n = 0;
  for (let i = 0; i < s.grid.length; i++) if (s.grid[i] !== 0) n++;
  return n;
}
