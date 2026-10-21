// Khoj Control Room front end. No build step: plain ES modules, rendered from /api/state.
const CATS = ['Saree', 'Kurti & Suits', 'Jewellery'];
const ui = { tab: 'room', cat: 'All', live: 'all', showDone: true, data: null, busy: false, saving: false, msg: '' };
try { Object.assign(ui, JSON.parse(localStorage.getItem('khoj-ui') || '{}'), { data: null, busy: false, saving: false, msg: '' }); } catch {}
const remember = () => { try { localStorage.setItem('khoj-ui', JSON.stringify({ tab: ui.tab, cat: ui.cat, live: ui.live, showDone: ui.showDone })); } catch {} };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n === null || n === undefined ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
const int = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-IN'));
const pc = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d) + '%');
const chip = (cls, text) => `<span class="chip chip-${cls}">${esc(text)}</span>`;
const inCat = (c) => ui.cat === 'All' ? CATS.includes(c) : c === ui.cat;
const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); };

const ACTION = {
  kill: ['orange', 'Kill'], graduate: ['green', 'Graduate'], extend: ['purple', 'Extend'], continue: ['blue', 'Continue'],
  killed: ['orange', 'Killed'], graduated: ['green', 'Graduated'],
  up: ['green', 'Step up'], down: ['orange', 'Step down'], hold: ['amber', 'Hold'], lifecycle: ['purple', 'Lifecycle ended'], paused: ['muted', 'Paused'],
  start: ['blue', 'Trial started'], step_up: ['green', 'Step up'], step_down: ['orange', 'Step down'],
  stopped: ['muted', 'Stopped early']
};
const actionChip = (a) => { const [c, t] = ACTION[a] || ['muted', a]; return chip(c, t); };

// ---------- loading ----------
// pull = true: run each Metabase question (page load and the Refresh button only), then apply the rules.
// pull = false: re-apply the rules to the last pull (after saving rules); never calls Metabase.
const progress = { steps: [], current: -1 };
let creep = null;

function setStep(i) {
  progress.current = i;
  const n = progress.steps.length;
  const from = (i / n) * 100, to = ((i + 1) / n) * 100;
  let pct = from;
  clearInterval(creep);
  // Inside a step there is no real progress signal from Metabase, so the bar eases toward the step's end.
  creep = setInterval(() => { pct += (to - 2 - pct) * 0.08; paintProgress(pct); }, 200);
  paintProgress(from);
  renderLoader();
}
function paintProgress(pct) {
  const bar = document.querySelector('#progress > span');
  if (bar) bar.style.width = Math.min(100, pct).toFixed(1) + '%';
  const big = document.querySelector('.loader .bar > span');
  if (big) big.style.width = Math.min(100, pct).toFixed(1) + '%';
  const label = document.querySelector('.loader .pct');
  if (label) label.textContent = Math.round(pct) + '%';
}
function finishProgress() {
  clearInterval(creep);
  paintProgress(100);
  setTimeout(() => { $('progress').hidden = true; paintProgress(0); }, 400);
}

function renderLoader() {
  const steps = progress.steps.map((s, i) => {
    const state = i < progress.current ? 'done' : i === progress.current ? 'now' : 'todo';
    const icon = state === 'done' ? '<span class="step-ok" aria-hidden="true">✓</span>' : state === 'now' ? '<span class="spinner" aria-hidden="true"></span>' : '<span class="step-dot" aria-hidden="true"></span>';
    return `<li class="step ${state}">${icon}<span>${esc(s.label)}</span>${s.note ? `<span class="muted small">${esc(s.note)}</span>` : ''}</li>`;
  }).join('');
  const html = `<div class="loader card" role="status" aria-live="polite">
    <div class="card-head"><h2>Loading from Metabase</h2><span class="pct num muted">0%</span></div>
    <div class="bar" style="height:8px"><span style="width:0%;background:var(--ink)"></span></div>
    <ol class="steps">${steps}</ol></div>`;
  if (!ui.data) $('view').innerHTML = html;
  $('progress').hidden = false;
  const now = progress.steps[progress.current];
  $('refresh').textContent = now ? `${now.short}…` : 'Loading…';
}

