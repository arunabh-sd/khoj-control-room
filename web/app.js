// Khoj Control Room front end. No build step: plain ES modules, rendered from /api/state.
const CATS = ['Saree', 'Kurti & Suits', 'Jewellery'];
const ui = { tab: 'status', sub: 'summary', cat: 'All', live: 'all', sig: 'ppo', showDone: true, data: null, busy: false, saving: false, uploading: false, msg: '', note: '' };
try { Object.assign(ui, JSON.parse(localStorage.getItem('khoj-ui') || '{}'), { data: null, busy: false, saving: false, uploading: false, msg: '', note: '' }); } catch {}
// Older saved tabs → their new home.
{ const OLD = { room: ['pmf', 'hits'], cover: ['pmf', 'hits'], audience: ['pmf', 'quality'], cross: ['pmf', 'cross'], repeat: ['pmf', 'repeat'] };
  if (OLD[ui.tab]) [ui.tab, ui.sub] = OLD[ui.tab]; }
const remember = () => { try { localStorage.setItem('khoj-ui', JSON.stringify({ tab: ui.tab, sub: ui.sub, cat: ui.cat, live: ui.live, sig: ui.sig, showDone: ui.showDone })); } catch {} };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : (n < -0.5 ? '−₹' : '₹') + Math.abs(Math.round(n)).toLocaleString('en-IN'));
const int = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-IN'));
const pc = (n, d = 0) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d) + '%');
const chip = (cls, text) => `<span class="chip chip-${cls}">${esc(text)}</span>`;
const inCat = (c) => ui.cat === 'All' ? CATS.includes(c) : c === ui.cat;
const link = (url, text) => (url ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));
const fmtWhen = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');
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

async function load(pull = true, force = false) {
  if (ui.busy) return;
  ui.busy = true; ui.msg = ''; ui.custRows = null; renderChrome();
  try {
    let names = [];
    const failures = [];
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
      // One slow or failing question doesn't stop the page: it keeps that source's last good pull.
      let note;
      try {
        const r = await fetch('/api/sources/' + names[i].name + (force ? '?force=1' : ''), { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || (r.status === 504 || r.status === 502 ? 'timed out' : r.statusText));
        note = body.reused ? `${int(body.rows)} rows · from ${fmtWhen(body.loadedAt)}` : body.daily
          ? (body.status === 'ok' ? `${body.everyHours >= 24 ? 'daily' : `every ${body.everyHours} h`} · pulled ${fmtWhen(body.loadedAt)}` : body.status === 'missing' ? 'waiting for the scheduled pull' : 'scheduled pull pending')
          : body.status === 'ok' ? `${int(body.rows)} rows` : body.status === 'missing' ? 'not connected' : body.stale ? 'failed · using last pull' : 'failed';

      } catch (err) {
        note = 'failed';
        failures.push(`${names[i].label}: ${err.message}`);   // the request itself failed (e.g. a Netlify 504); per-source errors show from the state
      }
      progress.steps[i].note = note;
    }
    setStep(progress.steps.length - 1);
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    ui.data = await res.json();
    if (failures.length) ui.msg = `Some questions didn't load: ${failures.join(' · ')}`;
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
  const tabs = [['status', 'Overall Status', ''], ['plan', 'Scaling Plan & Status', ''], ['pmf', 'PMF View', ''], ['rules', 'Rules', ''], ['tasks', 'Task log', open ? `${open} open` : '']];
  $('cats').style.display = (ui.tab === 'pmf' && ui.sub === 'hits') || ui.tab === 'tasks' ? '' : 'none';
  $('tabs').innerHTML = tabs.map(([k, l, b]) => `<button type="button" class="tab" role="tab" data-tab="${k}" aria-selected="${k === ui.tab}">${l}${b ? ' ' + chip('orange', b) : ''}</button>`).join('');
  $('refresh').disabled = ui.busy;
  if (!ui.busy) $('refresh').textContent = 'Refresh from Metabase';
  $('freshness').textContent = d ? `Data ${new Date(d.meta.loadedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  const notices = [];
  if (ui.msg) notices.push(`<div class="notice notice-orange">${esc(ui.msg)}</div>`);
  if (ui.note) notices.push(`<div class="notice notice-green">${esc(ui.note)}</div>`);
  if (d) {
    for (const [k, s] of Object.entries(d.meta.sources)) {
      if (s.status === 'error' && s.daily) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: not pulled yet. The scheduled pull checks every 5 minutes (last try: ${esc(s.error)}).</div>`);
      else if (s.status === 'error') notices.push(`<div class="notice notice-orange"><strong>${esc(k)}</strong> source failed (${esc(s.origin)}): ${esc(s.error)}</div>`);
      else if (s.fallback) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: using the copy in the repo (export from ${esc(fmtWhen(s.loadedAt))}) until Metabase delivers a fresh one (${esc(s.error || '')}).</div>`);
      else if (s.stale) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong> didn't refresh (${esc(s.error)}). Showing the pull from ${esc(fmtWhen(s.loadedAt))}${s.daily ? '; the scheduled pull retries within 5 minutes' : ''}.</div>`);
      else if (s.daily && s.status === 'missing' && s.origin === 'waiting for the daily pull') notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: waiting for the scheduled pull, which checks every 5 minutes.</div>`);
      else if (s.status === 'missing' && !['universe', 'overlap', 'history', 'events', 'benchmark', 'browsing', 'personalise'].includes(k)) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong> source not connected (${esc(s.origin)}). Sections that need it are empty.</div>`);
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
  const view = { status: viewStatus, plan: viewPlan, pmf: viewPmf, tasks: viewTasks, rules: viewRules }[ui.tab] || viewStatus;
  $('view').innerHTML = `<div class="view">${view(d)}</div>`;
}

// ---------- Product Testing ----------
function viewRoom(d) {
  const pipe = d.pipeline.filter((p) => inCat(p.key));
  const sum = (k) => pipe.reduce((a, p) => a + p[k], 0);
  const cov = d.coverage.filter((r) => inCat(r.key));
  const csum = (k) => cov.reduce((a, r) => a + r[k], 0);
  // Main number: the selected scope (3 test categories, or one). Small print: every category.
  const add = (keys, f) => keys.reduce((a, k) => (a === null || d.kpis[k][f] === null ? null : a + d.kpis[k][f]), 0);
  const scopeKeys = Object.keys(d.kpis).filter((k) => inCat(k));
  const allKeys = Object.keys(d.kpis);
  const K = (f) => [add(scopeKeys, f), add(allKeys, f)];
  const ratio = (n, m) => (n === null || !m ? null : n / m * 100);
  const [live, liveAll] = K('live');
  const [heroLive, heroLiveAll] = K('heroLive');
  const [uHero, uHeroAll] = K('universeHero');
  const [uHeroLive, uHeroLiveAll] = K('universeHeroLive');
  const covN = uHeroLive ?? heroLive, covNAll = uHeroLiveAll ?? heroLiveAll;
  const [tested, testedAll] = K('tested');
  const [wins, winsAll] = K('winners');
  const [losses, lossesAll] = K('losses');
  const [liveTrials, liveTrialsAll] = K('liveTrials');
  const [scaling, scalingAll] = K('scaling');
  const sr = ratio(wins, wins + losses), srAll = ratio(winsAll, winsAll + lossesAll);
  const ci = wins + losses ? 1.96 * Math.sqrt((sr / 100) * (1 - sr / 100) / (wins + losses)) * 100 : null;
  const kpis = [
    ['Live on Khoj', int(live), `All categories: ${int(liveAll)}`],
    ['Hero products (live)', int(heroLive), `All categories: ${int(heroLiveAll)}`],
    ['Universe coverage (hero)', uHero === null ? '—' : pc(ratio(covN, uHero), 1), uHero === null ? 'Connect MB_Q_UNIVERSE (ShopDeck universe)' : `${int(covN)} of ${int(uHero)} ShopDeck heroes live · all categories: ${pc(ratio(covNAll, uHeroAll), 1)}`],
    ['Tested', int(tested), `All categories: ${int(testedAll)}`],
    ['Success rate', sr === null ? '—' : pc(sr), wins + losses ? `${wins} of ${wins + losses} decided${ci !== null ? ` · ±${Math.round(ci)} pts` : ''} · all: ${srAll === null ? '—' : pc(srAll)}` : 'No verdicts yet'],
    ['Live trials', int(liveTrials), `All categories: ${int(liveTrialsAll)}`],
    ['Winners scaling', int(scaling), `All categories: ${int(scalingAll)}`]
  ];
  const scope = ui.cat === 'All' ? '3 test categories' : ui.cat;
  return [
    `<div class="small muted">Large numbers: <strong>${esc(scope)}</strong> · small print: all categories</div>`,
    `<section class="kpis kpis-7" aria-label="Headline numbers">${kpis.map(([l, v, s]) => `<div class="kpi"><span class="label">${l}</span><span class="value num">${v}</span><span class="sub">${esc(s)}</span></div>`).join('')}</section>`,
    pipelineCard(d, pipe, sum, csum),
    liveCard(d, d.trials.filter((t) => inCat(t.cat))),
    killReviewCard(d),
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
    <td><div class="prod"><span class="name">${link(t.url, t.product || t.name)}</span><span class="muted small">${esc(t.cat)}${t.code ? ' · ' + esc(t.code) : ' · not linked to a SKU'}${t.tier ? ' · ' + (t.tier === 'control' ? 'control' : 'tier ' + t.tier) : ''}${t.sellerOverlap ? ` · <span class="${t.sellerOverlap.pct > 25 ? 'bad' : t.sellerOverlap.pct > 10 ? 'warn' : ''}" title="${t.sellerOverlap.overlap} of ${t.sellerOverlap.buyers} Khoj buyers also bought from this product's seller">${pc(t.sellerOverlap.pct)} seller overlap</span>` : ''} · ${t.adsetCount > 1 ? t.adsetCount + ' ad sets' : '1 ad set'}${t.lastSpendDate ? ' · last spend ' + fmtDate(t.lastSpendDate) : ''}</span></div></td>
    <td class="num nowrap">D${t.days}</td>
    <td><div class="num small">${inr(t.spend)} / ${inr(t.limit)}</div><div class="bar" style="margin-top:5px"><span style="width:${Math.min(100, t.spend / t.limit * 100)}%;background:${color[t.action] || 'var(--blue)'}"></span></div></td>
    <td class="r num">${int(t.purchases)}</td>
    <td class="r num">${inr(t.gmv)}</td>
    <td class="r">${t.recentSgmv !== null
      ? `<div class="num ${t.verdictSgmv > bar ? 'bad' : 'good'}" title="Verdict uses the better of lifetime and recent (last ${inr(t.recentSpend)}, from ${fmtDate(t.recentFrom)})">${pc(t.verdictSgmv)} <span class="small muted">${t.verdictBasis}</span></div><div class="num small muted nowrap">${t.verdictBasis === 'recent' ? 'lifetime ' + pc(t.sgmv) : 'recent ' + pc(t.recentSgmv)}</div>`
      : `<div class="num ${t.sgmv === null ? 'muted' : t.sgmv > bar ? 'bad' : 'good'}">${t.sgmv === null ? 'no orders' : pc(t.sgmv)}</div><div class="num small muted nowrap">${t.cpp !== null ? 'CPP ' + inr(t.cpp) + ' · ' : ''}target CPP ${inr(t.targetCpp)}</div>`}</td>
    <td class="r num ${t.ctr !== null && t.ctr < d.settings.minCtr ? 'bad' : ''}">${pc(t.ctr, 2)}</td>
    <td class="r num">${int(t.atc)}</td>
    <td>${actionChip(t.action)}</td>
    <td class="wrap-cell small">${esc(t.reason)}</td></tr>`).join('');
  return `<section class="card" aria-label="Live trials">
    <div class="card-head"><div><h2>Trials</h2><span class="muted small">One product per trial (original + copy ad sets summed) · verdict at ${inr(d.settings.verdictSpend)} on the better of lifetime and recent Spend/GMV (recent = last ${Math.round(d.settings.verdictWindowShare * 100)}% of spend, min ${inr(d.settings.verdictWindowMin)}) · winning bar ${bar}% Spend/GMV after the ×${d.settings.metaSgmvFactor} Meta correction</span></div>
      <div class="seg-tabs" role="group" aria-label="Filter trials">${filters.map(([k, l, c]) => `<button type="button" class="seg" data-live="${k}" aria-pressed="${ui.live === k}">${l} <span class="count num">${c}</span></button>`).join('')}</div></div>
    ${shown.length ? `<div class="table-box"><table style="min-width:1200px"><thead><tr><th>Product</th><th>Day</th><th>Spend / verdict</th><th class="r">Orders</th><th class="r">GMV</th><th class="r">Spend/GMV</th><th class="r">CTR</th><th class="r">ATC</th><th>Decision</th><th>Why</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${d.meta.sources.ads.status === 'ok' ? 'No trials match this filter.' : 'Connect the ads question (MB_Q_ADS) to see trials.'}</p>`}
  </section>`;
}

function ladderCard(d) {
  const rows = d.ladder.filter((a) => inCat(a.cat) && a.action !== 'paused');
  const L = d.settings.ladder;
  const body = rows.map((a) => `<tr>
    <td><div class="prod"><span class="name">${link(a.url, a.product || a.name)}</span><span class="muted small">${esc(a.cat)}</span></div></td>
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
  const v = d.catalog;
  const sums = v.summary.filter((x) => inCat(x.key));
  const t = (k) => sums.reduce((a, x) => a + x[k], 0);
  const items = v.items.filter((i) => inCat(i.cat) && i.read !== 'thin' && !i.trialed)
    .sort((a, b) => (a.read === b.read ? b.spend - a.spend : a.read === 'hit' ? -1 : 1)).slice(0, 25);
  const read = { hit: ['green', 'Directional hit'], miss: ['orange', 'Directional miss'] };
  const cards = [
    ['Products with spend', int(t('withSpend')), v.window.from ? `${fmtDate(v.window.from)} – ${fmtDate(v.window.to)} · not yet in testing` : 'not yet in testing'],
    ['Eligible', int(t('readable')), `≥ ${inr(d.settings.catalogMinSpend)} lifetime spend`],
    ['Directional hit rate', t('readable') ? pc(t('hits') / t('readable') * 100) : '—', `Spend/GMV ≤ ${d.settings.winBar}% · biased upward`],
    ['Hits queued for trial', int(t('queued')), 'live hits go to the front of the queue']
  ];
  const rows = items.map((i) => `<tr>
    <td><div class="prod"><span class="name">${link(i.url, i.name)}</span><span class="muted small">${esc(i.cat)}${i.hero ? ' · hero' : ''}${i.live ? '' : ' · not live'}</span></div></td>
    <td class="r num">${inr(i.spend)}</td><td class="r num">${inr(i.gmv)}</td>
    <td class="r"><div class="num ${i.sgmv !== null && i.sgmv <= d.settings.winBar ? 'good' : 'bad'}">${i.sgmv === null ? 'no GMV' : pc(i.sgmv)}${i.recentSgmv !== null ? ` <span class="small muted">${i.basis}</span>` : ''}</div><div class="num small muted">${i.recentSgmv === null ? '' : i.basis === 'recent' ? 'lifetime ' + pc(i.lifetimeSgmv) : 'recent ' + pc(i.recentSgmv)}</div></td>
    <td>${chip(...read[i.read])}</td>
    <td class="small">${i.read === 'hit' ? (i.live ? 'Queued for trial' : 'Hit, but not live on Khoj') : 'Moved down the queue'}</td></tr>`).join('');
  const empty = d.meta.sources.catalog.status === 'ok' ? 'No product outside testing has enough spend to read yet.' : 'Connect the product-wise spend question (MB_Q_PRODUCT_SPEND) to see this.';
  return `<section class="card" aria-label="Product signal">
    <div class="card-head"><div><h2>Product signal catalog (directional)</h2><span class="muted small">Products not already in testing · spend distributed to products by PPO (${esc(d.meta.sources.catalog.origin)}) · eligible after ${inr(d.settings.catalogMinSpend)} lifetime spend, read on the better of lifetime and recent Spend/GMV (recent = last ${Math.round(d.settings.signalWindowShare * 100)}% of spend, min ${inr(d.settings.signalWindowMin)}) · feeds the trial queue, never Success%</span></div></div>
    <div class="kpis">${cards.map(([l, val, x]) => `<div class="kpi"><span class="label">${l}</span><span class="value num" style="font-size:22px">${val}</span><span class="sub">${esc(x)}</span></div>`).join('')}</div>
    ${rows ? `<div class="table-box"><table style="min-width:900px"><thead><tr><th>Product</th><th class="r">Lifetime spend</th><th class="r">Lifetime GMV</th><th class="r">Spend/GMV</th><th>Read</th><th>Decision</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : `<p class="empty">${empty}</p>`}
  </section>`;
}

function killReviewCard(d) {
  const rows = d.killReview.filter((k) => inCat(k.cat));
  if (!rows.length) return '';
  const V = { right: ['green', 'Right call'], recheck: ['amber', 'Recheck'], premature: ['purple', 'Premature'], wrong: ['orange', 'Wrong call'] };
  const right = rows.filter((k) => k.verdict === 'right').length;
  const body = rows.map((k) => `<tr>
    <td><div class="prod"><span class="name">${link(k.url, k.product || k.name)}</span><span class="muted small">${esc(k.cat)}</span></div></td>
    <td class="nowrap">${actionChip(k.call)} <span class="small muted">${fmtDate(k.stoppedOn)}</span></td>
    <td class="r num">${inr(k.spend)}</td>
    <td class="r num">${pc(k.lifetime)}</td>
    <td class="r num">${pc(k.recent)}</td>
    <td class="r num">${pc(k.lastHalf)}</td>
    <td class="r num small">${k.afterSpend ? `${inr(k.afterSpend)} → ${inr(k.afterGmv)} GMV` : '—'}</td>
    <td>${chip(...V[k.verdict])}</td>
    <td class="wrap-cell small">${esc(k.why)}</td></tr>`).join('');
  return `<section class="card" aria-label="Kill review">
    <div class="card-head"><div><h2>Kill review</h2><span class="muted small">Every closed trial that didn't graduate, judged on the data at the stop and the product's spend across all campaigns after it</span></div>${chip(right === rows.length ? 'green' : 'amber', `${right} of ${rows.length} right`)}</div>
    <div class="table-box"><table style="min-width:1100px"><thead><tr><th>Product</th><th>Call</th><th class="r">Spend at stop</th><th class="r">Lifetime</th><th class="r">Recent</th><th class="r">Last half</th><th class="r">After stop</th><th>Verdict</th><th>Why</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="small muted">Right: worse than ${d.settings.retestMax}% Spend/GMV on both lifetime and recent, and not improving. Recheck: the last half of spend was inside ${d.settings.retestMax}% when it was stopped before ${inr(d.settings.verdictSpend)}. Premature: in the ${d.settings.winBar}–${d.settings.retestMax}% retest band. Wrong: at or under ${d.settings.winBar}%, or did that well after the stop.</p>
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
  const label = { products: 'Products (hero base)', ads: 'Trial and scale ads', catalog: 'Product spend, PPO-distributed', adsetMap: 'Ad set → product map', universe: 'ShopDeck universe (PQ ≥ 3)', overlap: 'Khoj × parent seller overlap', history: 'Khoj buyers\' order history', browsing: 'Khoj buyers\' browsing', daywise: 'Khoj day-wise', pnl: 'Khoj P&L', events: 'Site sessions vs parent sellers', personalise: 'Visitor personalisation', benchmark: 'Repeat benchmark (parent sellers)' };
  return `<section class="card" aria-label="Data sources">
    <h2>Data sources</h2>
    <div class="sources">${Object.entries(d.meta.sources).map(([k, s]) => `<div class="source"><strong>${label[k]}</strong><span class="muted small">${esc(s.origin)}</span><span>${s.fallback ? chip('amber', `Repo copy · ${fmtWhen(s.loadedAt)}`) : s.stale ? chip('amber', `Last pull ${fmtWhen(s.loadedAt)} · refresh failed`) : s.daily && s.status === 'ok' ? chip('green', `${int(s.rows)} rows · ${s.everyHours >= 24 ? 'daily' : `every ${s.everyHours} h`}, pulled ${fmtWhen(s.loadedAt)}`) : s.daily && s.status === 'missing' && s.origin === 'waiting for the daily pull' ? chip('amber', 'Waiting for the daily pull') : s.status === 'ok' ? chip('green', int(s.rows) + ' rows') : s.status === 'missing' ? chip('amber', 'Not connected') : chip('orange', 'Error')}</span>${s.error ? `<span class="small" style="color:var(--orange-fg)">${esc(s.error)}</span>` : ''}${s.rows ? `<a class="small" href="/api/sources/${esc(k)}.csv" download>Download the rows (CSV)</a>` : ''}${s.daily ? `<button type="button" class="btn" data-repull="${esc(k)}" style="align-self:flex-start;min-height:32px;padding:4px 10px;font-size:12px">${ui.repulled?.[k] ? 'Queued: next check within 5 min' : 'Pull again'}</button>` : ''}${s.columns && s.columns.length ? `<details><summary class="small">Columns received (${s.columns.length})</summary><ul class="small muted" style="margin:6px 0 0;padding-left:18px">${s.columns.map((c) => `<li><code>${esc(c)}</code> · ${esc((s.sample || {})[c] || '')}</li>`).join('')}</ul></details>` : ''}</div>`).join('')}</div>
    <p class="muted small">Metabase is queried only when the page opens or you click “Refresh from Metabase”, except the slow ones on a schedule: products every 6 hours; universe, order history, overlap and the comparison questions once a day. Opening the page within 30 minutes of the last pull reuses it; the Refresh button always pulls. Ticking tasks and saving rules reuse that pull. Storage: ${{ postgres: 'Postgres', 'netlify-blobs': 'Netlify Blobs', memory: 'in memory' }[d.meta.store] || d.meta.store}.</p>
  </section>`;
}

