// The battle screen: plays back a combat log (game/combat.js) Warlords-style — both armies
// line up, fighters step forward one pair at a time, blows land, the fallen are struck off.
import { h, sleep, singular, withArticle } from './dom.js';
import { music } from './music.js';
import { SIDES } from '../game/data/sides.js';
import { UNITS } from '../game/data/units.js';
import { HERO_CLASSES } from '../game/data/heroes.js';

const SPECIAL = {
  missile: { icon: '🏹', text: 'Arrows!' },
  acid: { icon: '🧪', text: 'Acid!' },
  lightning: { icon: '⚡', text: 'Lightning!' },
  assassin: { icon: '🗡️', text: 'Assassinated!' },
};
const PACE = 1.5; // every beat of the playback takes this much longer (at speed ×1)
const STATUS = { poisoned: 'Poisoned', diseased: 'Diseased', paralysed: 'Paralysed', cursed: 'Cursed' };

/**
 * Shows a battle. opts: { portraits, background (image url), title, attName, defName,
 *   attOwner, defOwner, viewerSide: 'att' | 'def' | null (whose win is "Victory"), auto (close by itself),
 *   ruin (a hero's lone fight in a ruin: just the two in the dark, told as a tale — no army lines,
 *   strengths, hit pips or stack bonuses) }
 * battle: { result, att: units, def: units }. Resolves when closed.
 */