async function load(pull = true) {
  if (ui.busy) return;
  ui.busy = true; ui.msg = ''; renderChrome();
  try {
    let names = [];
    if (pull) {
      const r = await fetch('/api/sources');
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
      names = (await r.json()).sources;
    }
    progress.steps = [
      ...names.map((s) => ({ key: s.name, label: `${s.label}`, short: s.label })),
      { key: 'rules', label: 'Applying the rules', short: 'Applying rules' }
    ];
    for (let i = 0; i < names.length; i++) {
      setStep(i);
      const r = await fetch('/api/sources/' + names[i].name, { method: 'POST' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || r.statusText);
      progress.steps[i].note = body.status === 'ok' ? `${int(body.rows)} rows` : body.status === 'missing' ? 'not connected' : 'failed';
    }
    setStep(progress.steps.length - 1);
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    ui.data = await res.json();
  } catch (e) {
    ui.msg = 'Could not load data: ' + e.message;
  }
  finishProgress();
  ui.busy = false;
  render();
}

// ---------- chrome ----------
function renderChrome() {
  const d = ui.data;
  $('cats').innerHTML = ['All', ...CATS].map((c) => `<button type="button" class="pill" data-cat="${esc(c)}" aria-pressed="${c === ui.cat}">${c === 'All' ? 'All test categories' : esc(c)}</button>`).join('');
  const open = d ? d.tasks.filter((t) => !t.done && inCat(t.category)).length : 0;
  const tabs = [['room', 'Control room', ''], ['cover', 'Hero coverage', ''], ['tasks', 'Task log', open ? `${open} open` : ''], ['rules', 'Rules', '']];
  $('tabs').innerHTML = tabs.map(([k, l, b]) => `<button type="button" class="tab" role="tab" data-tab="${k}" aria-selected="${k === ui.tab}">${l}${b ? ' ' + chip('orange', b) : ''}</button>`).join('');
  $('refresh').disabled = ui.busy;
  if (!ui.busy) $('refresh').textContent = 'Refresh from Metabase';
  $('freshness').textContent = d ? `Data ${new Date(d.meta.loadedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  const notices = [];
  if (ui.msg) notices.push(`<div class="notice notice-orange">${esc(ui.msg)}</div>`);
  if (d) {
    for (const [k, s] of Object.entries(d.meta.sources)) {
      if (s.status === 'error') notices.push(`<div class="notice notice-orange"><strong>${esc(k)}</strong> source failed (${esc(s.origin)}): ${esc(s.error)}</div>`);
      else if (s.status === 'missing') notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong> source not connected (${esc(s.origin)}). Sections that need it are empty.</div>`);
    }
    for (const n of d.notes) notices.push(`<div class="notice notice-amber">${esc(n)}</div>`);
    if (d.meta.store === 'memory') notices.push('<div class="notice notice-amber">No persistent store: task ticks and the decision log are kept in memory and reset on restart.</div>');
  }
  $('notices').innerHTML = notices.join('');
}

function render() {
  renderChrome();
  const d = ui.data;
  if (!d) {
    if (!ui.busy) $('view').innerHTML = `<div class="card"><p>Nothing loaded yet.</p><p><button type="button" class="btn btn-primary" id="retry">Try again</button></p></div>`;
    return;
  }
  const view = { room: viewRoom, cover: viewCover, tasks: viewTasks, rules: viewRules }[ui.tab] || viewRoom;
  $('view').innerHTML = `<div class="view">${view(d)}</div>`;
}