// ---------- Hero coverage ----------
function funnelStages(d, keys) {
  const cov = d.coverage.filter((r) => keys.includes(r.key));
  const c = (f) => cov.reduce((a, r) => a + r[f], 0);
  const U = d.universe;
  const u = (f) => keys.reduce((a, k) => a + ((U && U.byCat[k]) ? U.byCat[k][f] : 0), 0);
  if (U && U.hasStatus) {
    // Everything from the ShopDeck universe question, so the four stages share one base (PQ ≥ 3).
    return [
      { n: u('all'), label: 'Universe', note: 'ShopDeck products, PQ ≥ 3', of: null },
      { n: u('live'), label: 'Live on Khoj', note: 'of those, live on Khoj', of: ['universe', u('all')] },
      { n: u('hero'), label: 'Hero universe', note: 'of the universe, hero products', of: ['universe', u('all')] },
      { n: u('heroLive'), label: 'Hero live on Khoj', note: 'hero and live on Khoj', of: ['hero universe', u('hero')] },
      { n: u('hero') - u('heroUploaded'), extra: 'Hero not uploaded' },
      { n: u('heroUploaded') - u('heroLive'), extra: 'Hero uploaded, not live' }
    ];
  }
  const universe = { n: c('uploaded'), label: 'Universe', note: 'products uploaded to Khoj' };
  const heroU = { n: c('hero'), label: 'Hero universe', note: 'hero among products uploaded to Khoj' };
  return [
    { ...universe, of: null },
    { n: c('live'), label: 'Live on Khoj', note: 'current_status = live', of: ['universe', universe.n] },
    { ...heroU, of: ['universe', universe.n] },
    { n: c('heroLive'), label: 'Hero live on Khoj', note: 'hero and live', of: ['hero universe', heroU.n] },
    { n: null, extra: 'Hero not uploaded' },
    { n: c('hero') - c('heroLive'), extra: 'Hero uploaded, not live' }
  ];
}