export function showBattle(battle, opts) {
  return new Promise((resolve) => {
    const { result } = battle;
    const P = opts.portraits;
    let speed = Number(localStorage.getItem('wl.battleSpeed') || 1);
    let skip = false, finished = false;
    const units = new Map([...battle.att.map((u) => [u.id, { u, side: 'att' }]), ...battle.def.map((u) => [u.id, { u, side: 'def' }])]);
    const start = result.log.find((e) => e.t === 'start');
    const snaps = new Map([...start.att, ...start.def].map((s) => [s.id, s]));
    const hp = new Map([...snaps.values()].map((s) => [s.id, s.hits]));
    const ownerOf = (id) => (units.get(id)?.side === 'att' ? opts.attOwner : opts.defOwner);
    const color = (o) => (o >= 0 ? SIDES[o]?.color ?? '#888' : '#8a8a8a');
    const ruin = !!opts.ruin;
    const nameOf = (u) => (u.hero ? `${u.hero.name}` : ruin ? singular(UNITS[u.type]?.name ?? u.type) : UNITS[u.type]?.name ?? u.type);
    const typeOf = (u) => (u.hero ? HERO_CLASSES[u.hero.cls].name : '');

    const pips = (id) => {
      if (ruin) return null;
      const max = snaps.get(id)?.hits ?? 1, cur = hp.get(id) ?? 0;
      return h('div.hp', Array.from({ length: max }, (_, i) => h('i' + (i >= cur ? '.gone' : ''))));
    };
    const cards = new Map();
    const card = (s) => {
      const { u } = units.get(s.id);
      const el = h('div.card', { vars: { '--c': color(ownerOf(s.id)) }, title: `${nameOf(u)} — strength ${s.str}, hits ${s.hits}` },
        h('img', { src: P.url(u.type, ownerOf(s.id)), draggable: 'false', 'data-type': u.type, 'data-owner': ownerOf(s.id) }), pips(s.id), h('div.str', s.str));
      cards.set(s.id, el);
      return el;
    };
    const line = (list) => h('div.line', [...list].map(card));
    const sparks = h('canvas.sparks');
    const duel = { att: null, def: null };
    // the viewer's side stands on the left, the enemy on the right
    const left = opts.viewerSide === 'def' ? 'def' : 'att';
    const right = left === 'att' ? 'def' : 'att';
    const ownerSide = (side) => (side === 'att' ? opts.attOwner : opts.defOwner);
    const slot = (side) => h('div.duelist', { vars: { '--c': color(ownerSide(side)) } });
    const dL = slot(left), dR = slot(right);
    const slotOf = { [left]: dL, [right]: dR };
    const arena = h('div.arena', dL, h('div.vs', ruin ? '⚔' : 'VS'), dR);
    const tale = h('div.tale');
    const tell = (text, cls = '') => { tale.className = 'tale' + (cls ? ' ' + cls : ''); tale.textContent = text; tale.style.animation = 'none'; void tale.offsetWidth; tale.style.animation = ''; };
    const oneOf = (u) => singular(UNITS[u.type]?.name ?? u.type);
    const bonus = (n) => (n > 0 ? `+${n}` : `${n}`);
    const speedBtn = h('button.btn', { onclick: () => { speed = speed >= 4 ? 1 : speed * 2; localStorage.setItem('wl.battleSpeed', speed); speedBtn.textContent = `Speed ×${speed}`; } }, `Speed ×${speed}`);
    const skipBtn = h('button.btn.primary', { onclick: () => { if (finished) close(); else skip = true; } }, 'Skip ⏭');
    const nameSide = (side) => (side === 'att' ? opts.attName : opts.defName);
    const role = (side) => {
      const r = side === 'att' ? 'Attacker' : 'Defender';
      if (!opts.viewerSide) return r;
      return side === opts.viewerSide ? `You · ${r.toLowerCase()}` : `Enemy · ${r.toLowerCase()}`;
    };
    const column = (side, cls) => h('div.side.' + cls,
      h('div.who', { style: { color: color(ownerSide(side)) } }, nameSide(side), h('small', `${role(side)} · stack bonus ${bonus(result.bonus[side])}`)),
      line(start[side]));
    const root = h('div#battle' + (ruin ? '.ruin' : ''),
      h('div.bg', { style: { backgroundImage: opts.background ? `url(${opts.background})` : 'none' } }),
      h('div.vign'), sparks,
      h('div.field',
        h('div.head', h('h1', opts.title ?? 'Battle')),
        ruin ? h('div.main', arena, tale) : h('div.main', column(left, 'l'), arena, column(right, 'r')),
        h('div.ctrl', speedBtn, skipBtn),
      ),
    );
    document.body.append(root);
    const ctx = sparks.getContext('2d');
    const parts = [];
    let raf = 0;
    const fit = () => { sparks.width = innerWidth; sparks.height = innerHeight; };
    fit();
    const tick = () => {
      ctx.clearRect(0, 0, sparks.width, sparks.height);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.life -= 1;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        const a = p.life / p.max;
        ctx.fillStyle = `rgba(${p.c[0]},${p.c[1]},${p.c[2]},${a})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (0.5 + a), 0, 6.283); ctx.fill();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const burst = (el, c = [255, 150, 40], n = 26) => {
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height * 0.45;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283, s = 2 + Math.random() * 7;
        parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 3, life: 30 + Math.random() * 25, max: 55, r: 1.5 + Math.random() * 2.5, c });
      }
    };
    const float = (el, text, cls = '') => {
      const r = el.getBoundingClientRect(), ar = arena.getBoundingClientRect();
      const f = h('div.float' + (cls ? '.' + cls : ''), text);
      f.style.left = `${r.left - ar.left + r.width / 2 - 20}px`;
      f.style.top = `${r.top - ar.top + 20}px`;
      arena.append(f);
      setTimeout(() => f.remove(), 950);
    };
    const fxIcon = (el, icon) => {
      const r = el.getBoundingClientRect(), ar = arena.getBoundingClientRect();
      const f = h('div.fxicon', icon);
      f.style.left = `${r.left - ar.left + r.width / 2 - 30}px`;
      f.style.top = `${r.top - ar.top + 60}px`;
      arena.append(f);
      setTimeout(() => f.remove(), 850);
    };
    const setDuelist = (el, id) => {
      el.innerHTML = '';
      if (id == null) return;
      const { u } = units.get(id);
      const s = snaps.get(id);
      el.append(...[h('img', { src: P.url(u.type, ownerOf(id)), draggable: 'false', 'data-type': u.type, 'data-owner': ownerOf(id) }), ruin ? null : h('div.st', `⚔ ${s.str}`), pips(id), h('div.nm', nameOf(u), typeOf(u) ? h('div.dim', { style: { fontSize: '11px', fontWeight: 500 } }, typeOf(u)) : null)].filter(Boolean));
      el.classList.remove('dying');
      for (const [cid, c] of cards) c.classList.toggle('active', cid === duel.att || cid === duel.def);
    };
    // a notch slower than it used to be: easier to follow who strikes whom
    const wait = (ms) => (skip ? Promise.resolve() : sleep((ms * PACE) / speed));
    const duelEl = (id) => (id === duel.att ? slotOf.att : id === duel.def ? slotOf.def : null);
    const refreshPips = (id) => {
      if (ruin) return;
      const c = cards.get(id);
      c?.querySelector('.hp')?.replaceWith(pips(id));
      const d = duelEl(id);
      d?.querySelector('.hp')?.replaceWith(pips(id));
    };

    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      cancelAnimationFrame(raf);
      music.stopSfx('fight');
      removeEventListener('keydown', onKey, true);
      root.remove();
      resolve();
    }

    (async () => {
      await wait(500);
      for (const e of result.log) {
        if (closed) return;
        switch (e.t) {
          case 'status': {
            const c = cards.get(e.id);
            if (c) { c.classList.add('hit'); setTimeout(() => c.classList.remove('hit'), 300); }
            if (!skip && c) { float(arena, `${STATUS[e.effect]}!`, 'special'); await wait(350); }
            break;
          }
          case 'duel': {
            duel.att = e.a; duel.def = e.d;
            setDuelist(slotOf.att, e.a); setDuelist(slotOf.def, e.d);
            if (ruin) {
              const foes = start.def.length, i = start.def.findIndex((x) => x.id === e.d);
              const who = withArticle(oneOf(units.get(e.d).u));
              tell(i === 0 ? `Out of the dark comes ${who}!` : `${i + 1 < foes ? 'Another' : 'The last'} one — ${who}!`);
            }
            if (!skip) music.sfx('fight');
            await wait(650);
            break;
          }
          case 'special': {
            const by = duelEl(e.by) ?? arena, on = duelEl(e.on) ?? arena;
            if (!skip) {
              fxIcon(on, SPECIAL[e.kind].icon);
              if (e.hit) float(on, SPECIAL[e.kind].text, 'special');
              burst(on, e.kind === 'acid' ? [120, 255, 80] : e.kind === 'lightning' ? [140, 180, 255] : [255, 220, 120], 30);
            }
            void by;
            await wait(e.hit ? 750 : 350);
            break;
          }
          case 'hit': {
            hp.set(e.id, e.hp);
            const tgt = duelEl(e.id), src = e.by != null ? duelEl(e.by) : null;
            if (!skip) {
              if (src) { src.classList.add(src === dL ? 'strike-l' : 'strike-r'); setTimeout(() => src.classList.remove('strike-l', 'strike-r'), 150); }
              if (tgt) {
                tgt.classList.remove('hit'); void tgt.offsetWidth; tgt.classList.add('hit');
                if (!ruin) float(tgt, `−${e.dmg ?? 1}`);
                burst(tgt);
              }
            }
            refreshPips(e.id);
            await wait(420);
            break;
          }
          case 'die': {
            hp.set(e.id, 0);
            refreshPips(e.id);
            const d = duelEl(e.id);
            if (d) d.classList.add('dying');
            if (d && !skip) burst(d, [255, 60, 30], 50);
            if (ruin) {
              const u = units.get(e.id)?.u;
              if (u?.hero) tell(`${u.hero.name} falls…`, 'lose');
              else if (u) tell(`The ${oneOf(u)} is slain!`);
            }
            cards.get(e.id)?.classList.add('dead');
            if (!skip) { music.stopSfx('fight'); music.sfx('lost'); }
            await wait(700);
            break;
          }
          case 'end': {
            for (const c of cards.values()) c.classList.remove('active');
            const won = opts.viewerSide ? e.winner === opts.viewerSide : e.winner === 'att';
            const txt = ruin ? (won ? 'Victory!' : 'Fallen') : opts.viewerSide ? (won ? 'Victory!' : 'Defeat') : `${e.winner === 'att' ? opts.attName : opts.defName} win`;
            if (ruin && won) tell('The ruin is cleared — its treasure awaits.', 'win');
            arena.append(h('div.result.' + (won || !opts.viewerSide ? 'win' : 'lose'), txt));
            finished = true;
            skipBtn.textContent = 'Continue ▶';
            if (opts.auto) { await sleep(skip ? 500 : 1400); close(); }
            break;
          }
        }
      }
    })();
    const onKey = (ev) => {
      if (ev.code === 'Escape' || ev.code === 'Space' || ev.code === 'Enter') {
        ev.preventDefault();
        if (finished) close(); else skip = true;
      }
    };
    addEventListener('keydown', onKey, true);
  });
}