// ---------- Control room ----------
function viewRoom(d) {
  const pipe = d.pipeline.filter((p) => inCat(p.key));
  const sum = (k) => pipe.reduce((a, p) => a + p[k], 0);
  const cov = d.coverage.filter((r) => inCat(r.key));
  const csum = (k) => cov.reduce((a, r) => a + r[k], 0);
  const allCov = d.coverage.find((r) => r.key === 'Total') || { uploaded: 0, hero: 0 };
  const scopeLabel = (l) => `${l} · ${ui.cat === 'All' ? '3 test categories' : ui.cat}`;
  const win = sum('scaling') + sum('lifecycle'), killed = sum('killed'), decided = win + killed;
  const p = decided ? win / decided : null;
  const ci = decided ? 1.96 * Math.sqrt(p * (1 - p) / decided) * 100 : null;
  const trials = d.trials.filter((t) => inCat(t.cat));
  const running = trials.filter((t) => !t.closed && ['continue', 'extend'].includes(t.action));
  const kpis = [
    [scopeLabel('Uploaded to Khoj'), int(csum('uploaded')), `${int(csum('live'))} live · ${int(allCov.uploaded)} across all categories`],
    [scopeLabel('Hero products'), int(csum('hero')), `${int(csum('heroLive'))} hero and live · ${int(allCov.hero)} across all categories`],
    ['Hero tested', int(sum('heroTested')), csum('hero') ? pc(sum('heroTested') / csum('hero') * 100, 1) + ' of hero pool' : ''],
    ['Success%', p === null ? '—' : pc(p * 100), decided ? `±${Math.round(ci)} pts · n = ${decided} decided` : 'no verdicts yet'],
    ['Live trials', int(running.length), `${inr(d.settings.trialDailyBudget)}/day each`],
    ['Winners scaling', int(sum('scaling')), `${sum('lifecycle')} lifecycle done`]
  ];
  return [
    `<section class="kpis" aria-label="Headline numbers">${kpis.map(([l, v, s]) => `<div class="kpi"><span class="label">${l}</span><span class="value num">${v}</span><span class="sub">${esc(s)}</span></div>`).join('')}</section>`,
    pipelineCard(d, pipe, sum, csum),
    liveCard(d, trials),
    ladderCard(d),
    catalogCard(d),
    `<div class="split"><div class="main">${logCard(d)}</div><div class="side">${sourcesCard(d)}</div></div>`
  ].join('');
}

function pipelineCard(d, pipe, sum, csum) {
  const hero = csum('hero'), tested = sum('heroTested');
  const parts = [['testing', 'In testing', 'var(--blue)'], ['scaling', 'Winner · scaling', 'var(--green)'], ['lifecycle', 'Winner · lifecycle done', 'var(--purple)'], ['killed', 'Killed', 'var(--orange)']];
  const totalOutcomes = parts.reduce((a, [k]) => a + sum(k), 0);
  const rows = d.pipeline.filter((p) => CATS.includes(p.key)).map((p) => {
    const w = p.scaling + p.lifecycle, dec = w + p.killed;
    return `<tr class="${ui.cat === p.key ? 'sel' : ''}"><td><strong>${esc(p.key)}</strong></td><td class="r num">${int(p.hero)}</td><td class="r num muted">${int(p.notTested)}</td><td class="r num">${p.testing}</td><td class="r num">${p.scaling}</td><td class="r num">${p.lifecycle}</td><td class="r num">${p.killed}</td><td class="r num"><strong>${dec ? pc(w / dec * 100) : '—'}</strong></td></tr>`;
  }).join('');
  const src = { A: 'Hero · 300+ orders', B: 'Hero · 30–299 orders', control: 'Control (not hero)' };
  const bySource = d.bySource.map((s) => `<tr><td>${src[s.key]}</td><td class="r num">${s.decided}</td><td class="r num">${s.winners}</td><td class="r num"><strong>${s.decided ? pc(s.winners / s.decided * 100) : '—'}</strong></td></tr>`).join('');
  return `<section class="card" aria-label="Pipeline">
    <div class="card-head"><h2>Hero pipeline</h2><span class="muted small">Success% = winners (scaling + lifecycle done) ÷ decided trials</span></div>
    <div><div class="card-head small"><span><strong>Coverage of hero pool</strong></span><span class="num muted">${int(tested)} of ${int(hero)} · ${hero ? pc(tested / hero * 100, 1) : '—'}</span></div>
      <div class="bar" style="height:10px;margin-top:8px"><span style="width:${hero ? Math.max(1, tested / hero * 100) : 0}%;background:var(--ink)"></span></div></div>
    <div><div class="small" style="font-weight:600;margin-bottom:8px">Tested products by outcome</div>
      <div class="stack">${totalOutcomes ? parts.filter(([k]) => sum(k)).map(([k, l, c]) => `<span title="${l}: ${sum(k)}" style="flex:${sum(k)} 1 0;background:${c}"></span>`).join('') : ''}</div>
      <div class="legend" style="margin-top:10px">${parts.map(([k, l, c]) => `<span><span class="dot" style="background:${c}"></span>${l} <strong class="num">${sum(k)}</strong></span>`).join('')}</div></div>
    <div class="table-box"><table style="min-width:760px"><thead><tr><th>Category</th><th class="r">Hero pool</th><th class="r">Not tested</th><th class="r">In testing</th><th class="r">Winner · scaling</th><th class="r">Lifecycle done</th><th class="r">Killed</th><th class="r">Success%</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div><div class="small" style="font-weight:600;margin-bottom:8px">Success% by where the product came from <span class="muted" style="font-weight:400">· the pre-selection thesis test</span></div>
      <div class="table-box"><table><thead><tr><th>Source</th><th class="r">Decided</th><th class="r">Winners</th><th class="r">Success%</th></tr></thead><tbody>${bySource}</tbody></table></div></div>
  </section>`;
}