function viewCover(d) {
  const keys = d.coverage.map((r) => r.key).filter((k) => k !== 'Total' && inCat(k));
  const st = funnelStages(d, keys).filter((x) => !x.extra);
  const max = Math.max(1, ...st.map((x) => x.n));
  const colors = ['#9A9CA3', 'var(--blue)', '#6E4BB8', 'var(--green)'];
  const funnel = st.map((x, i) => `<div class="funnel-row">
      <div class="funnel-label"><strong>${x.label}</strong><span class="muted small">${esc(x.note)}</span></div>
      <div class="funnel-bar"><span style="width:${Math.max(0.6, x.n / max * 100)}%;background:${colors[i]}"></span></div>
      <div class="funnel-num"><span class="num" style="font-weight:600">${int(x.n)}</span><span class="muted small">${x.of ? `${pc(x.of[1] ? x.n / x.of[1] * 100 : null, 1)} of ${x.of[0]}` : ''}</span></div>
    </div>`).join('');
  const cats = d.coverage.filter((r) => r.key !== 'Total').map((r) => r.key);
  const row = (name, ks, cls) => {
    const f = funnelStages(d, ks);
    const cov = f[2].n ? f[3].n / f[2].n * 100 : null;
    return `<tr class="${cls}"><td><strong>${esc(name)}</strong></td>${f.slice(0, 4).map((x) => `<td class="r num">${int(x.n)}</td>`).join('')}<td class="r num ${cov === null ? 'muted' : cov < 30 ? 'bad' : cov < 60 ? 'warn' : 'good'}">${pc(cov, 1)}</td><td class="r num">${f[4].n === null ? '—' : int(f[4].n)}</td><td class="r num">${int(f[5].n)}</td></tr>`;
  };
  const rows = cats.map((k) => row(k === 'Other' ? 'Other categories' : k, [k], k === ui.cat ? 'sel' : '')).join('') + row('Total', cats, 'total');
  const s = d.settings;
  const scope = ui.cat === 'All' ? '3 test categories' : ui.cat;
  return `<section class="card" aria-label="Hero coverage">
    <div class="card-head"><div><h2 style="font-size:20px">Hero coverage funnel · ${esc(scope)}</h2><span class="muted small">Universe → live on Khoj → hero universe → hero live on Khoj</span></div>${chip(d.universe ? 'green' : 'amber', d.universe ? `ShopDeck universe · ${d.universe.origin || 'connected'}` : 'Universe = Khoj uploads until MB_Q_UNIVERSE is set')}</div>
    <div class="funnel" role="img" aria-label="Hero coverage funnel">${funnel}</div>
    <div class="table-box"><table style="min-width:900px"><thead><tr><th>Category</th><th class="r">Universe</th><th class="r">Live on Khoj</th><th class="r">Hero universe</th><th class="r">Hero live on Khoj</th><th class="r">Hero coverage</th><th class="r">Hero not uploaded</th><th class="r">Hero uploaded, not live</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="settings">
      <div class="field"><span class="group-title">Hero rule</span><span>Type 1: L30D seller orders ≥ ${s.heroOrdersAll} · Type 2: ${s.heroOrdersMin}–${s.heroOrdersAll - 1} orders with profit % (D40–D10) &gt; ${s.heroMinProfitPct}% and L30D spend &gt; ${inr(s.heroMinSpend)} · both need PQ ≥ ${s.heroMinPq}</span></div>
      <div class="field"><span class="group-title">Kurti &amp; Suits</span><span>Women's kurta sets, kurtas, maternity kurtis, salwar suits, dress material</span></div>
      <div class="field"><span class="group-title">Hero coverage</span><span>Hero live on Khoj ÷ hero universe: the share of ShopDeck's hero products (PQ ≥ 3) that are live on Khoj. "Hero not uploaded" and "Hero uploaded, not live" are the two backlogs.</span></div>
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

// ---------- Planned tabs (light up when their data is connected) ----------
function planned(title, intro, sections, needs) {
  return `<section class="card" aria-label="${esc(title)}">
    <div class="card-head"><div><h2 style="font-size:20px">${esc(title)}</h2><span class="muted small">${esc(intro)}</span></div>${chip('amber', 'Waiting for data')}</div>
    <div class="plan">${sections.map(([h, items]) => `<div class="plan-item"><h3>${esc(h)}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}</div>
    <div><div class="group-title">Data this tab needs</div><ul class="small" style="margin:8px 0 0;padding-left:18px">${needs.map(([q, cols]) => `<li style="margin-bottom:6px"><strong>${esc(q)}:</strong> <code>${esc(cols)}</code></li>`).join('')}</ul></div>
  </section>`;
}

function overlapCard(d) {
  const o = d.overlap;
  const tone = (x) => (x === null ? 'muted' : x > 25 ? 'bad' : x > 10 ? 'warn' : 'good');
  const tbl = (rows, head, nameOf, short) => `<div class="table-box"><table><thead><tr><th>${head}</th><th class="r">Khoj buyers</th><th class="r">${short ? 'Also seller' : 'Also bought from the seller'}</th><th class="r">Overlap</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${nameOf(r)}</td><td class="r num">${int(r.buyers)}</td><td class="r num">${int(r.overlap)}</td><td class="r num ${tone(r.pct)}">${pc(r.pct, 1)}</td></tr>`).join('')}</tbody></table></div>`;
  const shortId = (id) => esc(String(id).slice(-6));
  const cards = [
    ['Seller overlap', pc(o.pct, 1), `${int(o.overlap)} of ${int(o.buyers)} Khoj buyers also bought from the product's own seller`],
    ['Without the top seller', pc(o.pctExTop, 1), o.topSeller ? `seller …${String(o.topSeller.id).slice(-6)} is ${pc(o.topSeller.shareOfOverlap)} of all overlap (${pc(o.topSeller.pct, 1)} of its buyers)` : ''],
    ['Products', int(o.products), `${int(o.sellers)} sellers · ${int(o.orders)} Khoj orders`]
  ];
  const prods = o.topProducts.map((x) => `<tr><td><div class="prod"><span class="name">${link(x.url, x.name)}</span><span class="muted small">${esc(x.cat)} · seller …${shortId(x.sellerId)}${x.tested ? ' · in testing' : ''}</span></div></td><td class="r num">${int(x.buyers)}</td><td class="r num">${int(x.overlap)}</td><td class="r num ${tone(x.pct)}">${pc(x.pct, 1)}</td></tr>`).join('');
  return `<section class="card" aria-label="Cannibalisation">
    <div class="card-head"><div><h2 style="font-size:20px">Cannibalisation · Khoj × parent seller</h2><span class="muted small">Khoj buyers who also bought from the seller whose product they bought on Khoj · ${esc(d.meta.sources.overlap.origin)}</span></div>${chip('green', 'Live')}</div>
    <div class="kpis">${cards.map(([l, v, x]) => `<div class="kpi"><span class="label">${l}</span><span class="value num">${v}</span><span class="sub">${esc(x)}</span></div>`).join('')}</div>
    <div class="grid-3">
      ${tbl(o.byCat, 'Category', (r) => esc(r.key), true)}
      ${tbl(o.byHero, 'Product', (r) => esc(r.key), true)}
      ${tbl(o.bySellerSize, 'Seller orders', (r) => esc(r.key), true)}
    </div>
    <div><div class="group-title">Products by Khoj buyers</div><div class="table-box" style="margin-top:8px"><table style="min-width:700px"><thead><tr><th>Product</th><th class="r">Khoj buyers</th><th class="r">Also bought from the seller</th><th class="r">Overlap</th></tr></thead><tbody>${prods}</tbody></table></div></div>
    <div><div class="group-title">Sellers by Khoj buyers</div><div style="margin-top:8px">${tbl(o.bySeller, 'Seller', (r) => `<span class="num">${esc(r.key)}</span> <span class="muted small">· ${r.products} products</span>`)}</div></div>
    ${o.unlinked ? `<p class="small muted">${o.unlinked} product(s) couldn't be matched to a Khoj product (usually PQ under 3, so not in the universe question); they count in the totals but show the seller product id.</p>` : ''}
  </section>`;
}

// ---------- Customers: Audience intelligence, Repeat behaviour, Cross-selling (order history question, Q16717) ----------
const tbl = (cols, rows, opts = {}) => `<div class="table-box"><table${opts.min ? ` style="min-width:${opts.min}px"` : ''}><thead><tr>${cols.map((c) => `<th${c.r ? ' class="r"' : ''}>${esc(c.h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map((row) => `<tr>${cols.map((c) => `<td class="${c.r ? 'r num ' : ''}${c.cls ? c.cls(row) : ''}">${c.v(row)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="muted">No rows yet.</td></tr>`}</tbody></table></div>`;
const kpiRow = (cards) => `<div class="kpis">${cards.map(([l, v, x]) => `<div class="kpi"><span class="label">${esc(l)}</span><span class="value num">${v}</span><span class="sub">${esc(x)}</span></div>`).join('')}</div>`;
const card = (label, title, sub, body, right = '') => `<section class="card" aria-label="${esc(label)}"><div class="card-head"><div><h2>${esc(title)}</h2>${sub ? `<span class="muted small">${sub}</span>` : ''}</div>${right}</div>${body}</section>`;
const rtoTone = (x) => (x === null || x === undefined ? 'muted' : x > 30 ? 'bad' : x > 20 ? 'warn' : 'good');
const nOf = (x) => (x && x.eligible ? `${pc(x.pct, 1)} <span class="muted small">of ${int(x.eligible)}</span>` : '<span class="muted small">not enough days yet</span>');
const dateOfMin = (m) => (m ? new Date(m * 60000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const segCols = (head) => [
  { h: head, v: (r) => esc(r.key) },
  { h: 'Buyers', r: 1, v: (r) => int(r.buyers) }, { h: 'Share', r: 1, v: (r) => pc(r.share, 1) },
  { h: 'COD', r: 1, v: (r) => pc(r.codPct) }, { h: 'RTO', r: 1, v: (r) => pc(r.rtoPct), cls: (r) => rtoTone(r.rtoPct) }
];

const DATA_EVENTS = ['Site sessions (MB_Q_EVENTS)', 'the site events question in the README: Khoj and its parent sellers, last 28 days'];
const DATA_BENCH = ['Repeat benchmark (MB_Q_BENCHMARK)', 'the repeat benchmark question in the README: Khoj and its parent sellers'];
// Khoj vs the parent sellers' own sites, weighted by Khoj orders: the comparison value for a rate.
const benchCell = (v, unit = 'pct') => (v === null || v === undefined ? '<span class="muted small">—</span>' : unit === 'pct' ? pc(v, 1) : v.toFixed(v < 10 ? 2 : 0));
function historyMissing(title) {
  return card(title, title, '', `<p class="small muted">Set <code>MB_Q_CUSTOMER_HISTORY</code> to the order history question (Q16717) to turn this on.</p>`, chip('amber', 'Not connected'));
}
function historySub(d) {
  const c = d.customers.coverage;
  return `${int(d.customers.audience.buyers)} Khoj buyers · Khoj orders since ${dateOfMin(d.customers.audience.sinceFirst)} · ShopDeck history ${dateOfMin(c.from)} to ${dateOfMin(c.to)} · cancelled orders left out · RTO is of delivered + returned orders`;
}

function viewAudience(d, mode = 'quality') {
  const cu = d.customers;
  const overlapMissing = `<section class="card"><div class="card-head"><h2>Cannibalisation · Khoj × parent seller</h2>${chip('amber', 'Not connected')}</div><p class="small muted">Set <code>MB_Q_OVERLAP</code> to the overlap question (Q16494).</p></section>`;
  const later = planned('Still to come', 'Next steps on top of this data', [
    ['Next-best product per customer', ['Top hero products per customer from their orders, browsing, category affinity and price band', 'Export as Meta custom audiences']],
    ['Browsed but didn\'t buy on Khoj', ['Khoj visitors who never ordered: what they looked at, matched to their ShopDeck history']]
  ], [['Khoj buyers\' browsing (MB_Q_BROWSING)', 'sql/khoj_buyer_browsing.sql']]);
  if (!cu || cu.error || !cu.audience) return mode === 'data' ? historyMissing('Personalisation potential') + visitorPersonalisationCard(d) : historyMissing('Customer quality') + (d.overlap ? overlapCard(d) : overlapMissing) + later;
  const a = cu.audience, pr = a.predict, pa = a.parent, cmp = a.compare;
  const recent7 = a.byRecency.find((x) => x.key === 'Within 7 days');
  const who = card('Who buys on Khoj', 'Who buys on Khoj', historySub(d), kpiRow([
    ['New to ShopDeck', pc(a.newToSdPct, 1), 'ShopDeck marks their Khoj order as their first ever ShopDeck order (all time, not just 12 months)'],
    ['No ShopDeck order in the 12 months before', pc(a.noPriorPct, 1), 'new or lapsed when they found Khoj'],
    ['Power users', pc(a.powerPct, 1), '4+ ShopDeck orders in the 12 months before their first Khoj order'],
    ['Bought on ShopDeck in the 7 days before', pc(recent7?.share, 1), 'active shoppers when Khoj reached them'],
    ['Already a customer of the parent seller', pc(pa.beforePct, 1), 'bought from the seller whose product they bought on Khoj']
  ]) + `<div class="grid-2">
      ${tbl(segCols('ShopDeck history'), a.byUserType)}
      ${tbl(segCols('Last ShopDeck order before Khoj'), a.byRecency)}
      ${tbl(segCols('First Khoj category'), a.byCategory)}
      ${tbl(segCols('Payment, first Khoj order'), a.byPayment)}
    </div>
    <details><summary class="small">By state (from pincode)</summary><div style="margin-top:8px">${tbl(segCols('State'), a.byState)}</div></details>`);
  const P = a.personalisation;
  const lvl = P ? P.levels : [];
  const predict = !P ? '' : card('Personalisation potential', 'Could we have predicted the order? Personalisation potential · buyers', `Share of ${int(P.orders)} Khoj orders that the customer's earlier signals pointed to, by how specific the signal was and how recent. Earlier orders on any ShopDeck site (and earlier Khoj visits) count; browsing comes next.`, kpiRow([
    ['Predictable from the last 7 days', pc((P.browsing ? P.browsing.levels.find((x) => x.key === 'all_any') : lvl.find((x) => x.key === 'any'))?.d7, 1), P.browsing ? 'orders or browsing: same product, seller, L4 or test category' : 'from orders: same product, seller, L4 or test category'],
    ['Predictable from the last 30 days', pc((P.browsing ? P.browsing.levels.find((x) => x.key === 'all_any') : lvl.find((x) => x.key === 'any'))?.d30, 1), `${pc(P.active.d30)} of orders had any ShopDeck order in those 30 days`],
    ['Predictable from 12 months', pc(lvl.find((x) => x.key === 'any')?.d365, 1), `${pc(P.active.d365)} had any order in 12 months`],
    ['Same L4, last 30 days', pc(lvl.find((x) => x.key === 'l4')?.d30, 1), 'the specific signal a feed can use']
  ]) + tbl([
    { h: 'Earlier signal', v: (r) => (r.key === 'all_any' ? `<strong>${esc(r.label)}</strong>` : esc(r.label)) },
    { h: 'Last 3 days', r: 1, v: (r) => pc(r.d3, 1) }, { h: 'Last 7 days', r: 1, v: (r) => pc(r.d7, 1) },
    { h: 'Last 30 days', r: 1, v: (r) => pc(r.d30, 1) }, { h: 'Last 12 months', r: 1, v: (r) => pc(r.d365, 1) }
  ], [...lvl.map((r) => ({ ...r, label: `Ordered: ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}` })), ...(P.browsing ? P.browsing.levels : [{ label: 'Browsed: waiting for the browsing question', d3: null, d7: null, d30: null, d365: null }])], { min: 720 })
  + `<div style="margin-top:4px">${tbl([
    { h: 'Khoj order category', v: (r) => esc(r.key) }, { h: 'Orders', r: 1, v: (r) => int(r.orders) },
    { h: 'Any signal, 7 days', r: 1, v: (r) => pc(r.any_7, 1) }, { h: 'Same L4, 30 days', r: 1, v: (r) => pc(r.l4_30, 1) },
    { h: 'Same test category, 30 days', r: 1, v: (r) => pc(r.cat_30, 1) }, { h: 'Same test category, 12 months', r: 1, v: (r) => pc(r.cat_365, 1) }, { h: 'Same seller, 12 months', r: 1, v: (r) => pc(r.seller_365, 1) }
  ], P.byCat, { min: 860 })}</div>
  <p class="small muted">${P.browsing ? `Browsing: product pages on ShopDeck sites (Khoj left out), tied to ${pc(P.browsing.linkedBuyers)} of Khoj buyers through their user id; buyers who browsed logged out can't be seen, so browsing rows read low.` : 'Browsing rows appear once the browsing question (MB_Q_BROWSING) is connected.'} L4 is only known for ${pc(cu.coverage.sdCategoryKnown)} of earlier ShopDeck orders, so the L4 row reads low; test category also uses product names. Buyer-level view: of ${int(a.withPrior)} buyers with history, ${pc(pr.sameCat, 1)} had bought the same test category and ${pc(pr.sameSeller, 1)} from the same parent seller.</p>`);
  const cc = (k) => ({ h: `Bought ${k} before`, r: 1, v: (r) => pc(r[k]), cls: (r) => (r.key === k ? 'good' : '') });
  const cross = card('Cross-category purchases', 'Cross-category purchases', 'Of buyers with ShopDeck history: what they had bought before, by what they bought first on Khoj', tbl([
    { h: 'First Khoj category', v: (r) => esc(r.key) }, { h: 'Buyers', r: 1, v: (r) => int(r.known) },
    cc('Saree'), cc('Kurti & Suits'), cc('Jewellery'), cc('Other'),
    { h: 'New category for them', r: 1, v: (r) => pc(r.newCategory), cls: (r) => (r.newCategory > 30 ? 'warn' : '') }
  ], a.crossCat, { min: 860 }) + '<p class="small muted">Rows add to more than 100%: a buyer can have bought several categories. "New category for them" = never bought that category on ShopDeck in the 12 months before.</p>');
  const journeys = card('Buying journeys', 'Buying journeys', 'Their last two category moves on ShopDeck (by month, a category repeated month after month counts once), then what they bought on Khoj', tbl([
    { h: 'Journey', v: (r) => esc(r.key) }, { h: 'Buyers', r: 1, v: (r) => int(r.buyers) }, { h: 'Share', r: 1, v: (r) => pc(r.share, 1) },
    { h: 'Example', v: (r) => `<span class="small muted">${esc(r.example || '')}</span>` }
  ], a.journeys, { min: 860 }));
  const rows = [
    ['Orders', (x) => int(x.orders)], ['AOV', (x) => inr(x.aov)], ['COD share', (x) => pc(x.codPct, 1)],
    ['Cancelled', (x) => pc(x.cancelPct, 1)], ['RTO (of delivered + returned)', (x) => pc(x.rtoPct, 1)], ['Delivered so far', (x) => pc(x.deliveredPct, 1)]
  ];
  const compare = card('Khoj vs ShopDeck sellers', 'Khoj vs the same customers on ShopDeck sellers', 'Same people, two storefronts. Khoj orders are recent, so more of them are still in transit.', tbl([
    { h: 'Metric', v: (r) => esc(r[0]) }, { h: 'On Khoj', r: 1, v: (r) => r[1](cmp.khoj) },
    { h: 'On ShopDeck sellers, before Khoj', r: 1, v: (r) => r[1](cmp.shopdeckBefore) }, { h: 'On ShopDeck sellers, all 12 months', r: 1, v: (r) => r[1](cmp.shopdeck) }
  ], rows));
  const parent = card('Parent seller before and after', 'The parent seller, before and after Khoj', `Of all ${int(pa.buyers)} Khoj buyers · median ${pa.medianDaysSinceFirst === null ? '—' : pa.medianDaysSinceFirst.toFixed(0)} days since their first Khoj order, so "after" is early`, kpiRow([
    ['Bought from the parent seller before', pc(pa.beforePct, 1), `the same product: ${pc(pa.beforeProductPct, 1)}`],
    ['Bought from the parent seller after', pc(pa.afterPct, 1), `the same product: ${pc(pa.afterProductPct, 1)}`],
    ['Bought from any ShopDeck seller after', pc(pa.afterAnyPct, 1), 'Khoj excluded']
  ]) + tbl([
    { h: 'Parent seller', v: (r) => `<span class="num">${esc(r.key)}</span>` }, { h: 'Khoj buyers', r: 1, v: (r) => int(r.buyers) },
    { h: 'Bought from them before', r: 1, v: (r) => pc(r.beforePct, 1), cls: (r) => (r.beforePct > 25 ? 'bad' : '') }, { h: 'Same product before', r: 1, v: (r) => pc(r.beforeProductPct, 1) },
    { h: 'Bought from them after', r: 1, v: (r) => pc(r.afterPct, 1) }, { h: 'Any seller after', r: 1, v: (r) => pc(r.afterAnyPct, 1) }
  ], a.parentBySeller, { min: 760 }));
  if (mode === 'data') return predict + visitorPersonalisationCard(d);
  return qualityTopCard(d) + who + compare + cross + journeys + customersCard(d) + parent + (d.overlap ? overlapCard(d) : overlapMissing) + later;
}

