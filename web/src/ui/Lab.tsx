// @ts-nocheck
"use client";
/* Screen logic for the Claude Design layout (design/Pricing Lab.dc.html). It turns app state into
   the plain values the generated View renders. All numbers come from src/engine, which is
   type-checked and tested; this file only formats and arranges them. */
import { Component } from "react";
import { TOOL_LABEL } from "@/agent/tools";
import { bestThreshold, evaluateThresholds } from "@/engine/delivery";
import { optimizePrices, priceLines, simulatePrices, simulatePromo } from "@/engine/engine";
import { CALL_LABEL, deliveryVerdict, optimizerVerdict, priceVerdict, promoVerdict } from "@/engine/verdict";
import { F } from "./format";
import View from "./View";

const E = { simulatePrices, simulatePromo, optimizePrices, priceLines, evaluateThresholds, bestThreshold,
  priceVerdict, promoVerdict, optimizerVerdict, deliveryVerdict, CALL_LABEL };

/** One question in, one finished answer out. The tool loop runs on the server. */
async function askServer(code, question, history) {
  const res = await fetch("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, question, history }) });
  const data = await res.json().catch(() => ({ error: `The server answered ${res.status} with something unreadable.` }));
  if (!res.ok) { const err = new Error(data.error ?? `Request failed (${res.status}).`); err.status = res.status; err.reason = data.reason; throw err; }
  return data;
}

export default class Lab extends Component<object, any> {
  state = {
    askOff: false, index: null, models: {}, code: 'tna', tier: 'chain', tab: 'prices', loading: null, loadErr: null,
    priceMap: {}, weeks: 4, link: true,
    promo: { item: 0, depth: 20, weeks: 1, deal: 'advertised', funding: 0, wholeLine: true }, partHover: null,
    opt: { maxChange: 10, minMargin: 0, floor: 95, link: true, locked: [] }, optRes: null, optKey: '', optHints: null,
    dl: { avgBasket: 45, basketSpread: 0.6, marginPct: 0.28, deliveryCost: 6, fee: 4, reachPct: 0.25, topUp: [0.15, 0.35], extraOrders: [0.02, 0.1] },
    hover: {}, methodItem: 0, elHover: null, heatCell: null,
    msgs: [], askInput: '', askBusy: false, askNote: null, clearedFor: null,
  };

  componentDidMount() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('pricing-lab-ui') || 'null'); } catch (e) {}
    const code = (saved && saved.code) || 'tna';
    if (saved) this.setState({ tab: saved.tab || 'prices', code, tier: saved.tier || 'chain' });
    fetch('/api/ask').then(r => r.json()).then(d => this.setState({ askOff: !d.enabled })).catch(() => this.setState({ askOff: true }));
    this.getData('index').then(index => this.setState({ index })).catch(() => {});
    this.load(code);
  }
  componentDidUpdate() { this.scheduleOpt(); }
  componentWillUnmount() { clearTimeout(this._ot); }

  getData(code) {
    return fetch(`/data/${code}.json`).then(r => (r.ok ? r.json() : Promise.reject(new Error(`data/${code}.json answered ${r.status}`))));
  }
  load(code) {
    if (this.state.models[code]) return;
    this.setState({ loading: code, loadErr: null });
    this.getData(code)
      .then(m => this.setState(s => ({ models: { ...s.models, [code]: m }, loading: s.loading === code ? null : s.loading })))
      .catch(e => this.setState({ loading: null, loadErr: { code, msg: (e && e.message) || 'network error' } }));
  }
  save(p) { try { const s = { ...this.state, ...p }; localStorage.setItem('pricing-lab-ui', JSON.stringify({ tab: s.tab, code: s.code, tier: s.tier })); } catch (e) {} }
  model() { return this.state.models[this.state.code]; }
  setTab(tab) { this.setState({ tab }); this.save({ tab }); try { window.scrollTo(0, 0); } catch (e) {} }
  setCode(code) {
    if (code === this.state.code) return;
    const had = this.state.msgs.length > 0;
    this.setState(s => ({ code, promo: { ...s.promo, item: 0 }, opt: { ...s.opt, locked: [] }, methodItem: 0, msgs: [], askNote: null, clearedFor: had ? code : null, heatCell: null, elHover: null, hover: {}, partHover: null }));
    this.save({ code }); this.load(code);
  }
  memo(name, key, fn) { const m = this._m || (this._m = {}); if (m[name] && m[name].k === key) return m[name].v; const v = fn(); m[name] = { k: key, v }; return v; }

  optArgs(s) { return { tier: s.tier, maxChange: s.opt.maxChange / 100, minMargin: s.opt.minMargin / 100, revenueFloor: s.opt.floor / 100, locked: s.opt.locked, linkLines: s.opt.link }; }
  optKeyOf(s) { const o = s.opt; return [s.code, s.tier, o.maxChange, o.minMargin, o.floor, o.link, o.locked.slice().sort().join('.')].join('|'); }
  scheduleOpt() {
    const s = this.state, model = this.model();
    if (!model || s.tab !== 'best') return;
    const key = this.optKeyOf(s);
    if (key === s.optKey || key === this._pend) return;
    this._pend = key; clearTimeout(this._ot);
    this._ot = setTimeout(() => {
      const st = this.state, mdl = this.model(); if (!mdl) { this._pend = null; return; }
      const k2 = this.optKeyOf(st), args = this.optArgs(st);
      const r = E.optimizePrices(mdl, args);
      let hints = null;
      if (!r.feasible) hints = { floorOk: E.optimizePrices(mdl, { ...args, revenueFloor: 0.8 }).feasible };
      this._pend = null;
      this.setState({ optRes: r, optKey: k2, optHints: hints });
    }, 140);
  }

  move(i, value) {
    const model = this.model(), items = model.items, s = this.state;
    value = Math.max(0.01, Math.round(value * 100) / 100);
    const prices = [...(s.priceMap[s.code] || items.map(it => it.price))];
    const g = E.priceLines(model, s.link).find(x => x.includes(i)) || [i];
    const ratio = value / items[i].price;
    for (const j of g) prices[j] = Math.round(items[j].price * ratio * 100) / 100;
    prices[i] = value;
    this.setState(st => ({ priceMap: { ...st.priceMap, [st.code]: prices } }));
  }
  setPromo(p) { this.setState(s => ({ promo: { ...s.promo, ...p } })); }
  setOpt(p) { this.setState(s => ({ opt: { ...s.opt, ...p } })); }
  setDl(p) { this.setState(s => ({ dl: { ...s.dl, ...p } })); }
  setHover(name, i) { this.setState(s => (s.hover[name] === i ? null : { hover: { ...s.hover, [name]: i } })); }

  vd(v, title) {
    const M = { go: ['✓', '#1F7A4D', '#E6F2EA'], test: ['◐', '#8A5A00', '#FFF4D6'], hold: ['▽', '#A24A12', '#FCEADF'], stop: ['✕', '#B4361F', '#FBE5E0'] };
    const m = M[v.call] || ['•', '#5F6368', '#FFFFFF'];
    const label = v.call ? E.CALL_LABEL[v.call] : 'No change yet';
    return { glyph: m[0], fg: m[1], bg: m[2], label, title: title || (v.headline !== label ? v.headline : ''), reason: v.reason };
  }
  rb(s) {
    let lo = Math.min(s.p10, 0), hi = Math.max(s.p90, 0); const span = (hi - lo) || 1; lo -= span * 0.12; hi += span * 0.12;
    const P = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%';
    return { l: P(s.p10), w: ((s.p90 - s.p10) / (hi - lo) * 100).toFixed(2) + '%', m: P(s.p50), z: P(0) };
  }
  kpi(label, S, fmt, base) {
    return { label, mid: fmt(S.p50), lo: fmt(S.p10), hi: fmt(S.p90), base, arrow: F.arrow(S.p50, 0.5), color: F.tone(S.p50, 0.5), bar: this.rb(S), title: `Middle ${fmt(S.p50)}, 10th percentile ${fmt(S.p10)}, 90th percentile ${fmt(S.p90)}` };
  }
  seg(list, cur, set, sel = (a, b) => a === b) {
    return list.map(o => { const on = sel(o.v, cur); return { ...o, sel: on ? 'true' : 'false', bg: on ? '#16181D' : '#fff', fg: on ? '#fff' : '#16181D', border: on ? '#16181D' : '#E2E0DA', dot: on ? '#16181D' : '#fff', onClick: () => set(o.v) }; });
  }
  niceTicks(lo, hi, n = 4) {
    const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const step = [1, 2, 2.5, 5, 10].map(x => x * p).find(x => x >= raw) || p * 10;
    const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
    return out;
  }
  chart(name, n, series, opts) {
    const W = 640, H = opts.h, L = 58, R = 16, T = 14, B = opts.b;
    const all = series.flat().concat(opts.zero ? [0] : []);
    let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
    if (opts.floor0 && lo < 0 && Math.min(...series.flat()) >= 0) lo = 0;
    const X = i => L + (n <= 1 ? 0 : i * (W - L - R) / (n - 1));
    const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    const pts = arr => arr.map((v, i) => X(i).toFixed(1) + ',' + Y(v).toFixed(1)).join(' ');
    const yTicks = this.niceTicks(lo, hi).map(v => ({ y: Y(v).toFixed(1), ty: (Y(v) + 4).toFixed(1), label: opts.fy(v) }));
    const every = Math.ceil(n / (opts.maxX || 9));
    const xTicks = []; for (let i = 0; i < n; i += every) xTicks.push({ x: X(i).toFixed(1), label: opts.fx(i) });
    const pick = (e) => { const r = e.currentTarget.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width * W; const i = Math.max(0, Math.min(n - 1, Math.round((x - L) / ((W - L - R) / Math.max(1, n - 1))))); this.setHover(name, i); };
    const onKey = (e) => {
      const cur = this.state.hover[name] == null ? (opts.start || 0) : this.state.hover[name];
      if (e.key === 'ArrowRight') { e.preventDefault(); this.setHover(name, Math.min(n - 1, cur + 1)); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.setHover(name, Math.max(0, cur - 1)); }
      else if (e.key === 'Escape') this.setHover(name, null);
    };
    return { X, Y, pts, yTicks, xTicks, onMove: pick, onLeave: () => this.setHover(name, null), onKey, zeroY: Y(0).toFixed(1), hov: this.state.hover[name] };
  }

  describeCall(model, name, a) {
    const nm = i => (model.items[i] ? model.items[i].name : 'item ' + i);
    const TL = { chain: 'all stores', low: 'low-price zone', medium: 'medium-price zone', high: 'high-price zone' };
    const tier = TL[a.tier || 'chain'];
    if (name === 'simulate_price_change') return (a.changes || []).map(c => `${nm(c.item)} ${c.change_pct > 0 ? '+' : ''}${c.change_pct}%`).join(', ') + ` · 1 week · ${tier}`;
    if (name === 'simulate_promotion') { const D = { none: 'price cut only', bonus: 'shelf tag', advertised: 'advertised' }; const w = a.weeks || 1; return `${(a.items || []).map(nm).join(' + ')} · ${a.depth_pct}% off · ${w} week${w > 1 ? 's' : ''} · ${D[a.deal || 'advertised']} · supplier pays ${a.funding_pct || 0}% · ${tier}`; }
    return `moves up to ±${a.max_change_pct ?? 10}% · margin at least ${a.min_margin_pct ?? 0}% · revenue at least ${a.revenue_floor_pct ?? 0}% · ${tier}`;
  }
  patchMsg(id, p) { this.setState(s => ({ msgs: s.msgs.map(m => (m.id === id ? { ...m, ...p } : m)) })); }
  async ask(raw) {
    const q = String(raw ?? this.state.askInput).trim().slice(0, 400);
    if (!q || this.state.askBusy || this.state.askOff) return;
    const now = Date.now(); this._times = (this._times || []).filter(t => now - t < 60000);
    if (this._times.length >= 5) { const w = Math.ceil((60000 - (now - this._times[0])) / 1000); this.setState({ askNote: `Too many questions in a minute. Try again in ${w} seconds.` }); return; }
    this._times.push(now);
    const model = this.model(), code = this.state.code, id = now;
    const history = this.state.msgs.filter(m => m.status === 'done').slice(-3).flatMap(m => [{ role: 'user', content: m.q }, { role: 'assistant', content: m.answer }]);
    this.setState(s => ({ askBusy: true, askInput: '', askNote: null, clearedFor: null, msgs: [...s.msgs, { id, q, status: 'waiting', calls: [] }] }));
    const toCalls = steps => steps.map(st => {
      let args = {}; try { args = JSON.parse(st.args || '{}'); } catch (e) {}
      return { label: TOOL_LABEL[st.name] || st.name, detail: 'error' in st.result ? `Rejected: ${st.result.error}` : this.describeCall(model, st.name, args) };
    });
    try {
      const r = await askServer(code, q, history);
      if (this.state.code !== code) return;
      this.patchMsg(id, { status: 'done', answer: r.text, calls: toCalls(r.steps), checked: r.verification.checked, unsupported: r.verification.unsupported });
    } catch (e) {
      if (this.state.code !== code) return;
      const msg = String((e && e.message) || e);
      if (e && e.status === 503) { this.setState(s => ({ askOff: true, msgs: s.msgs.filter(m => m.id !== id) })); }
      else if (e && e.status === 429) { this.setState(s => ({ msgs: s.msgs.filter(m => m.id !== id), askNote: msg })); }
      else this.patchMsg(id, { status: 'failed', error: msg });
    } finally { this.setState({ askBusy: false }); }
  }

  renderVals() {
    const s = this.state;
    const INDEX = s.index || [{ code: 'tna', name: 'Canned tuna', medianApe: 0.179, medianApeNaive: 0.225 }, { code: 'bjc', name: 'Bottled juices', medianApe: 0.2, medianApeNaive: 0.372 }, { code: 'lnd', name: 'Laundry detergents', medianApe: 0.19, medianApeNaive: 0.581 }, { code: 'sdr', name: 'Soft drinks', medianApe: 0.685, medianApeNaive: 1.803 }];
    const TABS = [['prices', 'Change prices'], ['promo', 'Plan a promotion'], ['best', 'Find best prices'], ['delivery', 'Free delivery'], ['ask', 'Ask the Lab'], ['method', 'How it works']];
    const tabs = TABS.map(([id, label], i) => ({ label, num: String(i + 1), sel: s.tab === id ? 'true' : 'false', bg: s.tab === id ? '#F4F3EF' : 'transparent', fg: s.tab === id ? '#16181D' : '#C9CCD3', onClick: () => this.setTab(id) }));
    const cats = INDEX.map(r => { const weak = r.medianApe > 0.3, on = r.code === s.code; return { name: r.name, status: weak ? 'Direction only' : 'Forecast checked', glyph: weak ? '◐' : '✓', miss: 'typical miss ' + F.pct(r.medianApe), statusColor: weak ? '#8A5A00' : '#1F7A4D', sel: on ? 'true' : 'false', bg: on ? '#fff' : 'transparent', border: on ? '#16181D' : '#DCDAD3', onClick: () => this.setCode(r.code) }; });
    const TIERS = [['chain', 'All stores', 83], ['low', 'Low-price zone', 8], ['medium', 'Medium-price zone', 53], ['high', 'High-price zone', 22]];
    const row = INDEX.find(r => r.code === s.code) || INDEX[0];
    const weak = row.medianApe > 0.3;
    const model = this.model();
    const ready = !!model;
    const toolTab = ['prices', 'promo', 'best', 'ask'].includes(s.tab);
    const base = {
      tabs, cats, tier: s.tier, tierOpts: TIERS.map(t => ({ v: t[0], label: `${t[1]} · ${t[2]} stores` })),
      onTier: e => { const tier = e.target.value; this.setState({ tier }); this.save({ tier }); },
      showWeak: weak && toolTab,
      weakText: `${row.name} failed the forecast check: predictions for weeks the model never saw missed by ${F.pct(row.medianApe)} in a typical week. Read results as up or down, not as dollar amounts.`,
      goMethod: e => { e.preventDefault(); this.setTab('method'); },
      showLoading: s.tab !== 'delivery' && !ready && !s.loadErr, loadingText: `Loading ${row.name}…`,
      showError: s.tab !== 'delivery' && !!s.loadErr && !model,
      errorTitle: `Couldn't load ${row.name}`, errorText: `The category data didn't arrive (${s.loadErr ? s.loadErr.msg : ''}). Check your connection and try again, or pick another category.`,
      retryLoad: () => this.load(s.code), backToTuna: () => this.setCode('tna'),
      show: { prices: ready && s.tab === 'prices', promo: ready && s.tab === 'promo', best: ready && s.tab === 'best', delivery: s.tab === 'delivery', ask: ready && s.tab === 'ask', method: ready && s.tab === 'method' },
    };
    const out = { ...base, d: this.deliveryVals(), dv: null };
    out.dv = out.d.v;
    if (!model) return out;
    const items = model.items, k = items.length, hasLines = (model.lines || []).length > 0;

    // 1 Change prices
    if (s.tab === 'prices') {
      const prices = s.priceMap[s.code] || items.map(it => it.price);
      const pr = this.memo('pr', [s.code, s.tier, s.weeks, prices.join(',')].join('|'), () => E.simulatePrices(model, prices, s.tier, s.weeks));
      const changed = prices.some((p, i) => Math.abs(p - items[i].price) > 0.004);
      const H = [{ v: 1, label: '1 week' }, { v: 4, label: '4 weeks' }, { v: 13, label: 'A quarter' }, { v: 52, label: 'A year' }];
      const lines = E.priceLines(model, s.link);
      out.pv = this.vd(E.priceVerdict(pr, changed));
      out.p = {
        changed, empty: !changed, horizonLabel: H.find(h => h.v === s.weeks).label.toLowerCase(),
        hero: this.kpi('Profit', pr.delta.profit, F.sMoney, F.money(pr.baseline.profit.p50)),
        chance: F.pct(pr.probProfitUp), chanceSub: `Profit was higher in ${Math.round(pr.probProfitUp * 400)} of 400 runs`,
        kpis: [this.kpi('Revenue change', pr.delta.revenue, F.sMoney, F.money(pr.baseline.revenue.p50)), this.kpi('Units change', pr.delta.units, F.sCount, F.count(pr.baseline.units.p50) + ' units')],
        horizons: this.seg(H, s.weeks, v => this.setState({ weeks: v })),
        hasLines, link: s.link, toggleLink: e => this.setState({ link: e.target.checked }),
        reset: () => this.setState(st => ({ priceMap: { ...st.priceMap, [st.code]: items.map(it => it.price) } })),
        resetDisabled: !changed, resetBorder: changed ? '#16181D' : '#E2E0DA', resetColor: changed ? '#16181D' : '#A3A6AD',
        rows: items.map((it, i) => {
          const r = pr.items[i], moved = Math.abs(prices[i] - it.price) > 0.004, be = r.breakEvenUnitsChangePct, u = r.unitsChangePct.p50, pf = r.profitChange.p50;
          const note = !moved ? '—' : !isFinite(be) ? 'Sells below cost' : be < 0 ? `Can lose up to ${F.pct(-be)} of volume` : `Needs ${F.pct(be)} more volume`;
          return { name: it.name, price: F.price(prices[i]), bg: moved ? '#F5F7FD' : '#fff', weight: moved ? 600 : 400, units: `${F.arrow(u, 0.0005)} ${F.sPct(u)}`, unitsColor: F.tone(u, 0.0005), profit: `${F.arrow(pf, 0.5)} ${F.sMoney(pf)}`, profitColor: F.tone(pf, 0.5), note, noteColor: !isFinite(be) && moved ? '#B4361F' : '#16181D' };
        }),
        cards: items.map((it, i) => {
          const p = prices[i], lo = Math.floor(Math.min(it.priceMin, it.price * 0.75) * 100) / 100, hi = Math.ceil(Math.max(it.priceMax, it.price * 1.25) * 100) / 100;
          const pos = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%';
          const off = p < it.priceMin - 0.004 || p > it.priceMax + 0.004, moved = Math.abs(p - it.price) > 0.004, below = p <= it.cost, ch = p / it.price - 1;
          const grp = lines.find(g => g.includes(i)) || [i];
          return {
            name: it.name, price: F.price(p), was: F.price(it.price), cost: F.price(it.cost),
            chg: moved ? `${F.arrow(ch)} ${F.sPct(ch)}` : 'No change', chgColor: moved ? '#16181D' : '#5F6368',
            costLine: `Cost ${F.price(it.cost)} · Margin ${F.pct((p - it.cost) / p)}`,
            histLine: `charged ${F.price(it.priceMin)}–${F.price(it.priceMax)} in 2 yrs`, loStr: F.price(lo), hiStr: F.price(hi),
            lo, hi, value: p, bandL: pos(it.priceMin), bandW: ((it.priceMax - it.priceMin) / (hi - lo) * 100).toFixed(2) + '%', todayL: pos(it.price),
            off, below, linked: grp.length > 1, linkText: `Moves with ${grp.filter(j => j !== i).map(j => items[j].name).join(', ')}`,
            bg: below ? '#FFF8F6' : off ? '#FFFBEF' : '#fff', border: below ? '#B4361F' : off ? '#C99A2E' : moved ? '#16181D' : '#E2E0DA',
            minus: () => this.move(i, p - 0.01), plus: () => this.move(i, p + 0.01), slide: e => this.move(i, Number(e.target.value)),
            minusLabel: `Lower ${it.name} by 1 cent`, plusLabel: `Raise ${it.name} by 1 cent`, sliderLabel: `Price of ${it.name}`,
          };
        }),
      };
    }

    // 2 Promotion
    if (s.tab === 'promo') {
      const P = s.promo, item = Math.min(P.item, k - 1), line = (model.lines || []).find(g => g.includes(item));
      const promoItems = line && P.wholeLine ? line : [item];
      const r = this.memo('promo', [s.code, s.tier, promoItems.join('.'), P.depth, P.weeks, P.deal, P.funding].join('|'), () => E.simulatePromo(model, promoItems, P.depth / 100, P.weeks, P.deal, P.funding / 100, s.tier));
      const it = items[item], after = it.price * (1 - P.depth / 100);
      const parts = [['Promotion weeks', r.profitParts.promoWeeks], ['Dip the week after', r.profitParts.dip], ['Sales lost on other products', r.profitParts.cannibalisation], ['Net', r.profit]];
      let lo = Math.min(0, ...parts.map(x => x[1].p10)), hi = Math.max(0, ...parts.map(x => x[1].p90)); const sp = (hi - lo) || 1; lo -= sp * 0.06; hi += sp * 0.06;
      const P2 = v => ((v - lo) / (hi - lo) * 100).toFixed(2) + '%';
      const ticks = this.niceTicks(lo, hi, 4).map(v => ({ x: P2(v), label: F.money(v) }));
      const hov = s.partHover;
      const DEALS = [{ v: 'none', label: 'Price cut only', sub: 'New price on the shelf, nothing else' }, { v: 'bonus', label: 'Shelf tag', sub: 'A deal tag next to the product' }, { v: 'advertised', label: 'Advertised', sub: 'In the weekly flyer' }];
      const need = r.breakEvenFunding.p50;
      out.mv = this.vd(E.promoVerdict(r, P.funding / 100));
      out.m = {
        item, setItem: e => this.setPromo({ item: Number(e.target.value) }), itemOpts: items.map((x, i) => ({ v: i, label: x.name })),
        hasLine: !!line, wholeLine: P.wholeLine, toggleLine: e => this.setPromo({ wholeLine: e.target.checked }),
        lineLabel: line ? `Promote its whole price line (${line.length} products)` : '',
        lineCaution: !!line && !P.wholeLine, lineCautionText: line ? `${line.map(j => items[j].name).join(', ')} were never discounted separately in the data, so promoting one alone is outside what the model has seen.` : '',
        depth: P.depth, depthLabel: `${P.depth}% off`, setDepth: e => this.setPromo({ depth: Number(e.target.value) }), before: F.price(it.price), after: F.price(after),
        lengths: this.seg([1, 2, 3, 4].map(v => ({ v, label: v === 1 ? '1 week' : v + ' weeks' })), P.weeks, v => this.setPromo({ weeks: v })),
        deals: this.seg(DEALS, P.deal, v => this.setPromo({ deal: v })),
        funding: P.funding, fundLabel: `${P.funding}% of the discount`, setFunding: e => this.setPromo({ funding: Number(e.target.value) }),
        hero: this.kpi('Net', r.profit, F.sMoney, ''), chance: F.pct(r.probProfitable),
        lift: F.sPct(r.liftPct.p50, 0), liftLo: F.sPct(r.liftPct.p10, 0), liftHi: F.sPct(r.liftPct.p90, 0), liftArrow: F.arrow(r.liftPct.p50), liftColor: F.tone(r.liftPct.p50),
        need: need > 1 ? 'Over 100%' : F.pct(need), needSub: need <= P.funding / 100 + 1e-9 ? `Current funding (${P.funding}%) already covers it` : `Up from ${P.funding}% now`,
        liftNeed: r.breakEvenLiftPct === null ? 'At this funding every promoted unit sells below cost' : `Or a ${F.pct(r.breakEvenLiftPct)} sales lift at current funding`,
        belowCost: r.promoMarginPerUnit.some(x => x <= 0), belowText: `At ${P.depth}% off with ${P.funding}% supplier funding the promoted price is below cost, so more volume makes the loss bigger.`,
        ticks, gridX: ticks.map(t => t.x), zero: P2(0), off: () => this.setState({ partHover: null }),
        parts: parts.map(([label, S], i) => {
          const z = (0 - lo) / (hi - lo) * 100, m = (S.p50 - lo) / (hi - lo) * 100, net = i === 3;
          return { label, mid: F.sMoney(S.p50), color: F.tone(S.p50, 0.5), font: net ? '600 14px Geist' : '400 14px Geist', sep: net ? '1.5px solid #16181D' : '0', hl: hov === i ? '#F4F3EF' : 'transparent',
            bl: Math.min(z, m).toFixed(2) + '%', bw: Math.abs(m - z).toFixed(2) + '%', fill: S.p50 >= 0 ? '#2F5BD3' : '#D9705A', wl: P2(S.p10), wr: P2(S.p90), ww: ((S.p90 - S.p10) / (hi - lo) * 100).toFixed(2) + '%',
            aria: `${label}: ${F.sMoney(S.p50)}, likely ${F.sMoney(S.p10)} to ${F.sMoney(S.p90)}`, on: () => this.setState({ partHover: i }) };
        }),
        readout: hov == null ? 'Hover or tab to a row for its exact range.' : `${parts[hov][0]}: ${F.sMoney(parts[hov][1].p50)} in the middle, likely ${F.sMoney(parts[hov][1].p10)} to ${F.sMoney(parts[hov][1].p90)}.`,
        units: [['Extra units during the promotion', r.incrementalUnits], ['Units lost in the dip afterwards', r.dipUnits], ['Units other products lose or gain', r.cannibalisedUnits], ['Net units for the category', r.netUnits]].map(([label, S], i) => ({ label, value: `${F.arrow(S.p50, 0.5)} ${F.sCount(S.p50)}`, color: F.tone(S.p50, 0.5), weight: i === 3 ? 600 : 400 })),
      };
    }

    // 3 Best prices
    if (s.tab === 'best') {
      const O = s.opt, r = s.optRes, key = this.optKeyOf(s), fresh = !!r && s.optKey === key, valid = !!r && s.optKey.split('|')[0] === s.code;
      const o = { ready: valid, first: !valid, busy: valid && !fresh ? 'true' : 'false', busyOpacity: valid && !fresh ? 1 : 0, maxChange: O.maxChange, minMargin: O.minMargin, floor: O.floor, hasLines, link: O.link,
        setMax: e => this.setOpt({ maxChange: Number(e.target.value) }), setMargin: e => this.setOpt({ minMargin: Number(e.target.value) }), setFloor: e => this.setOpt({ floor: Number(e.target.value) }),
        toggleLink: e => this.setOpt({ link: e.target.checked }), heldText: O.locked.length ? `${O.locked.length} held.` : '', hlMove: 'none', hlMargin: 'none', hlFloor: 'none' };
      if (valid) {
        const v = E.optimizerVerdict(r), moved = r.changePct.filter(c => Math.abs(c) > 1e-6).length;
        o.infeasible = !r.feasible; o.leave = r.feasible && !moved; o.showKpis = r.feasible && moved > 0; o.dim = valid && !fresh ? 0.55 : 1;
        out.ov = this.vd(v);
        if (!r.feasible) {
          const fl = s.optHints && s.optHints.floorOk;
          out.ov.reason = `No set of prices meets all three limits at once.`;
          o.conflict = `A ${O.minMargin}% minimum margin pushes prices up so far that revenue falls below the ${O.floor}% you asked to keep. Loosen "Lowest margin allowed"${fl ? ` or lower "Revenue to keep"` : ''}.`;
          o.hlMargin = '2px solid #B4361F'; o.hlFloor = fl ? '2px solid #B4361F' : 'none';
          o.fixes = [{ label: `Lower margin to ${Math.max(0, O.minMargin - 10)}%`, onClick: () => this.setOpt({ minMargin: Math.max(0, O.minMargin - 10) }) }].concat(fl ? [{ label: 'Keep 80% of revenue', onClick: () => this.setOpt({ floor: 80 }) }] : []);
        }
        o.hero = this.kpi('Weekly profit', r.delta.profit, F.sMoney, F.money(r.expected.baselineProfit));
        o.rev = F.sMoney(r.delta.revenue.p50); o.revArrow = F.arrow(r.delta.revenue.p50, 0.5); o.revColor = F.tone(r.delta.revenue.p50, 0.5);
        o.revShare = F.pct(r.expected.revenue / r.expected.baselineRevenue, 1); o.chance = F.pct(r.probProfitUp);
        o.applyDisabled = !r.feasible || !moved; o.applyBg = o.applyDisabled ? '#A3A6AD' : '#16181D';
        o.apply = () => { this.setState(st => ({ priceMap: { ...st.priceMap, [st.code]: r.prices.map(p => Math.round(p * 100) / 100) }, link: O.link })); this.setTab('prices'); };
        o.rows = items.map((it, i) => {
          const st = r.atBound[i], ch = r.changePct[i], held = O.locked.includes(i);
          const L = st === 'fixed' ? ['▣', 'Held', '#F4F3EF', '#CFCCC4', '#16181D'] : r.probInelastic[i] >= 0.2 ? ['≈', 'Weak evidence: price barely moved in the data', '#FFF4D6', '#E7CF8E', '#3D2B00'] : st !== 'none' ? ['⇥', 'Stopped at your limit', '#EEF2FC', '#C9D5F5', '#1D3E9E'] : ['◎', 'Best price is inside your limits', '#E6F2EA', '#B9DBC5', '#14532F'];
          return { name: it.name, today: F.price(it.price), rec: F.price(r.prices[i]), change: Math.abs(ch) < 0.0005 ? 'No change' : `${F.arrow(ch)} ${F.sPct(ch)}`, glyph: L[0], label: L[1], pillBg: L[2], pillBorder: L[3], pillFg: L[4], held, holdLabel: `Hold ${it.name} at today's price`,
            toggle: () => this.setOpt({ locked: held ? O.locked.filter(x => x !== i) : [...O.locked, i] }) };
        });
      }
      out.o = o;
      if (!out.ov) out.ov = { glyph: '•', fg: '#5F6368', bg: '#fff', label: '', title: '', reason: '' };
    }

    // 5 Ask
    if (s.tab === 'ask') {
      const off = !!s.askOff;
      const st = [`What happens to profit if ${items[0].name} goes up 5%?`, `Is 25% off ${items[Math.min(3, k - 1)].name} for one week worth it?`, `Would a two-week shelf-tag deal at 15% off ${items[Math.min(6, k - 1)].name} make money?`];
      const catName = model.name;
      out.a = {
        cat: catName, off, disabled: off || s.askBusy, showStarters: s.msgs.length === 0,
        starters: st.map(text => ({ text, onClick: () => this.ask(text) })),
        cleared: !!s.clearedFor && s.msgs.length === 0, clearedText: `Conversation cleared because you switched to ${catName}.`,
        hasNote: !!s.askNote, note: s.askNote || '',
        msgs: s.msgs.map(m => ({
          q: m.q, waiting: m.status === 'waiting', waitText: m.calls.length ? 'Reading the tool results…' : 'Thinking about which tool to run…',
          done: m.status === 'done', answer: m.answer || '', failed: m.status === 'failed', failText: `The request failed. Nothing was saved.${m.error ? ' Reason: ' + String(m.error).slice(0, 240) : ''}`,
          retry: () => { this.setState(st2 => ({ msgs: st2.msgs.filter(x => x.id !== m.id) })); setTimeout(() => this.ask(m.q), 0); },
          hasCalls: m.calls.length > 0, calls: m.calls,
          ok: m.status === 'done' && !(m.unsupported || []).length, okText: m.checked ? `All ${m.checked} numbers traced to a tool result` : 'No numbers to trace in this answer',
          warn: m.status === 'done' && (m.unsupported || []).length > 0, warnText: `Check these numbers: ${(m.unsupported || []).join(', ')}`,
        })),
        input: s.askInput, count: s.askInput.length, onInput: e => this.setState({ askInput: e.target.value.slice(0, 400) }),
        onKey: e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.ask(); } },
        onSubmit: e => { e.preventDefault(); this.ask(); },
        placeholder: off ? 'The assistant is switched off' : `Ask about ${catName.toLowerCase()} prices or promotions…`,
        sendDisabled: off || s.askBusy || !s.askInput.trim(), sendBg: off || s.askBusy || !s.askInput.trim() ? '#A3A6AD' : '#16181D', sendLabel: s.askBusy ? 'Asking…' : 'Ask',
      };
    }

    // 6 Method
    if (s.tab === 'method') out.h = this.methodVals(model, INDEX);
    return out;
  }

  deliveryVals() {
    const x = this.state.dl;
    const thresholds = Array.from({ length: 17 }, (_, i) => Math.round((x.avgBasket * (0.4 + i * 0.15)) / 5) * 5).filter((t, i, a) => t > 0 && a.indexOf(t) === i);
    const res = this.memo('dl', JSON.stringify(x), () => E.evaluateThresholds(x, thresholds));
    const best = E.bestThreshold(res), bi = res.indexOf(best), n = res.length;
    const g = this.chart('dl', n, [res.map(r => r.profitDelta.p10), res.map(r => r.profitDelta.p90)], { h: 260, b: 30, zero: true, fy: v => F.money(v), fx: i => '$' + res[i].threshold, maxX: 9, start: bi });
    const band = res.map((r, i) => g.X(i).toFixed(1) + ',' + g.Y(r.profitDelta.p90).toFixed(1)).concat(res.map((r, i) => g.X(i).toFixed(1) + ',' + g.Y(r.profitDelta.p10).toFixed(1)).reverse()).join(' ');
    const hi = g.hov == null ? bi : g.hov, h = res[hi];
    const bx = g.X(bi), by = g.Y(best.profitDelta.p50);
    const sl = (label, key, min, max, step, show, scale = 1) => ({ label, min, max, step, value: x[key] * scale, show, onChange: e => this.setDl({ [key]: Number(e.target.value) / scale }) });
    const rng = (label, key, max, step, hint) => {
      const [a, b] = x[key];
      return { label, show: `${F.pct(a)} to ${F.pct(b)}`, max, step, lo: a * 100, hi: b * 100, l: (a * 100 / max * 100).toFixed(1) + '%', w: ((b - a) * 100 / max * 100).toFixed(1) + '%', hint, loLabel: label + ', low value', hiLabel: label + ', high value',
        setLo: e => { const v = Number(e.target.value) / 100; this.setDl({ [key]: [v, Math.max(v, this.state.dl[key][1])] }); },
        setHi: e => { const v = Number(e.target.value) / 100; this.setDl({ [key]: [Math.min(v, this.state.dl[key][0]), v] }); } };
    };
    const v = E.deliveryVerdict(best);
    const vv = this.vd(v, v.headline);
    return {
      v: vv,
      best: '$' + best.threshold, shareFree: F.pct(best.shareFree), mid: F.sMoney(best.profitDelta.p50), lo: F.sMoney(best.profitDelta.p10), hi: F.sMoney(best.profitDelta.p90),
      arrow: F.arrow(best.profitDelta.p50, 0.5), color: F.tone(best.profitDelta.p50, 0.5), beats: F.pct(best.probBetter),
      g: { yTicks: g.yTicks, xTicks: g.xTicks, zeroY: g.zeroY, band, mid: g.pts(res.map(r => r.profitDelta.p50)) },
      bestX: bx.toFixed(1), bestRx: (bx - 5.5).toFixed(1), bestRy: (by - 5.5).toFixed(1), bestRot: `rotate(45 ${bx.toFixed(1)} ${by.toFixed(1)})`,
      hx: g.X(hi).toFixed(1), hy: g.Y(h.profitDelta.p50).toFixed(1), hOp: g.hov == null ? 0 : 1,
      onMove: g.onMove, onLeave: g.onLeave, onKey: g.onKey,
      chartLabel: `Profit change per 1,000 orders by free-delivery threshold. Best threshold $${best.threshold}. Use left and right arrow keys to read values.`,
      readout: `${hi === bi ? 'Best · ' : ''}Free above $${h.threshold}: ${F.sMoney(h.profitDelta.p50)} per 1,000 orders, likely ${F.sMoney(h.profitDelta.p10)} to ${F.sMoney(h.profitDelta.p90)}. ${F.pct(h.shareFree)} ship free; beats the flat fee in ${F.pct(h.probBetter)} of cases.`,
      biz: [sl('Average order value', 'avgBasket', 10, 200, 5, F.money(x.avgBasket))],
      spreads: this.seg([{ v: 0.35, label: 'Similar sizes' }, { v: 0.6, label: 'Mixed' }, { v: 1.0, label: 'Very mixed' }], x.basketSpread, val => this.setDl({ basketSpread: val })),
      biz2: [sl('Margin on goods', 'marginPct', 5, 70, 1, F.pct(x.marginPct), 100), sl('Cost of one delivery', 'deliveryCost', 1, 20, 0.5, F.price(x.deliveryCost)), sl('Delivery fee', 'fee', 0, 15, 0.5, F.price(x.fee))],
      reach: F.pct(x.reachPct), reachV: x.reachPct * 100, setReach: e => this.setDl({ reachPct: Number(e.target.value) / 100 }),
      ranges: [rng('Share of those that top up', 'topUp', 100, 5, 'Of the orders within reach, how many add items to qualify'), rng('Extra orders from big baskets', 'extraOrders', 50, 1, 'Shoppers who would have abandoned the cart because of the fee')],
    };
  }

  methodVals(model, INDEX) {
    const s = this.state, items = model.items, k = items.length, v = model.validation;
    const blk = id => () => { const el = document.getElementById('blk-' + id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 12, behavior: 'smooth' }); };
    const toc = [['A', 'The model in four sentences'], ['B', 'Does it predict unseen weeks?'], ['C', 'Price sensitivity'], ['D', 'Who takes sales from whom'], ['E', 'Is price just following demand?'], ['F', 'What this cannot tell you']].map(([id, label]) => ({ id, label, onClick: blk(id) }));
    const item = Math.min(s.methodItem, k - 1), series = v.series.find(x => x.item === item) || v.series[0], n = series.week.length;
    const g = this.chart('ho', n, [series.actual, series.pred], { h: 240, b: 30, floor0: true, fy: x => F.count(x), fx: i => 'wk ' + series.week[i], maxX: 7 });
    const hi = g.hov;
    const cross = this.memo('cross', model.code, () => Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => { let t = 0; for (let d = 0; d < model.draws.n; d++) t += model.draws.cross[d][i][j]; return t / model.draws.n; })));
    let maxAbs = 0; cross.forEach((r, i) => r.forEach((x, j) => { if (i !== j) maxAbs = Math.max(maxAbs, Math.abs(x)); }));
    const cells = [], hc = s.heatCell;
    const effect = (e) => Math.exp(e * Math.log(0.9)) - 1;
    for (let i = 0; i < k; i++) {
      cells.push({ head: true, n: String(i + 1), name: items[i].name });
      for (let j = 0; j < k; j++) {
        if (i === j) { cells.push({ diag: true }); continue; }
        const x = cross[i][j], a = maxAbs ? Math.abs(x) / maxAbs : 0, on = hc && hc[0] === i && hc[1] === j;
        cells.push({ cell: true, v: (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(2), bg: x >= 0 ? `rgba(47,91,211,${(0.06 + a * 0.6).toFixed(2)})` : `rgba(196,98,45,${(0.06 + a * 0.55).toFixed(2)})`, fg: a > 0.6 ? '#fff' : '#16181D', border: on ? '2px solid #16181D' : '0',
          aria: `${items[i].name} versus ${items[j].name}: ${x.toFixed(2)}`, on: () => this.setState({ heatCell: [i, j] }) });
      }
    }
    let heatRead = 'Pick a cell to read it as a sentence.';
    if (hc) { const [i, j] = hc, e = effect(cross[i][j]); heatRead = `When ${items[j].name} gets 10% cheaper, ${items[i].name} sells ${Math.abs(e * 100).toFixed(1)}% ${e < 0 ? 'less' : 'more'}.`; }
    const lines = model.lines || [];
    // elasticities
    const vals = items.flatMap(it => [it.elasticity.regular[0], it.elasticity.regular[2], it.stage1.regular]).concat([-1, 0]);
    let lo = Math.min(...vals), hiV = Math.max(...vals); const sp = hiV - lo; lo -= sp * 0.05; hiV += sp * 0.05;
    const P = x => ((x - lo) / (hiV - lo) * 100).toFixed(2) + '%';
    const eh = s.elHover;
    const ticks = this.niceTicks(lo, hiV, 5).map(x => ({ x: P(x), label: (x < 0 ? '−' : '') + Math.abs(x).toFixed(Number.isInteger(x) ? 0 : 1), color: x === -1 ? '#B4361F' : '#5F6368' }));
    const strong = items.filter(it => it.endogeneity.firstStageF >= 10);
    const gap = strong.length ? strong.reduce((a, it) => a + it.endogeneity.iv - it.endogeneity.ols, 0) / strong.length : 0;
    let take = `The instrument is usable for ${strong.length} of ${k} products.`;
    if (strong.length && Math.abs(gap) >= 0.3) take += ` For those, shoppers look ${Math.abs(gap).toFixed(1)} points ${gap < 0 ? 'more' : 'less'} price-sensitive once instrumented, so the simulator probably ${gap < 0 ? 'understates' : 'overstates'} how much volume a price rise costs here.`;
    else if (strong.length) take += ' For those, the plain and instrumented estimates agree closely, so price is not just following demand.';
    else take += ' Without a usable instrument, the plain estimates cannot be checked this way.';
    const d = model.diagnostics;
    return {
      cat: model.name, toc,
      four: [
        `For each product, weekly units in each store are explained by its regular price, how deep any discount is, whether the deal was advertised, last week's discount, and the prices of the other ${k - 1} products on the shelf.`,
        `That gives one set of estimates per product, fitted on ${F.count(d.rows)} product-store-weeks from ${d.stores} stores.`,
        'A second, Bayesian step treats each estimate as a noisy reading and pools products within the category: precise estimates barely move, implausible ones are pulled toward their neighbours.',
        'It returns 400 plausible versions of the whole demand system, and every result in this app is computed once per version, which is where the ranges come from.',
      ],
      holdout: v.holdoutWeeks,
      cats: INDEX.map(r => { const fail = r.medianApe > 0.3, on = r.code === model.code; return { name: r.name, miss: F.pct(r.medianApe), bench: F.pct(r.medianApeNaive), verdict: fail ? '✕ Fails: direction only' : '✓ Passes', pillBg: fail ? '#FBE5E0' : '#E6F2EA', pillBorder: fail ? '#E5A99B' : '#B9DBC5', pillFg: fail ? '#6B1D0E' : '#14532F', bg: on ? '#F5F7FD' : '#fff', weight: on ? 600 : 400 }; }),
      item, setItem: e => this.setState({ methodItem: Number(e.target.value), hover: { ...this.state.hover, ho: null } }), itemOpts: items.map((x, i) => ({ v: i, label: x.name })),
      g: { yTicks: g.yTicks, xTicks: g.xTicks, s0: g.pts(series.actual), s1: g.pts(series.pred) },
      hx: g.X(hi == null ? 0 : hi).toFixed(1), hy0: g.Y(series.actual[hi == null ? 0 : hi]).toFixed(1), hy1: g.Y(series.pred[hi == null ? 0 : hi]).toFixed(1), hOp: hi == null ? 0 : 1,
      onMove: g.onMove, onLeave: g.onLeave, onKey: g.onKey,
      lineLabel: `Actual and predicted weekly units for ${items[item].name} over ${n} holdout weeks. Use arrow keys to read values.`,
      readout: hi == null ? 'Hover, tap or use ← → on the chart for exact values.' : `Week ${series.week[hi]}: sold ${F.count(series.actual[hi])}, predicted ${F.count(series.pred[hi])} (${F.sPct(series.pred[hi] / series.actual[hi] - 1)}).`,
      summary: `Across ${model.name}: weighted error ${F.pct(v.wapeModel)} (benchmark ${F.pct(v.wapeNaive)}), total volume ${v.biasModel < 0 ? 'under' : 'over'}-predicted by ${F.pct(Math.abs(v.biasModel))}, and ${F.pct(v.coverage80)} of weeks landed inside the predicted range. Weighted error is higher than the typical miss because a few advertised weeks sell ten to twenty times normal volume.`,
      el: {
        ticks, zero: P(0), ref: P(-1),
        rows: items.map((it, i) => { const e = it.elasticity.regular; return { name: it.name, l: P(e[0]), w: ((e[2] - e[0]) / (hiV - lo) * 100).toFixed(2) + '%', m: P(e[1]), raw: P(it.stage1.regular), mid: e[1].toFixed(2).replace('-', '−'), hl: eh === i ? '#F4F3EF' : 'transparent',
          aria: `${it.name}: pooled ${e[1].toFixed(2)}, range ${e[0].toFixed(2)} to ${e[2].toFixed(2)}, raw ${it.stage1.regular.toFixed(2)}`, on: () => this.setState({ elHover: i }) }; }),
        readout: eh == null ? 'Hover or tab to a row for its exact values.' : (() => { const it = items[eh], e = it.elasticity.regular; return `${it.name}: a 1% price rise changes units by ${e[1].toFixed(2)}% after pooling (likely ${e[0].toFixed(2)} to ${e[2].toFixed(2)}); the raw estimate was ${it.stage1.regular.toFixed(2)}.`; })(),
      },
      heat: { cols: items.map((it, i) => ({ n: String(i + 1), name: it.name })), cells, readout: heatRead,
        note: lines.length ? `Always discounted together: ${lines.map(gr => gr.map(i => items[i].name).join(' + ')).join('; ')}. The data can't separate these, so their negative numbers are not real complements, and the app treats each group as one price line.` : `No products in ${model.name} are always discounted together, so every product can be priced on its own.` },
      endo: items.map(it => { const e = it.endogeneity, ok = e.firstStageF >= 10; return { name: it.name, ols: e.ols.toFixed(2).replace('-', '−'), iv: ok ? `${e.iv.toFixed(2).replace('-', '−')} ± ${e.ivSe.toFixed(2)}` : 'n/a', f: e.firstStageF.toFixed(0), label: ok ? '✓ Yes' : '≈ Weak instrument', pillBg: ok ? '#E6F2EA' : '#FFF4D6', pillBorder: ok ? '#B9DBC5' : '#E7CF8E', pillFg: ok ? '#14532F' : '#3D2B00' }; }),
      endoTake: take,
      limits: [
        'Prices are from 1989 to 1997 in one Chicago chain. The method transfers; the numbers do not.',
        'Baskets are invisible. A soft-drink deal that loses money may still be worth it if it brings shoppers into the store; this model only sees the category.',
        'Weeks with zero sales are missing from the data, so stock-outs look like nothing happened.',
        "Cost is the chain's average acquisition cost, which lags real wholesale prices, so margins after a cost change are approximate.",
        `Prices outside the two-year range are extrapolation. The Bayesian step converged (worst R-hat ${d.maxRhat.toFixed(3)}, ${d.divergences} divergent transitions), but that says nothing about prices the chain never tried.`,
      ],
    };
  }

  render() {
    return <View v={this.renderVals()} />;
  }
}