function liveCard(d, trials) {
  const live = trials.filter((t) => !t.closed);
  const groups = { kill: ['kill'], graduate: ['graduate'], extend: ['extend'], continue: ['continue'] };
  const count = (k) => live.filter((t) => groups[k].includes(t.action)).length;
  const closedCount = trials.length - live.length;
  const filters = [['all', 'All live', live.length], ['kill', 'Kill', count('kill')], ['graduate', 'Graduate', count('graduate')], ['extend', 'Extend', count('extend')], ['continue', 'Continue', count('continue')], ['closed', 'Closed', closedCount]];
  const shown = (ui.live === 'closed' ? trials.filter((t) => t.closed) : live.filter((t) => ui.live === 'all' || (groups[ui.live] || []).includes(t.action))).sort((a, b) => b.spend - a.spend);
  const color = { kill: 'var(--orange)', graduate: 'var(--green)', extend: 'var(--purple)', continue: 'var(--blue)', killed: 'var(--orange)', graduated: 'var(--green)', stopped: '#9A9CA3' };
  const bar = d.settings.winBar;
  const rows = shown.map((t) => `<tr>
    <td><div class="prod"><span class="name">${esc(t.product || t.name)}</span><span class="muted small">${esc(t.cat)}${t.code ? ' · ' + esc(t.code) : ' · not linked to a SKU'}${t.tier ? ' · ' + (t.tier === 'control' ? 'control' : 'tier ' + t.tier) : ''} · ${t.adsetCount > 1 ? t.adsetCount + ' ad sets' : '1 ad set'}${t.lastSpendDate ? ' · last spend ' + fmtDate(t.lastSpendDate) : ''}</span></div></td>
    <td class="num nowrap">D${t.days}</td>
    <td><div class="num small">${inr(t.spend)} / ${inr(t.limit)}</div><div class="bar" style="margin-top:5px"><span style="width:${Math.min(100, t.spend / t.limit * 100)}%;background:${color[t.action] || 'var(--blue)'}"></span></div></td>
    <td class="r num">${int(t.purchases)}</td>
    <td class="r num">${inr(t.gmv)}</td>
    <td class="r">${t.recentSgmv !== null
      ? `<div class="num ${t.recentSgmv > bar ? 'bad' : 'good'}" title="Last ${inr(t.recentSpend)} of spend, from ${fmtDate(t.recentFrom)}">${pc(t.recentSgmv)} <span class="small muted">recent</span></div><div class="num small muted nowrap">overall ${pc(t.sgmv)}</div>`
      : `<div class="num ${t.sgmv === null ? 'muted' : t.sgmv > bar ? 'bad' : 'good'}">${t.sgmv === null ? 'no orders' : pc(t.sgmv)}</div><div class="num small muted nowrap">${t.cpp !== null ? 'CPP ' + inr(t.cpp) + ' · ' : ''}target CPP ${inr(t.targetCpp)}</div>`}</td>
    <td class="r num ${t.ctr !== null && t.ctr < d.settings.minCtr ? 'bad' : ''}">${pc(t.ctr, 2)}</td>
    <td class="r num">${int(t.atc)}</td>
    <td>${actionChip(t.action)}</td>
    <td class="wrap-cell small">${esc(t.reason)}</td></tr>`).join('');
  return `<section class="card" aria-label="Live trials">
    <div class="card-head"><div><h2>Trials</h2><span class="muted small">One product per trial (original + copy ad sets summed) · verdict at ${inr(d.settings.verdictSpend)} on the most recent ${Math.round(d.settings.verdictWindowShare * 100)}% of spend (min ${inr(d.settings.verdictWindowMin)}) · winning bar ${bar}% Spend/GMV after the ×${d.settings.metaSgmvFactor} Meta correction</span></div>
      <div class="seg-tabs" role="group" aria-label="Filter trials">${filters.map(([k, l, c]) => `<button type="button" class="seg" data-live="${k}" aria-pressed="${ui.live === k}">${l} <span class="count num">${c}</span></button>`).join('')}</div></div>
    ${shown.length ? `<div class="table-box"><table style="min-width:1200px"><thead><tr><th>Product</th><th>Day</th><th>Spend / verdict</th><th class="r">Orders</th><th class="r">GMV</th><th class="r">Spend/GMV</th><th class="r">CTR</th><th class="r">ATC</th><th>Decision</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${d.meta.sources.ads.status === 'ok' ? 'No trials match this filter.' : 'Connect the ads question (MB_Q_ADS) to see trials.'}</p>`}
  </section>`;
}