function visitorPersonalisationCard(d) {
  const V = d.visitorPersonalisation;
  if (!V) return card('Personalisation potential visitors', 'Personalisation potential · visitors', 'Every Khoj session, not just buyers: if the first product had matched what the visitor ordered or browsed on ShopDeck, how much would conversion go up?', `<p class="small muted">Needs the visitor personalisation question: save sql/visitor_personalisation.sql in Metabase with a Text variable <code>khoj_products</code> (not required), and set <code>MB_Q_PERSONALISE</code> on Netlify.</p>`, chip('amber', 'Not connected'));
  const E = V.estimate;
  const up = (e) => (e ? `${pc(V.conversionPct, 2)} → ${pc(e.newConversionPct, 2)}` : '—');
  return card('Personalisation potential visitors', 'Personalisation potential · visitors', `${int(V.sessions)} Khoj sessions in the last 14 days. A signal = an order or a product page browsed on a ShopDeck seller site in the 30 days before the session. Conversion = sessions with an order.`, kpiRow([
    ['Identified when they landed', pc(V.linkedPct, 1), 'signed in to ShopDeck on the device, so a landing could be personalised'],
    ['Had a signal in 30 days', pc(V.signalPct, 1), 'something to personalise on'],
    ['Landed on a match', pc(V.matchedPct, 1), `converted ${pc(V.matchedCr, 2)} vs ${pc(V.noMatchCr, 2)} when unrelated`],
    ['Conversion if personalised', up(E.conservative), E.conservative ? `+${pc(E.conservative.liftPct, 0)} orders (category match); up to ${pc(E.optimistic?.newConversionPct, 2)} at any-match rates` : 'needs matched and unmatched sessions']
  ]) + tbl([
    { h: 'Sessions where the visitor…', v: (r) => esc(r.label) }, { h: 'Sessions', r: 1, v: (r) => int(r.sessions) }, { h: 'Share', r: 1, v: (r) => pc(r.share, 1) },
    { h: 'Buy-now', r: 1, v: (r) => pc(r.buyNowPct, 1) }, { h: 'Conversion', r: 1, v: (r) => pc(r.conversionPct, 2) }
  ], V.levels, { min: 760 }) + `<div style="margin-top:4px">${tbl([
    { h: 'Landing category', v: (r) => esc(r.key) }, { h: 'Sessions', r: 1, v: (r) => int(r.sessions) }, { h: 'Conversion', r: 1, v: (r) => pc(r.conversionPct, 2) },
    { h: 'With a signal', r: 1, v: (r) => pc(r.signalPct) }, { h: 'Landed on a match', r: 1, v: (r) => pc(r.matchedPct) },
    { h: 'Conversion: match', r: 1, v: (r) => pc(r.matchedCr, 2) }, { h: 'Conversion: unrelated', r: 1, v: (r) => pc(r.noMatchCr, 2) }
  ], V.byCat, { min: 860 })}</div><div style="margin-top:4px">${tbl([
    { h: 'Signal', v: (r) => esc(r.label) }, { h: 'Sessions', r: 1, v: (r) => int(r.sessions) }, { h: 'Landed on a match', r: 1, v: (r) => pc(r.matchedPct) },
    { h: 'Conversion: match', r: 1, v: (r) => pc(r.matchedCr, 2) }, { h: 'Conversion: unrelated', r: 1, v: (r) => pc(r.noMatchCr, 2) }
  ], V.bySignal, { min: 720 })}</div>
  <p class="small muted">How the estimate works: the ${pc(E.personalisablePct, 1)} of sessions that had a signal but landed on something unrelated are given the conversion of sessions that landed in a matching category (conservative) or on any match (optimistic). It's an upper bound, not a promise: visitors who landed on a match partly chose to click an ad for something they like. An A/B test on personalised landing would give the true number.</p>`);
}

