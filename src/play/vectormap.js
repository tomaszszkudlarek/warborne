// The vectoring map: the strategic minimap blown up in a dialog, with the viewer's cities as
// nodes and each city's vectoring as an arrow. Drag from a city to another of yours to send its
// new armies there; drag off into the land (or right-click the city) to keep them at home.
import { h } from './dom.js';
import { SIDES } from '../game/data/sides.js';
import { UNITS } from '../game/data/units.js';

const NODE = 7; // city node radius, CSS px
const ARROW = '#ffd66b';

/**
 * opts: { focus (city to ring), mode: 'production' (drag sets city vectors) | 'group' (pick a
 * target for a group leaving `focus`), onPick(city) for group mode, onChange() after a vector
 * changes, maxW, maxH (CSS px) }. Returns the element; it animates while in the document.
 */
export function vectorMap(ctl, opts = {}) {
  const g = ctl.game, mm = ctl.hud.minimap, viewer = ctl.viewer;
  const mode = opts.mode ?? 'production';
  const edit = ctl.human && (mode === 'group' || opts.focus == null || opts.focus.owner === viewer);
  const maxW = opts.maxW ?? 600, maxH = opts.maxH ?? 380;
  const k = Math.min(maxW / g.W, maxH / g.H);
  const cssW = Math.round(g.W * k), cssH = Math.round(g.H * k);
  const dpr = Math.min(2, devicePixelRatio || 1);
  const canvas = h('canvas.vecmap', { width: Math.round(cssW * dpr), height: Math.round(cssH * dpr), style: { width: `${cssW}px`, height: `${cssH}px` } });
  const tip = h('div.vectip');
  const wrap = h('div.vecwrap', { style: { width: `${cssW}px` } }, canvas, tip);
  const ctx = canvas.getContext('2d');

  // a city's centre in CSS px (the castle's 2×2 block starts at its tile)
  const at = (c) => { const [x, y] = g.tileXY(c.t); return [(x + 1) * k, (y + 1) * k]; };
  const mine = () => g.citiesOf(viewer).filter((c) => !c.razed);
  const cityAtPx = (px, py, pool = mine()) => {
    let best = null, bd = (NODE + 5) ** 2;
    for (const c of pool) { const [x, y] = at(c); const d = (x - px) ** 2 + (y - py) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  };
  const canDragFrom = (c) => edit && c && (mode === 'group' ? c === opts.focus : true);

  let hover = null, drag = null; // drag: { from, x, y, moved }
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (cssW / r.width), (e.clientY - r.top) * (cssH / r.height)]; };

  const commit = (from, to) => {
    if (mode === 'group') { if (to && to !== from) opts.onPick?.(to); return; }
    const next = to && to !== from ? to : null;
    if ((from.vector ?? null) === (next?.id ?? null)) return;
    g.setVector(from, next);
    opts.onChange?.();
  };

  canvas.addEventListener('pointerdown', (e) => {
    const [x, y] = pos(e);
    const c = cityAtPx(x, y);
    if (e.button === 2) { if (mode === 'production' && edit && c && c.vector != null) commit(c, null); return; }
    if (e.button !== 0) return;
    if (canDragFrom(c)) { drag = { from: c, x, y, sx: x, sy: y, moved: false }; canvas.setPointerCapture(e.pointerId); }
    else if (mode === 'group' && edit && c && c !== opts.focus) opts.onPick?.(c); // a click on the target does too
  });
  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pos(e);
    hover = cityAtPx(x, y);
    if (drag) { drag.x = x; drag.y = y; if (Math.hypot(x - drag.sx, y - drag.sy) > 6) drag.moved = true; }
    canvas.style.cursor = drag ? 'grabbing' : canDragFrom(hover) ? 'grab' : hover && mode === 'group' && edit ? 'pointer' : 'default';
    showTip(x, y);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const [x, y] = pos(e);
    const d = drag; drag = null;
    if (d.moved) commit(d.from, cityAtPx(x, y));
    canvas.style.cursor = 'grab';
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; tip.style.display = 'none'; } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const turnsText = (a, b) => `${g.vectorTurns(a, b)} turn${g.vectorTurns(a, b) > 1 ? 's' : ''}`;
  function showTip(x, y) {
    const c = drag ? (drag.moved ? cityAtPx(drag.x, drag.y) : drag.from) : hover;
    let text = '';
    if (drag?.moved) {
      if (c && c !== drag.from) text = `${drag.from.name} ➶ ${c.name} · ${turnsText(drag.from, c)}`;
      else text = mode === 'group' ? 'Drop on one of your cities' : `${drag.from.name}: new armies stay home`;
    } else if (c) {
      const to = c.vector != null ? g.s.cities[c.vector] : null;
      const prod = c.producing ? UNITS[c.producing].name : 'idle';
      text = `${c.capital ? '♛ ' : ''}${c.name} · ${prod}${to ? ` ➶ ${to.name}` : ''}`;
      if (mode === 'group' && opts.focus && c !== opts.focus) text = `Send the group to ${c.name} · ${turnsText(opts.focus, c)}`;
    }
    if (!text) { tip.style.display = 'none'; return; }
    tip.textContent = text;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(cssW - 8, x + 14)}px`;
    tip.style.top = `${y + 14}px`;
    tip.style.transform = x > cssW * 0.6 ? 'translateX(-100%)' : 'none';
  }

  // --- drawing -------------------------------------------------------------------------------------------
  /** A bowed arrow from a to b, stopping short of both nodes; returns its midpoint. */
  function arrow(ax, ay, bx, by, { color = ARROW, width = 2.5, alpha = 1, dash = null, t = 0 } = {}) {
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    if (L < NODE * 2.5) return null;
    const nx = -dy / L, ny = dx / L, bow = Math.min(40, L * 0.14);
    const cx = (ax + bx) / 2 + nx * bow, cy = (ay + by) / 2 + ny * bow;
    // trim both ends to the node rims along the curve's end tangents
    const trim = (px, py, qx, qy, r) => { const l = Math.hypot(qx - px, qy - py) || 1; return [px + ((qx - px) / l) * r, py + ((qy - py) / l) * r]; };
    const [sx, sy] = trim(ax, ay, cx, cy, NODE + 2);
    const [ex, ey] = trim(bx, by, cx, cy, NODE + 3);
    const head = 5 + width * 1.6;
    const ang = Math.atan2(ey - cy, ex - cx);
    const [lx, ly] = [ex - Math.cos(ang) * head * 0.8, ey - Math.sin(ang) * head * 0.8];
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.lineCap = 'round';
    for (const [col, w] of [['rgba(10,7,4,0.85)', width + 3], [color, width]]) {
      ctx.strokeStyle = col; ctx.lineWidth = w;
      ctx.setLineDash(dash && col === color ? dash : []);
      ctx.lineDashOffset = -t;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, lx, ly); ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.45) * head, ey - Math.sin(ang - 0.45) * head);
    ctx.lineTo(ex - Math.cos(ang + 0.45) * head, ey - Math.sin(ang + 0.45) * head);
    ctx.closePath();
    ctx.fillStyle = color; ctx.strokeStyle = 'rgba(10,7,4,0.85)'; ctx.lineWidth = 1.5;
    ctx.stroke(); ctx.fill();
    ctx.restore();
    return { mx: 0.25 * sx + 0.5 * cx + 0.25 * ex, my: 0.25 * sy + 0.5 * cy + 0.25 * ey, curve: [sx, sy, cx, cy, ex, ey] };
  }
  const onCurve = ([sx, sy, cx, cy, ex, ey], f) => [(1 - f) ** 2 * sx + 2 * (1 - f) * f * cx + f * f * ex, (1 - f) ** 2 * sy + 2 * (1 - f) * f * cy + f * f * ey];

  function label(text, x, y, color = '#f1e7cf', size = 11) {
    ctx.font = `600 ${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(8,6,4,0.9)';
    ctx.strokeText(text, x, y); ctx.fillStyle = color; ctx.fillText(text, x, y);
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mm.base, 0, 0, cssW, cssH);
    mm._updateFog?.();
    if (mm.fogReady) ctx.drawImage(mm.fog, 0, 0, cssW, cssH);
    ctx.fillStyle = 'rgba(12,9,6,0.38)'; // hush the land so the network reads
    ctx.fillRect(0, 0, cssW, cssH);
    const ex = mm.fogReady ? g.explored(viewer) : null;
    const t = (now / 40) % 1000;

    // other sides' cities: small plain blocks
    for (const c of g.s.cities) {
      if (c.owner === viewer && !c.razed) continue;
      if (ex && !c.tiles.some((i) => ex[i])) continue;
      const [x, y] = at(c);
      ctx.fillStyle = '#000'; ctx.fillRect(x - 4, y - 4, 8, 8);
      ctx.fillStyle = c.razed ? '#3a3530' : c.owner >= 0 ? SIDES[c.owner].color : '#9a9a9a';
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }

    const cities = mine();
    const focus = opts.focus;
    // names (under the arrows, so a line is never hidden by a label): the focus, the hovered and dragged-to cities, and where the focus sends to
    const target = drag?.moved ? cityAtPx(drag.x, drag.y) : null;
    const named = new Set([focus, hover, target, drag?.from, focus?.vector != null ? g.s.cities[focus.vector] : null].filter(Boolean));
    if (cities.length <= 8) for (const c of cities) named.add(c);
    for (const c of named) {
      if (c.owner !== viewer) continue;
      const [x, y] = at(c);
      label(c.name, x, y + NODE + 9, c === focus ? '#ffe39a' : '#f1e7cf');
    }
    // standing vectors
    const mids = [];
    for (const c of cities) {
      if (c.vector == null) continue;
      const to = g.s.cities[c.vector];
      if (drag?.moved && drag.from === c && mode === 'production') continue; // being redrawn
      const [ax, ay] = at(c), [bx, by] = at(to);
      const hot = !focus || c === focus || to === focus || c === hover;
      const m = arrow(ax, ay, bx, by, { width: hot ? 2.6 : 1.8, alpha: hot ? 1 : 0.55, dash: [7, 5], t });
      if (m && g.s.options.timedVectoring && hot) mids.push([String(g.vectorTurns(c, to)), m.mx, m.my]);
    }
    // armies on the road: a pip part-way along their line
    for (const v of g.s.pending) {
      if (v.owner !== viewer || v.from == null) continue;
      const a = g.s.cities[v.from], b = g.s.cities[v.city];
      const total = g.vectorTurns(a, b);
      const f = Math.max(0.05, Math.min(0.95, 1 - (v.round - g.s.round) / total));
      const m = arrow(...at(a), ...at(b), { color: 'rgba(255,255,255,0.55)', width: 1.2, alpha: 0.7, dash: [2, 4] });
      if (!m) continue;
      const [px, py] = onCurve(m.curve, f);
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, py - 5); ctx.lineTo(px + 5, py); ctx.lineTo(px, py + 5); ctx.lineTo(px - 5, py); ctx.closePath(); ctx.stroke(); ctx.fill();
      if (v.units.length > 1) label(String(v.units.length), px, py - 10, '#fff', 10);
    }
    // the arrow being dragged
    if (drag?.moved) {
      const to = cityAtPx(drag.x, drag.y);
      const [ax, ay] = at(drag.from);
      if (to && to !== drag.from) { const m = arrow(ax, ay, ...at(to), { width: 3, color: '#fff2b8' }); if (m) mids.push([turnsText(drag.from, to), m.mx, m.my]); }
      else {
        ctx.save(); ctx.strokeStyle = 'rgba(255,240,200,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(drag.x, drag.y); ctx.stroke(); ctx.restore();
        label(mode === 'group' ? '?' : '✕', drag.x, drag.y - 10, mode === 'group' ? '#fff' : '#ff8a6a', 13);
      }
    }
    for (const [s, x, y] of mids) {
      ctx.font = '700 10px Inter, system-ui, sans-serif';
      const w = ctx.measureText(s).width + 8;
      ctx.fillStyle = 'rgba(20,15,10,0.9)'; ctx.strokeStyle = ARROW; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - 7, w, 14, 7); ctx.fill(); ctx.stroke();
      label(s, x, y + 0.5, ARROW, 10);
    }

    // the viewer's cities: round nodes; hollow when training nothing
    const col = SIDES[viewer]?.color ?? '#ccc';
    for (const c of cities) {
      const [x, y] = at(c);
      const lit = c === hover || c === target || (drag && c === drag.from);
      if (c === focus) {
        const p = 0.5 + 0.5 * Math.sin(now / 260);
        ctx.strokeStyle = `rgba(255,227,154,${0.5 + 0.5 * p})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, NODE + 4 + p * 2, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(x, y, NODE + (lit ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = '#0c0906'; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, NODE - 1.5 + (lit ? 1.5 : 0), 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
      if (!c.producing) { ctx.beginPath(); ctx.arc(x, y, NODE - 4, 0, Math.PI * 2); ctx.fillStyle = '#0c0906'; ctx.fill(); }
      else if (c.capital) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, Math.PI * 2); ctx.fillStyle = '#fff6d8'; ctx.fill(); }
      if (lit) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, NODE + 1.5, 0, Math.PI * 2); ctx.stroke(); }
    }
  }

  const tick = (now) => {
    if (!wrap.isConnected && wrap.dataset.started) return;
    if (wrap.isConnected) { wrap.dataset.started = '1'; draw(now); }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return wrap;
}

/** How to work the map, for the line under it. */
export function vectorHelp(mode) {
  return mode === 'group'
    ? 'Drag from the ringed city to another of yours — or click it — to send the group there.'
    : 'Drag from a city to another of yours to send its new armies there. Drag into open land, or right-click a city, to keep them at home. Hollow cities train nothing.';
}