function ladderCard(d) {
  const rows = d.ladder.filter((a) => inCat(a.cat) && a.action !== 'paused');
  const L = d.settings.ladder;
  const body = rows.map((a) => `<tr>
    <td><div class="prod"><span class="name">${esc(a.product || a.name)}</span><span class="muted small">${esc(a.cat)}</span></div></td>
    <td><div class="ladder" aria-label="Step ${a.step} of ${a.steps}">${L.map((_, i) => `<span class="${i < a.step ? 'on' : ''}"></span>`).join('')}</div></td>
    <td class="r num">${inr(a.budget)}</td>
    <td class="r num ${a.marginal === null ? 'muted' : a.marginal > d.settings.winBar ? 'bad' : a.marginal >= d.settings.stepUpBelow ? 'warn' : 'good'}">${a.marginalNote ? esc(a.marginalNote) : pc(a.marginal)}</td>
    <td class="r num">${pc(a.avg)}</td>
    <td class="r num">${a.days}</td>
    <td>${actionChip(a.action)}${a.to ? ` <span class="num small">→ ${inr(a.to)}</span>` : ''}</td>
    <td class="wrap-cell small">${esc(a.reason)}</td></tr>`).join('');
  return `<section class="card" aria-label="Scale ladder">
    <div class="card-head"><h2>Winners on the scale ladder</h2><span class="muted small">${L.map(inr).join(' → ')}/day · step up below ${d.settings.stepUpBelow}% marginal Spend/GMV · ceiling above ${d.settings.winBar}%</span></div>
    ${rows.length ? `<div class="table-box"><table style="min-width:1000px"><thead><tr><th>Product</th><th>Ladder</th><th class="r">Budget/day</th><th class="r">Marginal Spend/GMV</th><th class="r">Avg Spend/GMV</th><th class="r">Days</th><th>Decision</th><th>Why</th></tr></thead><tbody>${body}</tbody></table></div>`
      : '<p class="empty">No active scale ad sets in this view.</p>'}
  </section>`;
}