// ---------- Customer table (loaded from /api/customers when the Audience tab opens) ----------
const custUi = { page: 0, type: '', cat: '', state: '', pay: '', repeat: '', seller: '', q: '' };
const CUST_PAGE = 25;
async function loadCustomers() {
  if (ui.custLoading) return;
  ui.custLoading = true;
  try {
    const r = await fetch('/api/customers');
    ui.custRows = r.ok ? (await r.json()).rows || [] : [];
  } catch { ui.custRows = []; }
  ui.custLoading = false;
  if ($('custTable')) $('custTable').innerHTML = custTableInner();
}
function customersCard(d) {
  if (!ui.custRows) setTimeout(loadCustomers, 0);
  return `<section class="card" aria-label="Customers">
    <div class="card-head"><div><h2>Customers</h2><span class="muted small">Every Khoj buyer: their ShopDeck journey, their Khoj orders and a one-line read · newest first · click a row for the full timeline</span></div></div>
    <div id="custTable">${custTableInner()}</div>
    <p class="small muted">Timelines include product pages each buyer browsed on ShopDeck sites before Khoj, when the browsing question is connected and the browser was signed in.</p>
  </section>`;
}
function custFiltered() {
  const q = custUi.q.trim().toLowerCase();
  return (ui.custRows || []).filter((r) => (!custUi.type || r.type === custUi.type) && (!custUi.cat || (r.khojCat || 'Unmatched') === custUi.cat)
    && (!custUi.state || (r.state || 'Unknown') === custUi.state) && (!custUi.pay || r.pay === custUi.pay)
    && (!custUi.repeat || String(r.repeat) === custUi.repeat) && (!custUi.seller || String(r.sellerBefore) === custUi.seller)
    && (!q || r.id.toLowerCase().includes(q) || (r.read || '').toLowerCase().includes(q) || r.steps.some((s) => (s.name || '').toLowerCase().includes(q) || (s.seller || '').toLowerCase().includes(q))));
}
function custTableInner() {
  if (!ui.custRows) return '<p class="muted small">Loading customers…</p>';
  const all = ui.custRows;
  const opts = (key, label, values) => `<label class="filter"><span class="small muted">${label}</span><select data-cf="${key}"><option value="">All</option>${values.map(([v, l]) => `<option value="${esc(v)}" ${custUi[key] === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
  const uniq = (f) => [...new Set(all.map(f))].sort().map((v) => [v, v]);
  const rows = custFiltered();
  const pages = Math.max(1, Math.ceil(rows.length / CUST_PAGE));
  if (custUi.page >= pages) custUi.page = pages - 1;
  const shown = rows.slice(custUi.page * CUST_PAGE, (custUi.page + 1) * CUST_PAGE);
  const stName = { D: 'delivered', R: 'RTO', O: 'in transit' };
  const when = (m) => new Date(m * 60000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
  const body = shown.map((r) => `<tr class="cust">
      <td><details><summary><span class="num">…${esc(r.id.slice(-6))}</span><span class="muted small"> · ${esc(r.type)}${r.state ? ' · ' + esc(r.state) : ''}</span></summary>
        <ol class="timeline">${r.steps.map((s) => `<li class="${s.khoj ? 'khoj' : s.browse ? 'browse' : ''}"><span class="num small muted">${when(s.t)}</span> ${s.khoj ? chip('blue', 'Khoj') : s.browse ? chip('muted', 'Browsed') : ''} <strong>${esc(s.cat || '—')}</strong>${s.l4 ? ` <span class="muted small">${esc(s.l4)}</span>` : ''} · ${esc(s.name || 'product')} <span class="muted small">· ${esc(s.seller)}${s.browse ? ` · ${int(s.views)} view${s.views > 1 ? 's' : ''}` : ` · ${inr(s.g)}${s.st !== 'D' ? ' · ' + (stName[s.st] || '') : ''}`}</span></li>`).join('')}</ol>
      </details></td>
      <td>${esc(r.khojCat || '—')}<div class="muted small">${when(r.firstKhoj)} · ${int(r.khojOrders)} order${r.khojOrders > 1 ? 's' : ''} · ${inr(r.khojGmv)} · ${r.pay}${r.firstState === 'R' ? ' · RTO' : ''}</div></td>
      <td class="r num">${int(r.priorOrders)}<div class="muted small">${int(r.priorSellers)} seller${r.priorSellers === 1 ? '' : 's'}${r.lastGap !== null ? ` · last ${r.lastGap === 0 ? 'same day' : r.lastGap + 'd before'}` : ''}</div></td>
      <td class="small">${esc(r.journey || '—')}${r.khojCat ? ` <span class="muted">⇒ Khoj ${esc(r.khojCat)}</span>` : ''}</td>
      <td class="small">${esc(r.read)}</td></tr>`).join('');
  return `<div class="filters">
      ${opts('type', 'ShopDeck history', uniq((r) => r.type))}
      ${opts('cat', 'Khoj category', uniq((r) => r.khojCat || 'Unmatched'))}
      ${opts('state', 'State', uniq((r) => r.state || 'Unknown'))}
      ${opts('pay', 'Payment', [['COD', 'COD'], ['Prepaid', 'Prepaid']])}
      ${opts('repeat', 'Came back to Khoj', [['true', 'Yes'], ['false', 'Not yet']])}
      ${opts('seller', 'Parent seller\'s customer before', [['true', 'Yes'], ['false', 'No']])}
      <label class="filter grow"><span class="small muted">Search</span><input type="search" data-cf="q" value="${esc(custUi.q)}" placeholder="Product, seller, read, id"></label>
    </div>
    <div class="table-box"><table style="min-width:980px"><thead><tr><th>Customer</th><th style="width:150px">On Khoj</th><th class="r" style="width:120px">ShopDeck orders before</th><th style="width:230px">Journey before Khoj</th><th style="width:260px">Read</th></tr></thead>
      <tbody>${body || '<tr><td colspan="5" class="muted">No customers match.</td></tr>'}</tbody></table></div>
    <div class="pager"><span class="muted small">${int(rows.length)} of ${int(all.length)} customers · page ${custUi.page + 1} of ${pages}</span>
      <span><button type="button" class="btn" data-cpage="-1" ${custUi.page === 0 ? 'disabled' : ''}>Previous</button> <button type="button" class="btn" data-cpage="1" ${custUi.page >= pages - 1 ? 'disabled' : ''}>Next</button></span></div>`;
}

function viewRepeat(d) {
  const cu = d.customers, B = d.repeatBench;
  const pending = '<span class="muted small">waiting for the benchmark</span>';
  const later = B ? '' : planned('Compare against the parent sellers', 'Every view here gets a column for the parent sellers\' own sites, weighted by Khoj orders', [
    ['Repeat curves', ['7 / 14 / 28-day repeat on the parent sellers\' own sites']],
    ['What they come back for', ['Same product vs another product']],
    ['Segments', ['Repeat by payment and by new vs returning to ShopDeck']]
  ], [DATA_BENCH]);
  if (!cu || cu.error || !cu.repeat) return historyMissing('Repeat behaviour') + later;
  const r = cu.repeat, k = r.kinds;
  const w = (n) => r.curves.find((c) => c.days === n);
  const bv = (key) => (B ? benchCell(B.rates[key]) : pending);
  const benchNote = B ? `Parent sellers = the own sites of the sellers whose products Khoj sold, each weighted by its Khoj orders (${int(B.sellers)} sellers, ${pc(B.coverage)} of Khoj orders covered). Their repeat is to the same site, from first orders with that seller in the last 120 days, the same way Khoj is one storefront.` : '';
  const head = card('Do Khoj buyers come back', 'Do Khoj buyers come back?', `A repeat is another order more than ${int(r.sessionMinutes)} minutes after the first (buy-now places one order per item). Each window counts only buyers whose first order is at least that old.`, kpiRow([
    ['Back on Khoj within 7 days', w(7).khoj.eligible ? pc(w(7).khoj.pct, 1) : '—', `parent sellers: ${B ? pc(B.rates.d7, 1) : 'pending'}`],
    ['Back on Khoj within 14 days', w(14).khoj.eligible ? pc(w(14).khoj.pct, 1) : '—', `parent sellers: ${B ? pc(B.rates.d14, 1) : 'pending'}`],
    ['Back on Khoj within 28 days', w(28).khoj.eligible ? pc(w(28).khoj.pct, 1) : '—', w(28).khoj.eligible ? `parent sellers: ${B ? pc(B.rates.d28, 1) : 'pending'}` : `no Khoj buyer is 28 days old yet · parent sellers: ${B ? pc(B.rates.d28, 1) : 'pending'}`],
    ['Ordered from another ShopDeck seller within 7 days', pc(w(7).otherSellers.pct, 1), `the parent seller: ${pc(w(7).parentSeller.pct, 1)}`]
  ]) + tbl([
    { h: 'Window', v: (x) => `${x.days} days` },
    { h: 'Back on Khoj', r: 1, v: (x) => nOf(x.khoj) },
    { h: 'Parent sellers\' own sites (Khoj-weighted)', r: 1, v: (x) => bv(`d${x.days}`) },
    { h: 'After Khoj: another ShopDeck seller', r: 1, v: (x) => nOf(x.otherSellers) }
  ], r.curves, { min: 760 }) + (benchNote ? `<p class="small muted">${benchNote}</p>` : ''));
  const cohorts = card('Cohorts', 'By week of first Khoj order', 'Repeat rate among buyers in the week whose first order is old enough for the window', tbl([
    { h: 'Week of', v: (x) => esc(x.week === 'bench' ? 'Parent sellers (Khoj-weighted)' : fmtDate(x.week)) }, { h: 'Buyers', r: 1, v: (x) => (x.week === 'bench' ? '' : int(x.customers)) },
    { h: '7 days', r: 1, v: (x) => (x.week === 'bench' ? bv('d7') : nOf(x.w7)) }, { h: '14 days', r: 1, v: (x) => (x.week === 'bench' ? bv('d14') : nOf(x.w14)) }, { h: '28 days', r: 1, v: (x) => (x.week === 'bench' ? bv('d28') : nOf(x.w28)) }
  ], [...r.cohorts, { week: 'bench' }]));
  const share = (n) => pc(k.lines ? n / k.lines * 100 : null);
  const what = card('What they come back for', 'What they come back for', `${int(k.lines)} repeat Khoj order lines`, kpiRow([
    ['The same product', share(k.sameProduct), `parent sellers: ${B ? pc(B.sameProductPct) : 'pending'}`],
    ['Another product, same L4', share(k.sameL4), `${int(k.sameL4)} lines`],
    ['Another category', share(k.otherL4), `${int(k.otherL4)} lines`],
    ['From another parent seller', share(k.otherParent), 'cross-seller repeat, the marketplace thesis; a seller site can\'t do this']
  ]));
  const segRows = Object.entries(r.seg14).map(([key, v]) => ({ key, v, b: B ? B.segments[key] : null }));
  const segs = card('Repeat by segment', 'Repeat by segment · 14 days', 'Buyers whose first order is at least 14 days old', tbl([
    { h: 'Segment', v: (x) => esc(x.key) }, { h: 'Back on Khoj', r: 1, v: (x) => nOf(x.v) }, { h: 'Parent sellers\' own sites (Khoj-weighted)', r: 1, v: (x) => (B ? benchCell(x.b) : pending) }
  ], segRows));
  return head + cohorts + what + segs + later;
}

function rcaCard(S) {
  const R = S.rca;
  if (!R) return '';
  const toneCls = { bad: 'notice-orange', good: 'notice-green', info: 'notice-amber' };
  const f2 = (v) => (v === null || v === undefined ? '—' : v.toFixed(2));
  const eff = (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  const segTbl = (title, D) => tbl([
    { h: title, v: (r) => esc(r.key === 'new' ? 'New visitors' : r.key === 'returning' ? 'Returning visitors' : r.key) },
    { h: 'Share of sessions: Khoj', r: 1, v: (r) => pc(r.khojShare) }, { h: 'Sellers\' sites', r: 1, v: (r) => pc(r.benchShare) },
    { h: 'Products / session: Khoj', r: 1, v: (r) => f2(r.khojRate) }, { h: 'Sellers\' sites', r: 1, v: (r) => f2(r.benchRate), cls: (r) => (r.khojRate !== null && r.benchRate !== null && r.khojRate < r.benchRate ? 'bad' : '') },
    { h: '2+ products: Khoj', r: 1, v: (r) => pc(r.khojMulti) }, { h: 'Sellers\' sites', r: 1, v: (r) => pc(r.benchMulti) }
  ], D.rows, { min: 860 }) + `<p class="small muted">Of the gap in products per session: mix ${eff(D.mixEffect)}, behaviour within each group ${eff(D.rateEffect)}.</p>`;
  const sp = R.sameProduct;
  const body = `
    <div><div class="group-title">1 · Where the funnel loses orders</div><div style="margin-top:8px">${tbl([
      { h: 'Stage', v: (r) => esc(r.label) }, { h: 'Khoj', r: 1, v: (r) => pc(r.khoj, 1) }, { h: 'Sellers\' sites (Khoj-weighted)', r: 1, v: (r) => pc(r.bench, 1) },
      { h: 'Khoj vs them', r: 1, v: (r) => (r.gapPct === null ? '—' : `${r.gapPct >= 0 ? '+' : ''}${r.gapPct.toFixed(0)}%`), cls: (r) => (r.gapPct === null ? '' : r.gapPct < 0 ? 'bad' : 'good') },
      { h: 'Share of the shortfall', r: 1, v: (r) => (r.shareOfGap === null ? '<span class="muted small">ahead</span>' : pc(r.shareOfGap)) }
    ], R.funnel)}</div></div>
    ${R.hasLanding ? `<div><div class="group-title">2 · Who comes: new vs returning visitors</div><div style="margin-top:8px">${segTbl('Visitors', R.visitors)}</div></div>
    ${R.sources ? `<div><div class="group-title">2b · Where they come from: traffic source</div><div style="margin-top:8px">${segTbl('Source (first page of the session)', R.sources)}</div></div>` : ''}
    ${R.devices ? `<div><div class="group-title">2c · Device</div><div style="margin-top:8px">${segTbl('Device', R.devices)}</div></div>` : ''}
    <div><div class="group-title">3 · What they land on: category</div><div style="margin-top:8px">${segTbl('Landing category', R.categories)}</div><p class="small muted">Landing category known for ${pc(R.landingCatCoverage)} of Khoj sessions.</p></div>
    <div><div class="group-title">4 · How deep sessions go</div><div style="margin-top:8px">${tbl([
      { h: 'Products viewed in the session', v: (r) => esc(r.key) }, { h: 'Khoj', r: 1, v: (r) => pc(r.khoj) }, { h: 'Sellers\' sites', r: 1, v: (r) => pc(r.bench) },
      { h: 'Buy-now rate: Khoj', r: 1, v: (r) => pc(r.khojBn, 1) }, { h: 'Sellers\' sites', r: 1, v: (r) => pc(r.benchBn, 1) }
    ], R.depth)}</div></div>` : '<p class="small muted">Levels 2–5 need the updated site sessions query (sql/site_sessions.sql).</p>'}`;
  return card('Seller-level detail', 'Seller-level detail', 'Not product-matched: each parent seller\'s whole site, weighted by Khoj orders. Context for the product-matched view above.', body);
}

function matchedRcaCard(S) {
  const M = S.matched;
  if (!M || !M.products) return '';
  const toneCls = { bad: 'notice-orange', good: 'notice-green', info: 'notice-amber' };
  const f2 = (v) => (v === null || v === undefined ? '—' : v.toFixed(2));
  const eff = (v) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}`);
  const segTbl = (title, D) => !D ? '' : tbl([
    { h: title, v: (r) => esc(r.key === 'new' ? 'New visitors' : r.key === 'returning' ? 'Returning visitors' : r.key) },
    { h: 'Share of sessions: Khoj', r: 1, v: (r) => pc(r.khojShare) }, { h: 'Seller sites, same products', r: 1, v: (r) => pc(r.benchShare) },
    { h: 'Products / session: Khoj', r: 1, v: (r) => f2(r.khojRate) }, { h: 'Seller sites', r: 1, v: (r) => f2(r.benchRate), cls: (r) => (r.khojRate !== null && r.benchRate !== null && r.khojRate < r.benchRate ? 'bad' : '') },
    { h: 'Buy-now: Khoj', r: 1, v: (r) => pc(r.khojBn, 1) }, { h: 'Seller sites', r: 1, v: (r) => pc(r.benchBn, 1) }
  ], D.rows, { min: 900 }) + `<p class="small muted">Of the gap in products per session: mix ${eff(D.mixEffect)}, behaviour within each group ${eff(D.rateEffect)}.</p>`;
  const body = `
    <div style="display:flex;flex-direction:column;gap:8px">${M.findings.map((x) => `<div class="notice ${toneCls[x.tone] || 'notice-amber'}">${esc(x.text)}</div>`).join('')}</div>
    <div><div class="group-title">A · Who comes to the same products: new vs returning visitors</div><div style="margin-top:8px">${segTbl('Visitors', M.visitors)}</div></div>
    ${M.sources ? `<div><div class="group-title">B · Where they come from: traffic source, same products</div><div style="margin-top:8px">${segTbl('Source', M.sources)}</div></div>` : '<p class="small muted">B · Traffic source by product appears once Q16724 has the landing × source rows (sql/site_sessions.sql).</p>'}
    <div><div class="group-title">C · By category</div><div style="margin-top:8px">${tbl([
      { h: 'Category', v: (r) => esc(r.key) }, { h: 'Khoj sessions', r: 1, v: (r) => int(r.khojSessions) },
      { h: 'Products / session: Khoj', r: 1, v: (r) => f2(r.khojRate) }, { h: 'Seller sites', r: 1, v: (r) => f2(r.benchRate), cls: (r) => (r.khojRate < r.benchRate ? 'bad' : '') },
      { h: '2+ products: Khoj', r: 1, v: (r) => pc(r.khojMulti) }, { h: 'Seller sites', r: 1, v: (r) => pc(r.benchMulti) },
      { h: 'Buy-now: Khoj', r: 1, v: (r) => pc(r.khojBn, 1) }, { h: 'Seller sites', r: 1, v: (r) => pc(r.benchBn, 1) },
      { h: 'Effect on the gap', r: 1, v: (r) => eff(r.effect), cls: (r) => (r.effect < 0 ? 'bad' : 'good') }
    ], M.categories, { min: 980 })}</div></div>
    <div><div class="group-title">D · Products that drive the gap</div><div style="margin-top:8px">${tbl([
      { h: 'First product', v: (r) => `${esc(r.name)} <span class="muted small">${esc(r.cat)}</span>` },
      { h: 'Khoj sessions', r: 1, v: (r) => int(r.khojSessions) }, { h: 'Products / session: Khoj', r: 1, v: (r) => f2(r.khojRate) },
      { h: 'Own site', r: 1, v: (r) => f2(r.siteRate) }, { h: 'Own-site sessions', r: 1, v: (r) => int(r.siteSessions) },
      { h: 'Buy-now: Khoj', r: 1, v: (r) => pc(r.khojBn, 1) }, { h: 'Own site', r: 1, v: (r) => pc(r.siteBn, 1) },
      { h: 'Effect on the gap', r: 1, v: (r) => eff(r.effect), cls: (r) => (r.effect < 0 ? 'bad' : 'good') }
    ], M.drags, { min: 980 })}</div></div>`;
  return card('Explore RCA', 'Why Khoj sessions explore less: root cause', `Product-matched: every Khoj session is compared with seller-site sessions that started on the same product, weighted to Khoj's first-product mix · ${int(M.products)} products, ${pc(M.coverage)} of Khoj sessions`, body);
}

function viewCross(d) {
  const S = d.sessions;
  const needs = planned('Cross-selling', 'Does an all-hero marketplace get people to explore and buy beyond the product in the ad?', [
    ['Explore behaviour', ['Products viewed per session, sessions viewing 2+ products, time per session', 'Against the same first products on the parent sellers\' own sites']],
    ['Beyond the landing product', ['Buy-now clicks on a product other than the first one viewed (the ad\'s product), same or another seller and category']]
  ], [DATA_EVENTS]);
  if (!S) return needs;
  const B = S.beyond, M = S.matched;
  const diff = { h: 'Khoj vs them', r: 1, v: (m) => (m.khoj === null || m.bench === null || !m.bench ? '—' : `${m.khoj >= m.bench ? '+' : ''}${(((m.khoj - m.bench) / m.bench) * 100).toFixed(0)}%`), cls: (m) => (m.khoj !== null && m.bench ? ((m.key === 'singlePct' ? m.khoj <= m.bench : m.khoj >= m.bench) ? 'good' : 'bad') : '') };
  const matchedOk = M && M.products > 0;
  const after = S.metrics.filter((m) => ['buyNowToCheckout', 'checkoutToOrder', 'ordersPerSession'].includes(m.key));
  const explore = matchedOk
    ? card('Explore behaviour', 'Explore behaviour: Khoj vs the same products on their own sites', `Last 28 days · each Khoj session compared with seller-site sessions that started on the same product (first product page), weighted to Khoj's first-product mix · ${int(M.products)} products, ${pc(M.coverage)} of ${int(M.khojLandingSessions)} Khoj sessions`, tbl([
        { h: 'Metric', v: (m) => esc(m.label) }, { h: 'Khoj', r: 1, v: (m) => benchCell(m.khoj, m.unit) },
        { h: 'Same first products, seller sites', r: 1, v: (m) => benchCell(m.bench, m.unit) }, diff
      ], M.metrics) + `<p class="small muted">Not matched: ${M.unmatched.map((u) => `${pc(u.share)} ${esc(u.reason)}`).join(' · ') || 'none'}. After the click (seller level, not product-matched): ${after.map((m) => `${esc(m.label)} ${benchCell(m.khoj, m.unit)} vs ${benchCell(m.bench, m.unit)}`).join(' · ')}.</p>`)
    : card('Explore behaviour', 'Explore behaviour: Khoj vs the parent sellers\' own sites', `Last 28 days · ${int(S.khojSessions)} Khoj sessions · parent sellers weighted by Khoj orders (${int(S.parentSellers)} sellers) · product matching needs the landing rows from sql/site_sessions.sql`, tbl([
        { h: 'Metric', v: (m) => esc(m.label) }, { h: 'Khoj', r: 1, v: (m) => benchCell(m.khoj, m.unit) },
        { h: 'Parent sellers (Khoj-weighted)', r: 1, v: (m) => benchCell(m.bench, m.unit) }, diff
      ], S.metrics));
  const beyond = card('Beyond the landing product', 'Beyond the landing product', `Khoj buy-now clicks by the session's first product page (in practice, the ad's product) · ${int(B.clicks)} session-product clicks`, kpiRow([
    ['Clicked a different product', pc(B.otherPct, 1), 'than the one they landed on'],
    ['…from another seller', pc(B.otherAnotherSellerPct, 1), 'of those, a different parent seller'],
    ['…in another category', pc(B.otherAnotherCatPct, 1), 'of those, a different test category']
  ]) + tbl([
    { h: 'Landed on', v: (x) => `${esc(x.from)} <span class="muted small">${esc(x.fromCat)}</span>` },
    { h: 'Clicked buy-now on', v: (x) => `${esc(x.to)} <span class="muted small">${esc(x.toCat)}${x.sameSeller ? ' · same seller' : ''}</span>` },
    { h: 'Sessions', r: 1, v: (x) => int(x.sessions) }
  ], B.topPairs, { min: 760 }));
  return explore + beyond + matchedRcaCard(S) + rcaCard(S);
}

// ---------- Charts (inline SVG, no library) ----------
function chartSvg({ labels, bars = null, lines = [], refLine = null, height = 180, yFmt = (v) => v, barColor = 'var(--blue)', barLabel = '', yCap = null }) {
  const W = 760, H = height, pl = 44, pr = 12, pt = 12, pb = 26;
  const n = labels.length; if (!n) return '';
  const vals = [...(bars || []), ...lines.flatMap((l) => l.values), ...(refLine ? [refLine.value] : [])].filter((v) => v !== null && Number.isFinite(v));
  const max = Math.min(Math.max(...vals, 0), yCap ?? Infinity) * 1.12 || 1;
  const clip = (v) => (v === null ? null : Math.min(v, max));
  const x = (i) => pl + ((W - pl - pr) * (i + 0.5)) / n, y = (v) => pt + (H - pt - pb) * (1 - Math.min(v, max) / max);
  const bw = Math.max(2, ((W - pl - pr) / n) * 0.62);
  const ticks = [0, 0.5, 1].map((f) => max * f / 1.12);
  const grid = ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(yFmt(v))}</text>`).join('');
  const barsSvg = bars ? bars.map((v, i) => v === null ? '' : `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, H - pb - y(v))}" rx="2" fill="${barColor}" opacity=".28"><title>${esc(labels[i])}: ${esc(yFmt(v))} ${esc(barLabel)}</title></rect>`).join('') : '';
  const linesSvg = lines.map((l) => {
    const pts = l.values.map((v, i) => (v === null || !Number.isFinite(v) ? null : `${x(i)},${y(v)}`)).filter(Boolean);
    return `<polyline points="${pts.join(' ')}" fill="none" stroke="${l.color}" stroke-width="${l.width || 2}" ${l.dash ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>` + (l.dots ? l.values.map((v, i) => (v === null ? '' : `<circle cx="${x(i)}" cy="${y(v)}" r="2.5" fill="${l.color}" opacity=".55"><title>${esc(labels[i])}: ${esc(yFmt(v))}</title></circle>`)).join('') : '');
  }).join('');
  const ref = refLine ? `<line x1="${pl}" x2="${W - pr}" y1="${y(refLine.value)}" y2="${y(refLine.value)}" stroke="${refLine.color}" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W - pr}" y="${y(refLine.value) - 5}" text-anchor="end" font-size="10" fill="${refLine.color}">${esc(refLine.label)}</text>` : '';
  const step = Math.ceil(n / 8);
  const xl = labels.map((l, i) => (i % step === 0 || i === n - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${esc(l)}</text>` : '')).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" style="display:block;max-width:100%">${grid}${barsSvg}${ref}${linesSvg}${xl}</svg>`;
}
const legend = (items) => `<div class="small muted" style="display:flex;gap:14px;flex-wrap:wrap">${items.map(([c, l, dash]) => `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:16px;height:0;border-top:2px ${dash ? 'dashed' : 'solid'} ${c}"></span>${esc(l)}</span>`).join('')}</div>`;
const delta = (a, b, { pts = false, inverse = false, d = 0 } = {}) => {
  if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return '';
  const v = pts ? a - b : b ? ((a - b) / b) * 100 : null; if (v === null) return '';
  const good = inverse ? v < 0 : v > 0;
  return `<span class="${Math.abs(v) < 0.05 ? 'muted' : good ? 'good' : 'bad'}">${v >= 0 ? '+' : ''}${v.toFixed(pts ? 1 : d)}${pts ? ' pts' : '%'}</span>`;
};
const shortDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

// ---------- Overall Status ----------
function viewStatus(d) {
  const O = d.overview;
  if (!O) return card('Overall Status', 'Overall Status', '', '<p class="small muted">Connect the day-wise question: set <code>MB_Q_DAYWISE</code> = 16083 (and <code>MB_Q_PNL</code> = 16167 for the P&amp;L) on Netlify.</p>', chip('amber', 'Not connected'));
  const L = O.last7, P = O.prev7, PL = O.pnl.last7, PP = O.pnl.prev7;
  const toneCls = { bad: 'notice-orange', good: 'notice-green', info: 'notice-amber' };
  const pnlLabel = PL ? (PL.window === 'last7' ? 'last 7 days' : `${shortDate(PL.start)}${PL.end !== PL.start ? '–' + shortDate(PL.end) : ''}`) : '';
  const head = card('Where we are', 'Where we are', `Last 7 days (${shortDate(L.from)}–${shortDate(L.to)}) vs the 7 before · today so far: ${O.todayRow ? `${int(O.todayRow.orders)} orders, ${inr(O.todayRow.gmv)} GMV` : '—'}`,
    `<p style="margin:0;font-size:15px;line-height:1.55">${esc(O.verdict)}</p>` + kpiRow([
      ['Orders / day', int(L.ordersPerDay), ''], ['GMV / day', inr(L.gmvPerDay), ''], ['Spend / day', inr(L.spendPerDay), ''],
      ['Spend / GMV', pc(L.sgmv, 1), O.breakevenAdSgmv ? `breakeven ~${pc(O.breakevenAdSgmv, 1)}` : ''], ['AOV', inr(L.aov), ''],
      ['Online orders', pc(L.onlinePct, 1), ''], ['Cancelled', pc(L.cancelPct, 1), ''],
      ['RTO', PL ? pc(PL.rtoPct, 1) : '—', PL ? `P&L, ${pnlLabel}` : 'connect MB_Q_PNL'], ['Profit (of NMV)', PL ? pc(PL.profitPct, 1) : '—', PL ? `${inr(PL.perOrder?.profit)} per shipped order` : '']
    ]) +
    `<div class="small" style="display:flex;gap:16px;flex-wrap:wrap">Week on week: orders/day ${delta(L.ordersPerDay, P.ordersPerDay)} · GMV/day ${delta(L.gmvPerDay, P.gmvPerDay)} · spend/day ${delta(L.spendPerDay, P.spendPerDay)} · Spend/GMV ${delta(L.sgmv, P.sgmv, { pts: true, inverse: true })} · AOV ${delta(L.aov, P.aov)} · online ${delta(L.onlinePct, P.onlinePct, { pts: true })} · cancelled ${delta(L.cancelPct, P.cancelPct, { pts: true, inverse: true })}${PL && PP ? ` · RTO ${delta(PL.rtoPct, PP.rtoPct, { pts: true, inverse: true })} · profit ${delta(PL.profitPct, PP.profitPct, { pts: true })}` : ''}</div>` +
    (O.flags.length ? `<div style="display:flex;flex-direction:column;gap:8px">${O.flags.map((f) => `<div class="notice ${toneCls[f.tone]}">${esc(f.text)}</div>`).join('')}</div>` : ''));

  const R = O.rolling;
  const lab = R.map((r) => shortDate(r.date));
  const trend = card('Trend', 'How we are trending', 'Daily, since launch · lines are 7-day averages',
    `<div class="grid-2"><div><div class="group-title">Orders per day</div>${chartSvg({ labels: lab, bars: R.map((r) => r.orders), lines: [{ values: R.map((r) => r.orders7), color: 'var(--blue)' }], yFmt: (v) => Math.round(v), barLabel: 'orders' })}${legend([['var(--blue)', '7-day average orders']])}</div>
     <div><div class="group-title">Spend / GMV</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.sgmv), color: 'var(--orange)', width: 1, dots: true }, { values: R.map((r) => r.sgmv7), color: 'var(--orange)' }], refLine: O.breakevenAdSgmv ? { value: O.breakevenAdSgmv, label: `breakeven ~${O.breakevenAdSgmv.toFixed(0)}%`, color: 'var(--green)' } : null, yFmt: (v) => `${Math.round(v)}%`, yCap: 80 })}${legend([['var(--orange)', '7-day Spend/GMV'], ['var(--green)', 'breakeven (P&L)', true]])}</div>
     <div><div class="group-title">Spend and GMV per day (₹)</div>${chartSvg({ labels: lab, bars: R.map((r) => r.gmv), lines: [{ values: R.map((r) => r.spend), color: 'var(--purple)' }], yFmt: (v) => `${Math.round(v / 1000)}k`, barColor: 'var(--green)', barLabel: 'GMV' })}${legend([['var(--green)', 'GMV (bars)'], ['var(--purple)', 'spend']])}</div>
     <div><div class="group-title">Online share and AOV (7-day)</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.online7), color: 'var(--blue)' }], yFmt: (v) => `${Math.round(v)}%` })}${legend([['var(--blue)', 'online orders %']])}</div></div>`);

  const weeks = card('Week by week', 'Week by week', 'Mon–Sun · the current week runs to yesterday · RTO and profit from the P&L question at its predicted RTO for orders in transit', tbl([
    { h: 'Week', v: (w) => `<strong>${esc(w.label)}</strong> <span class="muted small">${shortDate(w.week)}${w.partial ? ` · ${w.days}d` : ''}</span>` },
    { h: 'Orders/day', r: 1, v: (w) => int(w.ordersPerDay) }, { h: 'GMV/day', r: 1, v: (w) => inr(w.gmvPerDay) }, { h: 'Spend/day', r: 1, v: (w) => inr(w.spendPerDay) },
    { h: 'Spend/GMV', r: 1, v: (w) => pc(w.sgmv, 1), cls: (w) => (O.breakevenAdSgmv && w.sgmv !== null ? (w.sgmv <= O.breakevenAdSgmv ? 'good' : w.sgmv <= O.breakevenAdSgmv * 1.25 ? 'warn' : 'bad') : '') },
    { h: 'AOV', r: 1, v: (w) => inr(w.aov) }, { h: 'Online', r: 1, v: (w) => pc(w.onlinePct, 1) }, { h: 'Cancelled', r: 1, v: (w) => pc(w.cancelPct, 1) },
    { h: 'CTR', r: 1, v: (w) => pc(w.ctr, 2) }, { h: 'CPM', r: 1, v: (w) => inr(w.cpm) }, { h: 'Click→order', r: 1, v: (w) => pc(w.c2pr, 2) },
    { h: 'RTO', r: 1, v: (w) => (w.pnl ? pc(w.pnl.rtoPct, 1) : '—') }, { h: 'Profit % (NMV)', r: 1, v: (w) => (w.pnl ? pc(w.pnl.profitPct, 1) : '—'), cls: (w) => (w.pnl ? (w.pnl.profitPct >= 0 ? 'good' : 'bad') : '') }
  ], O.weeks, { min: 1100 }));

  let unit = '';
  if (PL && PL.perOrder) {
    const u = PL.perOrder;
    const lines = [['GMV per shipped order', u.gmv, ''], ['− lost to RTO, returns, discounts', u.nmv - u.gmv, `NMV ${pc(PL.nmvOfGmv, 0)} of GMV`], ['− paid to the seller (TP)', -u.tp, `${pc(PL.tpOfGmv, 0)} of GMV`], ['− logistics', -u.logistics, `${pc(PL.logOfGmv, 0)} of GMV`], ['− marketing', -u.mkt, `${pc(PL.mktOfGmv, 1)} of GMV`], ['= profit', u.profit, `${pc(PL.profitPct, 1)} of NMV`]];
    const max = u.gmv;
    const perPt = (PL.gmv / (PL.shipped || 1)) / 100;   // ₹ per order for each point of marketing/GMV
    unit = card('Unit economics', `Unit economics per shipped order · ${pnlLabel}`, `From the P&L at ${pc(PL.rtoPct, 0)} RTO (${int(PL.delivered)} delivered, ${int(PL.rto)} RTO, predicted for orders in transit)`,
      `<div class="grid-2"><div>${lines.map(([l, v, note], i) => `<div style="display:grid;grid-template-columns:200px 1fr 80px;gap:10px;align-items:center;margin:6px 0"><span class="small">${esc(l)}</span><span class="bar" style="min-width:0"><span style="width:${Math.min(100, Math.abs(v) / max * 100)}%;background:${i === 0 ? 'var(--blue)' : i === lines.length - 1 ? (v >= 0 ? 'var(--green)' : 'var(--orange)') : 'var(--muted)'}"></span></span><span class="num r small ${i === lines.length - 1 ? (v >= 0 ? 'good' : 'bad') : ''}">${inr(v)}</span></div><div class="muted small" style="margin:-4px 0 4px 210px">${esc(note)}</div>`).join('')}</div>
      <div>${kpiRow([
        ['Breakeven marketing', pc(PL.breakevenMktOfGmv, 1), 'of GMV, at this RTO and seller payout'],
        ['Breakeven in ad Spend/GMV', pc(O.breakevenAdSgmv, 1), O.mktToSpend ? `P&L marketing is ${O.mktToSpend.toFixed(2)}× ad spend (tax, other costs)` : ''],
        ['Each point of Spend/GMV', inr(perPt * (O.mktToSpend || 1)), 'per shipped order']
      ])}<p class="small muted">To break even at today's RTO, ad Spend/GMV has to come down to about ${pc(O.breakevenAdSgmv, 1)}, or RTO and seller payout have to improve. Every point of RTO costs roughly ${inr((PL.nmv / Math.max(1, PL.shipped)) / Math.max(1, 100 - (PL.rtoPct || 0)))} of NMV per shipped order.</p></div></div>`);
  }

  const D = O.drivers;
  const drivers = D ? card('Why Spend/GMV moved', `Why Spend/GMV moved ${D.delta >= 0 ? 'up' : 'down'} ${Math.abs(D.delta).toFixed(1)} pts this week`, 'Last 7 days vs the 7 before. Spend/GMV = CPM ÷ (1000 × CTR × click→order × AOV), so the change splits into these four.', tbl([
    { h: 'Driver', v: (r) => esc(r.label) }, { h: 'Effect on Spend/GMV', r: 1, v: (r) => `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} pts`, cls: (r) => (r.points > 0 ? 'bad' : 'good') },
    { h: 'Last 7 days', r: 1, v: (r) => ({ 'CPM (cost of reach)': inr(L.cpm), 'CTR (ad click rate)': pc(L.ctr, 2), 'Click → order rate': pc(L.c2pr, 2), AOV: inr(L.aov) })[r.label] },
    { h: 'The 7 before', r: 1, v: (r) => ({ 'CPM (cost of reach)': inr(P.cpm), 'CTR (ad click rate)': pc(P.ctr, 2), 'Click → order rate': pc(P.c2pr, 2), AOV: inr(P.aov) })[r.label] }
  ], D.rows)) : '';

  // PMF snapshot from the rest of the dashboard.
  const allK = Object.values(d.kpis || {});
  const wins = allK.reduce((a, k) => a + (k.winners || 0), 0), losses = allK.reduce((a, k) => a + (k.losses || 0), 0), tested = allK.reduce((a, k) => a + (k.tested || 0), 0);
  const rp = d.customers?.repeat, b14 = d.repeatBench?.rates?.d14, w14 = rp?.curves?.find((c) => c.days === 14)?.khoj;
  const pers = d.customers?.audience?.personalisation;
  const snap = card('PMF snapshot', 'PMF snapshot', 'Headlines from the PMF View', kpiRow([
    ['Products tested', int(tested), `${int(wins)} winners · ${int(losses)} killed`],
    ['Success rate', wins + losses ? pc(wins / (wins + losses) * 100) : '—', 'winners ÷ decided trials'],
    ['New to ShopDeck', pc(d.customers?.audience?.newToSdPct, 1), 'of Khoj buyers'],
    ['Back within 14 days', w14?.eligible ? pc(w14.pct, 1) : '—', b14 !== undefined && b14 !== null ? `parent sellers: ${pc(b14, 1)}` : ''],
    ['Orders predictable (30 days)', pers ? pc((pers.browsing?.levels.find((x) => x.key === 'all_any') || pers.levels.find((x) => x.key === 'any'))?.d30, 1) : '—', 'from ShopDeck history']
  ]) + `<p class="small"><button type="button" class="btn" data-tab="pmf">Open the PMF View</button></p>`);

  const ops = card('Operations', 'Operations', 'From the day-wise question', kpiRow([
    ['Not dispatched, older than yesterday', int(O.backlog), 'orders'],
    ['Yesterday not dispatched', int(O.daily.find((r) => r.date === O.yesterday)?.notDispatched), `of ${int(O.daily.find((r) => r.date === O.yesterday)?.nonCancelled)} orders`],
    ['Cancelled, last 7 days', pc(L.cancelPct, 1), `${int(L.cancelled)} orders`],
    ['Cost per order', inr(L.cpo), `was ${inr(P.cpo)}`]
  ]));
  return head + trend + unit + drivers + weeks + snap + ops;
}

// ---------- Scaling Plan & Status ----------
function viewPlan(d) {
  const S = d.scaling;
  if (!S) return '';
  const P = S.plan, A = P.assumptions, L = S.labels;
  const pa = (a, p, f, cls) => {   // actual over plan
    const av = a === null || a === undefined ? null : a, pv = p === null || p === undefined ? null : p;
    if (av === null && pv === null) return '—';
    if (av === null) return `<span class="muted">${f(pv)}</span>`;
    return `<div class="${cls ? cls(av, pv) : ''}">${f(av)}</div>${pv !== null ? `<div class="muted small">plan ${f(pv)}</div>` : ''}`;
  };
  const hi = (av, pv) => (pv ? (av >= pv * 0.9 ? 'good' : 'bad') : '');
  const lo = (av, pv) => (pv ? (av <= pv * 1.1 ? 'good' : 'bad') : '');
  const col = (h, get, f, cls) => ({ h, r: 1, v: (r) => {
    const pv = r.plan ? get(r.plan) : null;
    if (!r.actual) return pv === null || pv === undefined ? '—' : `<span class="muted">${f(pv)}</span>`;
    const av = get(r.actual);
    if (av === null || av === undefined || !Number.isFinite(av)) return `<div class="muted">—</div>${pv !== null && pv !== undefined ? `<div class="muted small">plan ${f(pv)}</div>` : ''}`;
    return pa(av, pv, f, cls);
  } });
  const k = (v) => (v === null || v === undefined ? '—' : v >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : inr(v));
  const p1 = (v) => (v === null || v === undefined ? '—' : `${v.toFixed(0)}%`);
  const n0 = (v) => (v === null || v === undefined ? '—' : Math.round(v).toLocaleString('en-IN'));
  const rows = S.rows;
  const table = tbl([
    { h: 'Week', v: (r) => `<strong>${shortDate(r.week)}</strong>${r.current ? ' ' + chip('blue', 'now') : ''}${r.actual?.partial ? `<div class="muted small">${r.actual.days} days so far</div>` : ''}` },
    col('DAS total', (x) => x.das.total, k, hi), col('DAS Meta', (x) => x.das.meta, k), col('DAS Google', (x) => x.das.google, k),
    col('DAS Meta catalog', (x) => x.das.catalog, k), col('DAS Meta winners', (x) => x.das.winners, k), col('DAS testing', (x) => x.das.testing, k),
    col('S/GMV catalog', (x) => x.sgmv.catalog, p1, lo), col('S/GMV winners', (x) => x.sgmv.winners, p1, lo), col('S/GMV testing', (x) => x.sgmv.testing, p1, lo), col('S/GMV Google', (x) => x.sgmv.google, p1, lo),
    col('S/GMV overall', (x) => x.sgmv.overall, p1, lo), col('GMV / day', (x) => x.gmvPerDay, k, hi), col('AOV', (x) => x.aov, inr, hi), col('Orders / day', (x) => x.ordersPerDay, n0, hi),
    col('Tested (lifetime)', (x) => x.testing.tested, n0, hi), col('In testing', (x) => x.testing.inTesting, n0, hi), col('Winners', (x) => x.testing.winners, n0, hi), col('Killed', (x) => x.testing.killed, n0),
    col('Success %', (x) => x.testing.successPct, p1, hi)
  ], rows, { min: 1900 });
  const cur = rows.find((r) => r.current);
  const statusKpis = cur ? kpiRow([
    ['Daily spend', `${k(cur.actual?.das.total)} <span class="muted small">/ ${k(cur.plan?.das.total)}</span>`, 'actual / plan, this week'],
    ['Orders / day', `${n0(cur.actual?.ordersPerDay)} <span class="muted small">/ ${n0(cur.plan?.ordersPerDay)}</span>`, 'actual / plan'],
    ['GMV / day', `${k(cur.actual?.gmvPerDay)} <span class="muted small">/ ${k(cur.plan?.gmvPerDay)}</span>`, 'actual / plan'],
    ['Spend / GMV', `${p1(cur.actual?.sgmv.overall)} <span class="muted small">/ ${p1(cur.plan?.sgmv.overall)}</span>`, 'actual / plan'],
    ['Winners (lifetime)', `${n0(cur.actual?.testing.winners)} <span class="muted small">/ ${n0(cur.plan?.testing.winners)}</span>`, 'actual / plan']
  ]) : '';
  const checks = tbl([
    { h: 'Assumption', v: (c) => `${esc(c.label)}${c.note ? ` <span class="muted small">${esc(c.note)}</span>` : ''}` },
    { h: 'Plan', r: 1, v: (c) => (c.assumed === null ? '—' : c.unit === '₹' ? inr(c.assumed) : `${Math.round(c.assumed)}${c.unit}`) },
    { h: 'Actual', r: 1, v: (c) => (c.actual === null || c.actual === undefined ? '—' : c.unit === '₹' ? inr(c.actual) : `${c.actual.toFixed(c.unit === '%' ? 1 : 0)}${c.unit}`) },
    { h: 'Holding?', r: 1, v: (c) => (c.ok === null ? '<span class="muted small">no data yet</span>' : c.ok ? chip('green', 'On track') : chip('orange', 'Off plan')) }
  ], S.checks);
  const where = card('Where we are', `Where we are · week of ${shortDate(S.currentWeek)}`, 'Actual against plan this week, whether the plan\'s assumptions are holding, and what could stop the plan', statusKpis +
    `<div class="grid-2"><div><div class="group-title">Assumptions</div><div style="margin-top:8px">${checks}</div></div><div><div class="group-title">Risks to the plan</div>${S.risks.length ? `<ul class="small" style="margin:8px 0 0;padding-left:18px;line-height:1.6">${S.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '<p class="small muted">None flagged.</p>'}</div></div>`);
  const weekCard = card('Week-wise plan', 'Week-wise plan and actuals', 'Each cell: actual (green on/above plan, orange behind) with the plan underneath; future weeks show the plan. DAS = daily average spend. Meta S/GMV per bucket is Meta-reported (×' + d.settings.metaSgmvFactor + ' correction) and over-counts across buckets; overall S/GMV is actual orders. Google = day-wise total spend − Meta spend.', table);
  // Editor
  const inp = (name, v, w = 90) => `<input name="${name}" value="${esc(v)}" inputmode="decimal" style="width:${w}px;min-height:34px;border:1px solid var(--line);border-radius:6px;padding:0 6px;background:var(--surface);color:inherit;font:inherit;font-size:13px">`;
  const planWeeks = rows.filter((r) => r.plan).map((r) => r.week);
  const das = ['testing', 'catalog', 'metaOther', 'google'];
  const editor = `<details ${P.saved ? '' : 'open'}><summary style="cursor:pointer;font-weight:600">Edit the plan</summary>
    <form id="planForm" style="margin-top:12px;display:flex;flex-direction:column;gap:14px">
      <div class="settings">${[['aov', 'AOV (₹)', A.aov], ['successPct', 'Trial success %', A.successPct], ['trialBudget', 'Trial budget (₹/day)', A.trialBudget], ['trialDays', 'Days per trial', A.trialDays], ['winnerDas', 'Avg daily budget per winner (₹)', A.winnerDas], ['winnerLifeWeeks', 'Weeks a winner scales', A.winnerLifeWeeks]].map(([n2, l, v]) => `<div class="field"><label>${esc(l)}</label>${inp('a_' + n2, v, 120)}</div>`).join('')}
      ${['testing', 'winners', 'catalog', 'metaOther', 'google'].map((b) => `<div class="field"><label>Spend/GMV % · ${esc(L[b])}</label>${inp('s_' + b, A.sgmv[b], 120)}</div>`).join('')}
      <div class="field"><label>Plan starts (week of)</label>${inp('startWeek', P.startWeek, 120)}</div><div class="field"><label>Weeks</label>${inp('weeks', P.weeks, 120)}</div></div>
      <div class="table-box"><table style="min-width:${200 + planWeeks.length * 100}px"><thead><tr><th>Daily spend (₹)</th>${planWeeks.map((w) => `<th class="r">${shortDate(w)}</th>`).join('')}</tr></thead><tbody>
        ${das.map((b) => `<tr><td>${esc(L[b])}</td>${P.das[b].map((v, i) => `<td class="r">${inp(`d_${b}_${i}`, v, 84)}</td>`).join('')}</tr>`).join('')}
        <tr><td class="muted">Meta winners (from success % × trials)</td>${rows.filter((r) => r.plan).map((r) => `<td class="r muted small">${k(r.plan.das.winners)}</td>`).join('')}</tr>
      </tbody></table></div>
      <div style="display:flex;gap:8px"><button type="submit" class="btn btn-primary">Save plan</button><button type="button" class="btn" id="resetPlan">Reset to default</button></div>
    </form></details>`;
  return where + weekCard + card('Plan editor', 'The plan', P.saved ? 'Saved plan. Winners spend follows from the testing budget, success % and the winner budget.' : 'Default placeholder plan: set your weekly budgets and assumptions and save.', editor);
}

// ---------- PMF View ----------
const PMF_SUBS = [['summary', 'Overall summary'], ['hits', 'Hit % & Scalability'], ['quality', 'Customer Quality'], ['early', 'Early signs: repeats & likability'], ['repeat', 'Actual Repeats'], ['cross', 'Cross Selling'], ['data', 'Using ShopDeck\'s data advantage']];
function viewPmf(d) {
  const sub = PMF_SUBS.some(([k2]) => k2 === ui.sub) ? ui.sub : 'summary';
  const bar = `<div class="seg-tabs" role="tablist" aria-label="PMF View" style="flex-wrap:wrap">${PMF_SUBS.map(([k2, l]) => `<button type="button" class="seg" role="tab" data-sub="${k2}" aria-pressed="${k2 === sub}">${esc(l)}</button>`).join('')}</div>`;
  const body = {
    summary: () => viewPmfSummary(d),
    hits: () => viewRoom(d) + viewCover(d),
    quality: () => viewAudience(d, 'quality'),
    early: () => planned('Early signs on repeats & likability', 'To come', [['What goes here', ['Leading signals that predict repeat before repeat itself shows up: delivery experience, ratings and reviews, wishlist and return visits, post-order survey']]], []),
    repeat: () => viewRepeat(d),
    cross: () => viewCross(d),
    data: () => viewAudience(d, 'data')
  }[sub]();
  return bar + body;
}

function viewPmfSummary(d) {
  const allK = Object.values(d.kpis || {});
  const S = (f) => allK.reduce((a, k) => a + (k[f] || 0), 0);
  const wins = S('winners'), losses = S('losses'), tested = S('tested'), live = S('liveTrials'), scaling = S('scaling');
  const sr = wins + losses ? wins / (wins + losses) * 100 : null;
  const ci = wins + losses ? 1.96 * Math.sqrt((sr / 100) * (1 - sr / 100) / (wins + losses)) * 100 : null;
  const U = d.universe?.byCat; const tc = U ? CATS.reduce((a, c) => ({ h: a.h + (U[c]?.hero || 0), l: a.l + (U[c]?.heroLive || 0) }), { h: 0, l: 0 }) : null;
  const ladder = d.ladder || [];
  const a = d.customers?.audience, cmp = a?.compare;
  const rp = d.customers?.repeat, RB = d.repeatBench;
  const w7 = rp?.curves.find((c) => c.days === 7)?.khoj, w14 = rp?.curves.find((c) => c.days === 14)?.khoj;
  const M = d.sessions?.matched, MM = M ? Object.fromEntries(M.metrics.map((m) => [m.key, m])) : {};
  const B = d.sessions?.beyond;
  const pers = a?.personalisation, V = d.visitorPersonalisation;
  const verdict = (ok, warn) => (ok === null ? chip('muted', 'Waiting for data') : ok ? chip('green', 'Encouraging') : warn ? chip('amber', 'Watch') : chip('orange', 'Concern'));
  const section = (sub, title, v, cards, line) => `<section class="card" aria-label="${esc(title)}"><div class="card-head"><div><h2>${esc(title)}</h2>${line ? `<span class="muted small">${esc(line)}</span>` : ''}</div><div style="flex-direction:row;gap:8px;align-items:center">${v}<button type="button" class="btn" data-sub="${sub}" style="min-height:32px;padding:4px 10px;font-size:12px">Open</button></div></div>${kpiRow(cards)}</section>`;
  const repOk = w14?.eligible && RB?.rates?.d14 !== null && RB?.rates?.d14 !== undefined ? w14.pct >= RB.rates.d14 * 0.9 : null;
  const crossOk = MM.productsPerSession?.khoj !== undefined && MM.productsPerSession?.bench ? MM.productsPerSession.khoj >= MM.productsPerSession.bench * 0.9 : null;
  const anyPred = pers ? (pers.browsing?.levels.find((x) => x.key === 'all_any') || pers.levels.find((x) => x.key === 'any')) : null;
  return [
    section('hits', 'Hit % & Scalability', verdict(sr === null ? null : sr >= 40, sr >= 25), [
      ['Products tested', int(tested), `${int(live)} in testing now`], ['Success rate', pc(sr), sr !== null ? `${wins} of ${wins + losses} decided · ±${Math.round(ci)} pts` : 'no verdicts yet'],
      ['Winners scaling', int(scaling), `${ladder.length} scale ad sets`], ['Hero coverage (test categories)', tc && tc.h ? pc(tc.l / tc.h * 100, 1) : '—', tc ? `${int(tc.l)} of ${int(tc.h)} ShopDeck heroes live` : '']
    ], 'Do hero products win at a useful rate, and how far do winners scale?'),
    section('quality', 'Customer Quality', verdict(cmp ? cmp.khoj.rtoPct <= cmp.shopdeckBefore.rtoPct : null, true), [
      ['New to ShopDeck', pc(a?.newToSdPct, 1), 'of Khoj buyers'], ['Online orders', pc(100 - (cmp?.khoj.codPct ?? NaN), 1), cmp ? `same customers on sellers: ${pc(100 - cmp.shopdeckBefore.codPct, 1)}` : ''],
      ['RTO', pc(cmp?.khoj.rtoPct, 1), cmp ? `same customers on sellers: ${pc(cmp.shopdeckBefore.rtoPct, 1)}` : ''], ['Cancelled', pc(cmp?.khoj.cancelPct, 1), cmp ? `on sellers: ${pc(cmp.shopdeckBefore.cancelPct, 1)}` : '']
    ], 'Who buys, and are they better customers than on seller sites?'),
    `<section class="card" aria-label="Early signs"><div class="card-head"><div><h2>Early signs on repeats &amp; likability</h2><span class="muted small">Leading signals of repeat: to come</span></div>${chip('muted', 'To come')}</div></section>`,
    section('repeat', 'Actual Repeats', verdict(repOk, true), [
      ['Back within 7 days', w7?.eligible ? pc(w7.pct, 1) : '—', RB ? `parent sellers: ${pc(RB.rates.d7, 1)}` : ''], ['Back within 14 days', w14?.eligible ? pc(w14.pct, 1) : '—', RB ? `parent sellers: ${pc(RB.rates.d14, 1)}` : ''],
      ['Repeat from another seller', rp?.kinds.lines ? pc(rp.kinds.otherParent / rp.kinds.lines * 100) : '—', 'of repeat order lines'], ['Repeat buyers so far', int(rp?.repeaters), `of ${int(rp?.customers)}`]
    ], 'Do Khoj buyers come back, and as often as on the sellers\' own sites?'),
    section('cross', 'Cross Selling', verdict(crossOk, true), [
      ['Products viewed / session', MM.productsPerSession ? `${MM.productsPerSession.khoj?.toFixed(2)} vs ${MM.productsPerSession.bench?.toFixed(2)}` : '—', 'Khoj vs same first products on seller sites'],
      ['Sessions seeing only the first product', MM.singlePct ? `${pc(MM.singlePct.khoj)} vs ${pc(MM.singlePct.bench)}` : '—', ''],
      ['Buy-now on a different product', pc(B?.otherPct, 1), 'than the one they landed on'], ['…from another seller', pc(B?.otherAnotherSellerPct, 1), 'of those']
    ], 'Does an all-hero marketplace get people to look and buy beyond the ad\'s product?'),
    section('data', 'Using ShopDeck\'s data advantage', verdict(anyPred ? anyPred.d30 >= 30 : null, true), [
      ['Orders predictable, last 7 days', pc(anyPred?.d7, 1), 'from orders and browsing on ShopDeck'], ['Orders predictable, last 30 days', pc(anyPred?.d30, 1), ''],
      ['Visitors identifiable at landing', pc(V?.linkedPct, 1), 'could be personalised'], ['Conversion if personalised', V?.estimate?.conservative ? `${pc(V.conversionPct, 2)} → ${pc(V.estimate.conservative.newConversionPct, 2)}` : '—', 'upper bound']
    ], 'Can ShopDeck\'s history tell us what a visitor will buy?')
  ].join('');
}

function qualityTopCard(d) {
  const a = d.customers?.audience, cmp = a?.compare, O = d.overview;
  if (!cmp && !O) return '';
  const pay = a?.byPayment || [];
  const cod = pay.find((x) => x.key === 'COD'), pre = pay.find((x) => x.key === 'Prepaid');
  return card('Customer quality at a glance', 'Customer quality at a glance', 'Khoj orders vs the same customers on ShopDeck seller sites (before Khoj), plus the last 7 days from the day-wise and P&L questions', kpiRow([
    ['Online orders, last 7 days', pc(O?.last7.onlinePct, 1), O ? `the 7 before: ${pc(O.prev7.onlinePct, 1)}` : ''],
    ['Online share: Khoj vs sellers', cmp ? `${pc(100 - cmp.khoj.codPct, 1)} vs ${pc(100 - cmp.shopdeckBefore.codPct, 1)}` : '—', 'same customers'],
    ['RTO: Khoj vs sellers', cmp ? `${pc(cmp.khoj.rtoPct, 1)} vs ${pc(cmp.shopdeckBefore.rtoPct, 1)}` : '—', 'of delivered + returned'],
    ['COD RTO', pc(cod?.rtoPct, 1), pre ? `prepaid: ${pc(pre.rtoPct, 1)}` : ''],
    ['Cancelled: Khoj vs sellers', cmp ? `${pc(cmp.khoj.cancelPct, 1)} vs ${pc(cmp.shopdeckBefore.cancelPct, 1)}` : '—', ''],
    ['RTO (P&L, last 7 days)', pc(O?.pnl.last7?.rtoPct, 1), 'includes predicted RTO for orders in transit']
  ]));
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
let custSearchTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.dataset && e.target.dataset.cf === 'q') {
    custUi.q = e.target.value; custUi.page = 0;
    clearTimeout(custSearchTimer);
    custSearchTimer = setTimeout(() => {
      const pos = e.target.selectionStart;
      $('custTable').innerHTML = custTableInner();
      const box = document.querySelector('#custTable [data-cf="q"]');
      if (box) { box.focus(); box.setSelectionRange(pos, pos); }
    }, 250);
  }
});
document.addEventListener('click', async (e) => {
  const rp = e.target.closest('[data-repull]');
  if (rp) { await fetch(`/api/sources/${rp.dataset.repull}/repull`, { method: 'POST' }); ui.repulled = { ...(ui.repulled || {}), [rp.dataset.repull]: true }; render(); return; }
  const pg = e.target.closest('[data-cpage]');
  if (pg) { custUi.page += Number(pg.dataset.cpage); $('custTable').innerHTML = custTableInner(); $('custTable').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  const t = e.target.closest('[data-cat],[data-tab],[data-sub],[data-live],#refresh,#retry,#resetRules,#resetPlan');
  if (!t) return;
  if (t.dataset.cat) { ui.cat = t.dataset.cat; remember(); render(); }
  else if (t.dataset.tab) { ui.tab = t.dataset.tab; remember(); render(); }
  else if (t.dataset.sub) { ui.sub = t.dataset.sub; remember(); render(); }
  else if (t.dataset.live) { ui.live = t.dataset.live; remember(); render(); }
  else if (t.id === 'refresh' || t.id === 'retry') load(true, true);
  else if (t.id === 'resetPlan') {
    if (!confirm('Reset the plan to the default placeholder?')) return;
    await fetch('/api/plan', { method: 'DELETE' });
    load(false);
  }
  else if (t.id === 'resetRules') {
    if (!confirm('Reset every rule to its default?')) return;
    await fetch('/api/settings', { method: 'DELETE' });
    load(false);
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.dataset && e.target.dataset.cf && e.target.dataset.cf !== 'q') { custUi[e.target.dataset.cf] = e.target.value; custUi.page = 0; $('custTable').innerHTML = custTableInner(); return; }
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
  if (e.target.id === 'planForm') {
    e.preventDefault();
    const f = e.target, v = (n) => Number(f.querySelector(`[name="${n}"]`)?.value);
    const P = ui.data.scaling.plan;
    const body = { startWeek: f.querySelector('[name="startWeek"]').value.trim(), weeks: v('weeks'),
      assumptions: { aov: v('a_aov'), successPct: v('a_successPct'), trialBudget: v('a_trialBudget'), trialDays: v('a_trialDays'), winnerDas: v('a_winnerDas'), winnerLifeWeeks: v('a_winnerLifeWeeks'),
        sgmv: Object.fromEntries(['testing', 'winners', 'catalog', 'metaOther', 'google'].map((b) => [b, v('s_' + b)])) },
      das: Object.fromEntries(['testing', 'catalog', 'metaOther', 'google'].map((b) => [b, P.das[b].map((_, i) => v(`d_${b}_${i}`) || 0)])) };
    const res = await fetch('/api/plan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    ui.note = res.ok ? 'Plan saved.' : ''; if (!res.ok) ui.msg = 'Could not save the plan.';
    await load(false);
    return;
  }
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
