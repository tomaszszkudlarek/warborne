// Hover tips that explain where an army's battle strength comes from: its own strength (level,
// items, blessing, training), group boosts, terrain, and the stack bonus term by term
// (game/combat.js battleStrength, or the snapshot a battle's log starts with).
import { h } from './dom.js';
import { unitName, typeName, unitStats } from '../game/rules.js';
import { battleStrength, MEDAL_DIE } from '../game/combat.js';

const TERM_NAMES = { leadership: 'Leadership', morale: 'Morale', fortify: 'Fortify', chaos: 'chaos', fear: 'fear', siege: 'siege' };
const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0');
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const row = (label, n, cls = '') => `<div class="r${cls ? ' ' + cls : ''}"><span>${esc(label)}</span><b>${typeof n === 'number' ? signed(n) : esc(n)}</b></div>`;
const list = (xs) => xs.map((x) => `${esc(x.label)} ${signed(x.n)}`).join(', ');

/** The stack bonus, term by term: HTML rows. `bonus` from combat.stackBonus. */
function bonusRows(bonus, vsEnemy) {
  const out = [];
  for (const t of bonus.terms) {
    if (!t.mine.length && !t.theirs.length && !t.walls) continue;
    const why = [];
    if (t.mine.length) why.push(list(t.mine));
    if (t.walls) why.push(`city walls +${t.walls}`);
    if (t.theirs.length) why.push(`enemy ${TERM_NAMES[t.vs]}: ${list(t.theirs.map((x) => ({ ...x, n: -x.n })))}`);
    const cap = t.raw !== t.n ? ` → ${t.raw > t.n ? 'max +5' : 'min −1'}` : '';
    out.push(row(TERM_NAMES[t.k], t.n), `<div class="why">${why.join(' · ')}${t.raw !== t.n ? ` = ${signed(t.raw)}${cap}` : ''}</div>`);
  }
  if (!out.length) out.push(`<div class="why">No leadership, morale or fortify${vsEnemy ? ', and no enemy chaos, fear or siege' : ''}.</div>`);
  const cap = bonus.raw !== bonus.total ? ` (${signed(bonus.raw)}, ${bonus.raw > bonus.total ? 'max +5' : 'min −3'})` : '';
  out.push(row(`Stack bonus${cap}`, bonus.total, 'sum'));
  return out.join('');
}

/**
 * HTML explaining one army's strength. b: { str, hits, parts, bonus, notes } (battleStrength,
 * or a battle snapshot with its side's stack bonus); head: title line; foot: extra lines.
 */
export function strengthHtml(u, b, { head = null, foot = [], vsEnemy = true } = {}) {
  const s = unitStats(u);
  const out = [`<div class="t">${esc(unitName(u))}</div>`,
    `<div class="dim">${esc(u.hero ? `${typeName(u)} level ${u.hero.level}` : typeName(u))}${head ? ` · ${esc(head)}` : ''}</div>`,
    '<div class="sec">Own strength</div>',
    ...b.parts.map((p, i) => row(p.label, i === 0 ? String(p.n) : p.n)),
    '<div class="sec">Stack bonus (to every army of the side)</div>',
    bonusRows(b.bonus, vsEnemy),
    ...b.notes.map((n) => row(n.label, n.n)),
    row('Battle strength', String(b.str), 'total'),
    `<div class="why">Hits ${b.hits}${b.hits !== s.hits ? ` (${s.hits} ${signed(b.hits - s.hits)} from the stack's heroes)` : ''}. Each round both sides roll a die; a roll at or under strength strikes.</div>`];
  if (!u.hero && u.medals) out.push(`<div class="why">🎖 ×${u.medals}: rolls a second 1–${MEDAL_DIE[Math.min(4, u.medals)]} die and keeps the better roll.</div>`);
  out.push(...foot.map((f) => `<div class="why">${f}</div>`));
  return out.join('');
}

/**
 * Tip for an army on the map: its strength if attacked where it stands (own stack only, so
 * before any enemy chaos, fear or siege), and when it attacks with `group`.
 */
export function mapStrengthHtml(u, defenders, group, ctx) {
  const def = battleStrength(u, defenders, [], ctx, 'def');
  const foot = [];
  if (group.includes(u)) {
    const att = battleStrength(u, group, [], { attSea: ctx.defSea, attBoat: ctx.defBoat }, 'att');
    const home = [...unitStats(u).bonus].filter((k) => k !== 'fly');
    foot.push(`<b>Attacking</b> with the selected group: <b>${att.str}</b> (stack bonus ${signed(att.bonus.total)}, no walls)${home.length ? `, +1 on ${home.join(' / ')} (the defender's square)` : ''}.`);
  }
  foot.push('Enemy chaos, fear and siege lower the matching term (each term down to −1 at worst).');
  return strengthHtml(u, def, { head: 'if attacked here', foot, vsEnemy: false });
}

let box = null, owner = null, raf = 0;
function place(el) {
  const r = el.getBoundingClientRect(), b = box.getBoundingClientRect(), m = 10;
  let x = r.left - b.width - m;
  if (x < m) x = r.right + m;
  if (x + b.width > innerWidth - m) x = Math.max(m, innerWidth - b.width - m);
  const y = Math.min(Math.max(m, r.top), innerHeight - b.height - m);
  box.style.left = `${x}px`; box.style.top = `${y}px`;
}
function hide() { box?.classList.remove('visible'); owner = null; cancelAnimationFrame(raf); }
/** Shows `html()` beside `el` while the pointer is over it (hides by itself if el goes away). */
export function hoverTip(el, html) {
  el.addEventListener('mouseenter', () => {
    box ??= document.body.appendChild(h('div#strtip.frame'));
    box.innerHTML = html();
    box.classList.add('visible');
    owner = el;
    place(el);
    const watch = () => { if (owner !== el) return; if (!el.isConnected) { hide(); return; } raf = requestAnimationFrame(watch); };
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(watch);
  });
  el.addEventListener('mouseleave', () => { if (owner === el) hide(); });
  return el;
}