function catalogCard(d) {
  const sums = d.catalog.summary.filter((s) => inCat(s.key));
  const t = (k) => sums.reduce((a, s) => a + s[k], 0);
  const items = d.catalog.items.filter((i) => inCat(i.cat) && i.read !== 'thin')
    .sort((a, b) => (a.read === b.read ? b.spend - a.spend : a.read === 'hit' ? -1 : 1)).slice(0, 20);
  const read = { hit: ['green', 'Directional hit'], miss: ['orange', 'Directional miss'] };
  const cards = [
    ['Products with spend', int(t('withSpend')), d.catalog.window.from ? `${fmtDate(d.catalog.window.from)} – ${fmtDate(d.catalog.window.to)}` : 'all campaigns incl. catalog'],
    ['Eligible', int(t('readable')), `≥ ${inr(d.settings.catalogMinSpend)} lifetime spend`],
    ['Directional hit rate', t('readable') ? pc(t('hits') / t('readable') * 100) : '—', `recent Spend/GMV ≤ ${d.settings.winBar}% · biased upward`],
    ['Hits not yet trialled', int(t('queued')), 'go to the front of the trial queue']
  ];
  const rows = items.map((i) => `<tr>
    <td><div class="prod"><span class="name">${esc(i.name)}</span><span class="muted small">${esc(i.cat)}${i.hero ? ' · hero' : ''}${i.live ? '' : ' · not live'}</span></div></td>
    <td class="r num">${inr(i.spend)}</td><td class="r num">${inr(i.gmv)}</td>
    <td class="r"><div class="num ${i.sgmv !== null && i.sgmv <= d.settings.winBar ? 'good' : 'bad'}"${i.recentSpend ? ` title="Last ${inr(i.recentSpend)} of spend, from ${fmtDate(i.recentFrom)}"` : ''}>${i.sgmv === null ? 'no GMV' : pc(i.sgmv)}${i.recentSpend ? ' <span class="small muted">recent</span>' : ''}</div><div class="num small muted">lifetime ${i.lifetimeSgmv === null ? 'no GMV' : pc(i.lifetimeSgmv)}</div></td>
    <td>${chip(...read[i.read])}</td>
    <td class="small">${i.trialed ? 'Already trialled' : i.read === 'hit' ? (i.live ? 'Queued for trial' : 'Hit, but not live') : 'Moved down the queue'}</td></tr>`).join('');
  return `<section class="card" aria-label="Product signal">
    <div class="card-head"><div><h2>Product signal · all campaigns incl. catalog ${chip('muted', 'Directional')}</h2><span class="muted small">Product-wise spend across every campaign, catalog included · eligible after ${inr(d.settings.catalogMinSpend)} lifetime spend, read on the most recent ${Math.round(d.settings.signalWindowShare * 100)}% of spend (min ${inr(d.settings.signalWindowMin)}) · feeds the trial queue, never Success%</span></div></div>
    <div class="kpis">${cards.map(([l, v, s]) => `<div class="kpi"><span class="label">${l}</span><span class="value num" style="font-size:22px">${v}</span><span class="sub">${esc(s)}</span></div>`).join('')}</div>
    ${rows ? `<div class="table-box"><table style="min-width:900px"><thead><tr><th>Product</th><th class="r">Lifetime spend</th><th class="r">Lifetime GMV</th><th class="r">Spend/GMV</th><th>Read</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${d.meta.sources.catalog.status === 'ok' ? 'No product has enough spend to read yet.' : 'Connect the product-wise spend question (MB_Q_PRODUCT_SPEND) to see this.'}</p>`}
  </section>`;
}

function logCard(d) {
  const items = d.log.filter((e) => !e.category || inCat(e.category)).slice(0, 60);
  return `<section class="card" aria-label="Decision log">
    <div class="card-head"><h2>Decision log</h2><span class="muted small">Every call the rules engine made, and why</span></div>
    ${items.length ? `<ul class="log">${items.map((e) => `<li><span class="num muted">${fmtDate(e.at)}</span><span>${actionChip(e.action)}</span><span><strong>${esc(e.product_name || e.adset_id)}</strong> <span class="muted">· ${esc(e.reason || '')}</span></span></li>`).join('')}</ul>` : '<p class="empty">No decisions yet.</p>'}
  </section>`;
}

function sourcesCard(d) {
  const label = { products: 'Products (hero base)', ads: 'Trial and scale ads', catalog: 'Product-wise spend (all campaigns)', adsetMap: 'Ad set → product map' };
  return `<section class="card" aria-label="Data sources">
    <h2>Data sources</h2>
    <div class="sources">${Object.entries(d.meta.sources).map(([k, s]) => `<div class="source"><strong>${label[k]}</strong><span class="muted small">${esc(s.origin)}</span><span>${s.status === 'ok' ? chip('green', int(s.rows) + ' rows') : s.status === 'missing' ? chip('amber', 'Not connected') : chip('orange', 'Error')}</span>${s.columns && s.columns.length ? `<details><summary class="small">Columns received (${s.columns.length})</summary><ul class="small muted" style="margin:6px 0 0;padding-left:18px">${s.columns.map((c) => `<li><code>${esc(c)}</code> · ${esc((s.sample || {})[c] || '')}</li>`).join('')}</ul></details>` : ''}</div>`).join('')}</div>
    <p class="muted small">Metabase is queried only when the page opens or you click “Refresh from Metabase”. Ticking tasks and saving rules reuse that pull. Storage: ${{ postgres: 'Postgres', 'netlify-blobs': 'Netlify Blobs', memory: 'in memory' }[d.meta.store] || d.meta.store}.</p>
  </section>`;
}

