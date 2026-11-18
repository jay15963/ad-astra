// Minimal DOM for UI render tests in Node (no layout): enough for components.h / raw / card / chip / bar / button
// and the screens built on them. install() sets globalThis.document/Node/window/requestAnimationFrame once.
// Text of an element = its text nodes + the raw HTML (tags stripped) set through innerHTML.

class Node {
  constructor() { this.childNodes = []; this.parentNode = null; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes = [new Text(String(v ?? ''))]; }
  appendChild(c) {
    if (c instanceof Fragment) { for (const k of [...c.childNodes]) this.appendChild(k); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c); return c;
  }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  append(...cs) { for (const c of cs) this.appendChild(c instanceof Node ? c : new Text(String(c))); }
  prepend(...cs) { for (const c of cs.reverse()) { const n = c instanceof Node ? c : new Text(String(c)); if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.unshift(n); } }
  insertBefore(c, ref) { const i = ref ? this.childNodes.indexOf(ref) : -1; if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); return c; }
  remove() { this.parentNode?.removeChild(this); }
}
class Text extends Node {
  constructor(t) { super(); this.data = t; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}
class Fragment extends Node {}

class ClassList {
  constructor(el) { this.el = el; }
  get list() { return String(this.el.className || '').split(/\s+/).filter(Boolean); }
  add(...c) { this.el.className = [...new Set([...this.list, ...c])].join(' '); }
  remove(...c) { this.el.className = this.list.filter((x) => !c.includes(x)).join(' '); }
  contains(c) { return this.list.includes(c); }
  toggle(c, on) { const has = this.contains(c); const want = on ?? !has; if (want) this.add(c); else this.remove(c); return want; }
}

class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = String(tag).toUpperCase(); this.attributes = {}; this.className = ''; this.style = {}; this.dataset = {};
    this.listeners = {}; this.rawHTML = ''; this.disabled = false; this.value = ''; this.open = false;
    this.classList = new ClassList(this);
  }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'disabled') this.disabled = true; if (k === 'value') this.value = String(v); if (k === 'open') this.open = true; }
  getAttribute(k) { return k === 'class' ? this.className : this.attributes[k] ?? null; }
  hasAttribute(k) { return k in this.attributes; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
  removeEventListener(t, fn) { this.listeners[t] = (this.listeners[t] || []).filter((f) => f !== fn); }
  dispatch(t, ev = {}) { for (const fn of this.listeners[t] || []) fn({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...ev }); }
  click() { if (!this.disabled) this.dispatch('click'); }
  set innerHTML(v) { this.childNodes = []; this.rawHTML = String(v ?? ''); }
  get innerHTML() { return this.rawHTML; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join('') + this.rawHTML.replace(/<[^>]*>/g, ''); }
  set textContent(v) { this.rawHTML = ''; this.childNodes = [new Text(String(v ?? ''))]; }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  get childElementCount() { return this.children.length; }
  get firstChild() { return this.childNodes[0] || null; }
  focus() {} blur() {} scrollIntoView() {}
  getContext() { return null; }
  matches(sel) { return matchSimple(this, sel); }
  closest(sel) { let e = this; while (e) { if (e instanceof Element && matchSimple(e, sel)) return e; e = e.parentNode; } return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (sel.split(',').some((s) => matchSimple(c, s.trim()))) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** tag, .class, tag.class.class, [attr], [attr="v"] (one compound selector, no combinators). */
function matchSimple(el, sel) {
  const m = String(sel).match(/^([a-z0-9-]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const cls = m[2] ? m[2].split('.').filter(Boolean) : [];
  for (const c of cls) if (!el.classList.contains(c)) return false;
  for (const a of m[3].match(/\[[^\]]+\]/g) || []) {
    const [, k, v] = a.match(/^\[([\w-]+)(?:="?([^"]*)"?)?\]$/) || [];
    if (!k) return false;
    const val = k === 'class' ? el.className : el.attributes[k];
    if (val == null) return false;
    if (v != null && String(val) !== v) return false;
  }
  return true;
}

export function install() {
  if (globalThis.__domShim) return globalThis.__domShim;
  const body = new Element('body');
  const head = new Element('head');
  const document = {
    body, head,
    createElement: (t) => new Element(t),
    createTextNode: (t) => new Text(t),
    createDocumentFragment: () => new Fragment(),
    getElementById: (id) => body.querySelectorAll(`[id="${id}"]`)[0] || head.querySelectorAll(`[id="${id}"]`)[0] || null,
    querySelector: (s) => head.querySelector(s) || body.querySelector(s),
    querySelectorAll: (s) => [...head.querySelectorAll(s), ...body.querySelectorAll(s)],
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.document = document;
  globalThis.Node = Node;
  globalThis.Element = Element;
  globalThis.window = globalThis.window || { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false }) };
  globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 0));
  globalThis.__domShim = { document, Element, Node, Text };
  return globalThis.__domShim;
}

/** All text of a tree (for "no undefined/NaN" checks). */
export function textOf(el) { return el?.textContent || ''; }
/** Attribute values of a tree (aria-label, title, placeholder…), for the same checks. */
export function attrsOf(el) {
  const out = [];
  const walk = (n) => { if (n.attributes) out.push(...Object.values(n.attributes)); for (const c of n.children || []) walk(c); };
  walk(el);
  return out.join(' ');
}
