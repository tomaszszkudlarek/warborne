// Small DOM helpers for the game interface: element builder, modal dialogs that resolve a
// promise, toasts and banners.

/** h('div.card.sel', { onclick, style: {...}, title }, children...) */
export function h(sel, attrs = {}, ...children) {
  const [head, ...classes] = sel.split('.');
  const [tag, id] = head.split('#');
  const el = document.createElement(tag || 'div');
  if (id) el.id = id;
  if (classes.length) el.className = classes.join(' ');
  if (attrs != null && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'vars') for (const [n, x] of Object.entries(v)) el.style.setProperty(n, x);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'class') el.className += ' ' + v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const root = () => document.getElementById('dialogs');
const stack = [];

/**
 * Opens a modal dialog. build(close) returns its content; close(value) resolves the promise.
 * opts: { cls, dismiss (value on scrim click / Esc; undefined = not dismissable), wide }
 */
export function dialog(build, opts = {}) {
  return new Promise((resolve) => {
    const scrim = h('div.scrim');
    const box = h('div.dialog.frame' + (opts.cls ? '.' + opts.cls : ''));
    if (opts.width) box.style.width = opts.width;
    let done = false;
    const close = (v) => {
      if (done) return;
      done = true;
      scrim.remove(); box.remove();
      stack.splice(stack.indexOf(entry), 1);
      resolve(v);
    };
    const entry = { close, dismiss: opts.dismiss };
    if ('dismiss' in opts) {
      scrim.addEventListener('click', () => close(opts.dismiss));
      box.append(h('button.close', { onclick: () => close(opts.dismiss), title: 'Close (Esc)' }, '×'));
    }
    const content = build(close, box);
    if (content) box.append(...[content].flat());
    root().append(scrim, box);
    stack.push(entry);
  });
}

export function dialogOpen() { return stack.length > 0; }
export function closeTopDialog() {
  const top = stack[stack.length - 1];
  if (top && 'dismiss' in top) { top.close(top.dismiss); return true; }
  return false;
}
export function closeAllDialogs() { for (const e of [...stack]) e.close(e.dismiss); }

/** Simple message box: resolves with the chosen button's value. */
export function ask(title, body, buttons = [{ label: 'OK', value: true, primary: true }], opts = {}) {
  return dialog((close) => [
    h('h2', title),
    typeof body === 'string' ? h('div.sub', { html: body }) : body,
    h('div.buttons', buttons.map((b) => h('button.btn' + (b.primary ? '.primary' : '') + (b.danger ? '.danger' : ''), { onclick: () => close(b.value), disabled: b.disabled }, b.label))),
  ], { dismiss: opts.dismiss ?? buttons[buttons.length - 1]?.value, ...opts });
}

export function toast(msg, cls = '', ms = 2600) {
  const box = document.getElementById('toast');
  const el = h('div.toastmsg.frame' + (cls ? '.' + cls : ''), { html: msg });
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function banner(title, sub = '') {
  const b = document.getElementById('banner');
  b.innerHTML = '';
  b.append(h('div.b', { html: `${title}${sub ? `<small>${sub}</small>` : ''}` }));
  setTimeout(() => { if (b.firstChild) b.firstChild.remove(); }, 2300);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A two-column key / value grid: kv('Strength', 4, 'Hits', 2, ...). */
export const kv = (...pairs) => h('div.kv', pairs.map((x) => (x instanceof Node ? x : h('span', String(x)))));

/** A unit type's (plural) name for one of them: "Trolls" → "Troll". */
export const singular = (name) => ({ Zombies: 'Zombie' }[name] ?? name.replace(/ae$/, 'a').replace(/(ch|sh)es$/, '$1').replace(/ies$/, 'y').replace(/([^s])s$/, '$1'));
export const withArticle = (name) => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;
