import { h } from './dom.js';

// "Level up!" — a golden burst across the screen when one of the player's heroes rises a
// level: rays, sparks, the hero's portrait, the new title and the ability points to spend.
// Several in a row show one after another; a click dismisses one early.
const SHOW_MS = 3600;
let chain = Promise.resolve();

/** { name, level, title, ap, cls, portrait (url), color (side colour) } */
export function levelUpShow(info) {
  chain = chain.then(() => showOne(info));
  return chain;
}

function showOne({ name, level, title, ap, cls, portrait, color }) {
  return new Promise((resolve) => {
    const sparks = Array.from({ length: 26 }, (_, i) => h('i.spark', { vars: { '--a': `${(i / 26) * 360 + Math.random() * 10}deg`, '--d': `${120 + Math.random() * 140}px`, '--t': `${0.9 + Math.random() * 0.9}s`, '--w': `${0.1 + Math.random() * 0.5}s` } }));
    const el = h('div.levelup', { vars: { '--c': color ?? '#e0b95e' } },
      h('div.lu-rays'),
      h('div.lu-sparks', sparks),
      h('div.lu-card',
        h('div.lu-ring', h('img', { src: portrait, alt: '' })),
        h('div.lu-head', 'Level up!'),
        h('div.lu-level', `Level ${level}`),
        h('div.lu-name', name),
        h('div.lu-title', title ? `${title} · ${cls}` : cls),
        ap ? h('div.lu-ap', `+${ap} ability point${ap === 1 ? '' : 's'} — spend them in the hero screen (H)`) : null));
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      el.classList.add('out');
      setTimeout(() => { el.remove(); resolve(); }, 450);
    };
    el.addEventListener('click', close);
    document.body.append(el);
    setTimeout(close, SHOW_MS);
  });
}