// ---------- Hero coverage ----------
function viewCover(d) {
  const rows = d.coverage.map((r) => {
    const p = r.hero ? r.heroLive / r.hero * 100 : 0;
    return `<tr class="${r.key === 'Total' ? 'total' : r.key === ui.cat ? 'sel' : ''}"><td><strong>${esc(r.name)}</strong></td><td class="r num">${int(r.uploaded)}</td><td class="r num">${int(r.live)}</td><td class="r num"><strong>${int(r.hero)}</strong></td><td class="r num muted">${int(r.tierA)}</td><td class="r num muted">${int(r.tierB)}</td><td class="r num"><strong>${int(r.heroLive)}</strong></td><td class="r num ${p < 30 ? 'bad' : p < 60 ? 'warn' : 'good'}">${pc(p)}</td><td class="r num">${int(r.hero - r.heroLive)}</td></tr>`;
  }).join('');
  const s = d.settings;
  return `<section class="card" aria-label="Hero coverage">
    <div class="card-head"><div><h2 style="font-size:20px">Hero coverage on Khoj</h2><span class="muted small">Products uploaded to Khoj, how many are hero, and how many of those are live</span></div>${chip('green', d.meta.sources.products.origin)}</div>
    <div class="table-box"><table style="min-width:900px"><thead><tr><th>Category</th><th class="r">Uploaded</th><th class="r">Live</th><th class="r">Hero</th><th class="r">${s.heroOrdersAll}+ orders</th><th class="r">${s.heroOrdersMin}–${s.heroOrdersAll - 1} orders</th><th class="r">Hero and live</th><th class="r">Hero live %</th><th class="r">Hero not live</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="settings">
      <div class="field"><span class="group-title">Hero rule</span><span>L30D seller orders ≥ ${s.heroOrdersAll}: all · ${s.heroOrdersMin}–${s.heroOrdersAll - 1}: only if profit % (D40–D10) &gt; ${s.heroMinProfitPct} and L30D spend &gt; ${inr(s.heroMinSpend)}</span></div>
      <div class="field"><span class="group-title">Kurti &amp; Suits</span><span>Women's kurta sets, kurtas, maternity kurtis, salwar suits, dress material</span></div>
      <div class="field"><span class="group-title">Live</span><span>current_status = live; everything else counts as not live</span></div>
    </div>
  </section>`;
}

// ---------- Task log ----------
function viewTasks(d) {
  const segs = [
    ['trial', 'New trials to start', 'Every freed slot is refilled the same day', 'var(--blue)'],
    ['kill', 'Kills', 'Pause the ad set; the product leaves paid testing', 'var(--orange)'],
    ['scale', 'Scales', 'Graduations, extensions and ladder moves', 'var(--green)']
  ];
  const today = d.today;
  const tasks = d.tasks.filter((t) => inCat(t.category));
  const sections = segs.map(([k, title, sub, color]) => {
    const all = tasks.filter((t) => t.segment === k).sort((a, b) => (a.done - b.done) || String(a.due).localeCompare(String(b.due)));
    const open = all.filter((t) => !t.done).length;
    const shown = all.filter((t) => ui.showDone || !t.done);
    const items = shown.map((t) => {
      const due = t.done ? chip('green', t.auto ? 'Done · detected' : 'Done') : t.due <= today ? chip('orange', 'Today') : chip('muted', fmtDate(t.due));
      return `<li class="task ${t.done ? 'done' : ''}"><label><input type="checkbox" data-task="${esc(t.id)}" ${t.done ? 'checked' : ''}><span><div class="t-title">${esc(t.title)}</div><div class="t-detail">${esc(t.detail)}</div></span></label><div class="meta">${due}<span class="muted small">${esc(t.category)}</span></div></li>`;
    }).join('');
    return `<section class="card" aria-label="${title}"><div class="card-head"><div style="flex-direction:row;align-items:center;gap:10px"><span class="dot-lg" style="background:${color}"></span><h3>${title}</h3>${chip('muted', `${open} open · ${all.length - open} done`)}</div><span class="muted small">${sub}</span></div>
      ${items ? `<ul class="tasks">${items}</ul>` : '<p class="empty">Nothing here.</p>'}</section>`;
  }).join('');
  return `<div class="card-head"><div><h2 style="font-size:20px">Task log</h2><span class="muted small">Created by the rules engine on every refresh · tick when done in Ads Manager · ticks also close themselves when the data shows the change</span></div>
    <label class="nowrap" style="display:inline-flex;gap:8px;align-items:center;min-height:44px;cursor:pointer"><input type="checkbox" id="showDone" ${ui.showDone ? 'checked' : ''} style="width:18px;height:18px"> Show completed</label></div>${sections}`;
}

