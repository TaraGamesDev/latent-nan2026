/**
 * The glass-box panel.
 *
 * A system that quietly decides what the player sees is worth less than one
 * that can show its working, so everything the assigner used for its most
 * recent write is on screen: the estimate it holds of the player, the target it
 * derived, the danger it read off the tray, every face it considered, which of
 * them would have broken completability, and which it wrote.
 */

import { TRAY_SLOTS } from '../core/tiles';
import { RELIEF_LABEL, debtOf } from '../ai/assigner';
import { statsOf } from '../ai/solver';
import type { GameState } from '../game/game';

const pct = (v: number): string => `${Math.round(v * 100)}%`;

export class DirectorPanel {
  private chart: HTMLCanvasElement | null = null;

  constructor(private body: HTMLElement) {}

  render(s: GameState): void {
    const last = s.lastDecision;
    if (!last) {
      this.body.innerHTML = `<p class="empty-note">타일을 하나 가져가면 그 아래가 드러나고, 그때 AI가 무늬를 결정합니다.<br />이 패널은 그 결정의 근거를 그대로 보여줍니다.</p>`;
      this.chart = null;
      return;
    }

    const board = statsOf(s.board);
    this.body.innerHTML = `
      ${this.skillBlock(s)}
      ${this.flowBlock()}
      ${this.decisionBlock(last.rationale, last.tags)}
      ${this.candidateBlock(s)}
      ${this.invariantBlock(s)}
      ${this.readoutBlock(s, board)}
    `;
    this.chart = this.body.querySelector('#flow-chart');
    this.drawChart(s);
  }

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
      ${gauge('정돈 (트레이를 깨끗하게)', k.efficiency)}
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
        const cls = t === '구제' || t === '완화' ? 'cool' : t === '압박' || t === '위험' ? 'hot' : '';
        return `<span class="tag ${cls}">${t}</span>`;
      })
      .join('');
    return `<div class="pblock">
      <h3>방금 쓴 타일의 근거</h3>
      <div class="rationale">${rationale}</div>
      ${chips ? `<div class="tags">${chips}</div>` : ''}
    </div>`;
  }

  private candidateBlock(s: GameState): string {
    const last = s.lastDecision;
    if (!last) return '';
    const rows = last.candidates
      .map((c) => {
        const win = c.face === last.face && c.relief === last.relief;
        return `<tr class="${win ? 'win' : ''}">
          <td class="arrows-cell">${win ? '▸ ' : ''}#${c.face}</td>
          <td>${RELIEF_LABEL[c.relief]}</td>
          <td>${c.debtAfter}</td>
          <td>${c.feasible ? '가능' : '<b style="color:#d1385a">불가</b>'}</td>
          <td>${c.score.toFixed(2)}</td>
        </tr>`;
      })
      .join('');
    return `<div class="pblock">
      <h3>후보 무늬 비교</h3>
      <table class="cands">
        <thead><tr><th>무늬</th><th>효과</th><th>미완성</th><th>완결성</th><th>점수</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="empty-note">‘미완성’은 이 선택 뒤에도 3의 배수를 맞추려면 더 배정해야 하는 타일 수입니다. 남은 타일보다 커지면 그 레벨은 절대 못 끝냅니다 — 그런 후보는 <b>완결성 불가</b>로 잘립니다.</p>
    </div>`;
  }

  private invariantBlock(s: GameState): string {
    const debt = debtOf(s.ledger);
    const ok = s.board.undecided >= debt;
    const last = s.lastDecision;
    return `<div class="pblock">
      <h3>불변식 검증</h3>
      <div class="invariant ${ok ? '' : 'bad'}">
        <i class="dot"></i>
        <div>
          <b>이 레벨은 끝까지 클리어 가능</b> — ${ok ? '충족' : '위반'}<br />
          미결정 타일 ${s.board.undecided}개 ≥ 완성에 필요한 ${debt}개
          ${last && last.rejected > 0 ? ` · 후보 ${last.rejected}개 기각` : ''}
        </div>
      </div>
      <p class="empty-note">레벨을 미리 만들지 않기 때문에 <b>사후 검증이 필요 없습니다.</b> 배정 시점에 이 부등식만 지키면 클리어 가능성은 구성상 보장됩니다.</p>
    </div>`;
  }

  private readoutBlock(s: GameState, board: ReturnType<typeof statsOf>): string {
    const last = s.lastDecision;
    return `<div class="pblock">
      <h3>런 상태</h3>
      <div class="kv">
        <span>레벨 / 탭 / 완성</span><b>${s.level} / ${s.taps} / ${s.matches}</b>
        <span>트레이</span><b>${s.board.tray.length} / ${TRAY_SLOTS} (외톨이 ${board.singles})</b>
        <span>위험도</span><b>${pct(last?.danger ?? 0)}</b>
        <span>구제 확률</span><b>${pct(last?.reliefChance ?? 0)}</b>
        <span>레벨 진행 (램프)</span><b>${pct(last?.ramp ?? 0)}</b>
        <span>남은 타일 / 미결정</span><b>${board.remaining} / ${s.board.undecided}</b>
        <span>이 판에서 쓴 타일</span><b>${s.revealCount}개</b>
        <span>시드</span><b>${s.seed}</b>
      </div>
    </div>`;
  }

  /**
   * Skill against target against realised difficulty.
   *
   * The claim the project rests on is that the orange line follows the blue
   * one. Drawing all three together is the fastest way to check that rather
   * than take it on faith.
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
    const pw = w - padX * 2;
    const ph = h - padY * 2;

    ctx.strokeStyle = 'rgba(125,135,158,0.16)';
    ctx.lineWidth = dpr;
    for (let i = 0; i <= 4; i++) {
      const y = padY + (ph * i) / 4;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(w - padX, y);
      ctx.stroke();
    }

    const pts = s.history.slice(-90);
    if (pts.length < 2) return;

    const line = (get: (p: (typeof pts)[number]) => number, colour: string, width: number): void => {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = padX + (pw * i) / (pts.length - 1);
        const y = padY + ph * (1 - Math.min(1, Math.max(0, get(p))));
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