// ---------- Rules ----------
function viewRules(d) {
  const groups = {};
  for (const [k, [g, l]] of Object.entries(d.settingLabels)) (groups[g] ||= []).push([k, l]);
  const field = (k, l) => {
    const v = d.settings[k], def = d.defaults[k];
    const val = Array.isArray(v) ? v.join(', ') : v;
    return `<div class="field"><label for="s_${k}">${esc(l)}</label><input id="s_${k}" name="${k}" value="${esc(val)}" ${typeof def === 'number' ? 'inputmode="decimal"' : ''}><span class="def">Default: ${esc(Array.isArray(def) ? def.join(', ') : def)}</span></div>`;
  };
  const ladderField = field('ladder', 'Scale ladder budgets (₹/day, comma-separated)');
  return `<form id="rules" class="card" aria-label="Rules">
    <div class="card-head"><div><h2 style="font-size:20px">Rules</h2><span class="muted small">Every decision and task follows these. Changes apply on save.</span></div>
      <div style="flex-direction:row;gap:8px"><button type="button" class="btn" id="resetRules">Reset to defaults</button><button type="submit" class="btn btn-primary" ${ui.saving ? 'disabled' : ''}>${ui.saving ? 'Saving…' : 'Save rules'}</button></div></div>
    ${Object.entries(groups).map(([g, fs]) => `<div><div class="group-title">${esc(g)}</div><div class="settings" style="margin-top:10px">${fs.map(([k, l]) => field(k, l)).join('')}${g === 'Ladder' ? ladderField : ''}</div></div>`).join('')}
  </form>`;
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-cat],[data-tab],[data-live],#refresh,#retry,#resetRules');
  if (!t) return;
  if (t.dataset.cat) { ui.cat = t.dataset.cat; remember(); render(); }
  else if (t.dataset.tab) { ui.tab = t.dataset.tab; remember(); render(); }
  else if (t.dataset.live) { ui.live = t.dataset.live; remember(); render(); }
  else if (t.id === 'refresh' || t.id === 'retry') load(true);
  else if (t.id === 'resetRules') {
    if (!confirm('Reset every rule to its default?')) return;
    await fetch('/api/settings', { method: 'DELETE' });
    load(false);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'showDone') { ui.showDone = e.target.checked; remember(); render(); return; }
  const id = e.target.dataset.task;
  if (!id) return;
  const done = e.target.checked;
  const task = ui.data.tasks.find((x) => x.id === id);
  if (task) { task.done = done; task.auto = false; }
  render();
  const res = await fetch('/api/tasks/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done }) });
  if (!res.ok) { ui.msg = 'Could not save that tick. Refresh and try again.'; if (task) task.done = !done; render(); }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'rules') return;
  e.preventDefault();
  const body = {};
  for (const input of e.target.querySelectorAll('input[name]')) {
    const def = ui.data.defaults[input.name];
    body[input.name] = Array.isArray(def) ? input.value.split(',').map((x) => Number(x.trim())).filter((x) => Number.isFinite(x) && x > 0) : input.value;
  }
  ui.saving = true; render();
  const res = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  ui.saving = false;
  if (!res.ok) ui.msg = 'Could not save rules.';
  await load(false);
});

load();
