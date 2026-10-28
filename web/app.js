// Khoj Control Room front end. No build step: plain ES modules, rendered from /api/state.
const CATS = ['Saree', 'Kurti & Suits', 'Jewellery'];
const ui = { tab: 'status', sub: 'summary', win: 'yesterday', cat: 'All', live: 'all', sig: 'ppo', showDone: true, data: null, busy: false, saving: false, uploading: false, msg: '', note: '' };
try { Object.assign(ui, JSON.parse(localStorage.getItem('khoj-ui') || '{}'), { data: null, busy: false, saving: false, uploading: false, msg: '', note: '' }); } catch {}
// Older saved tabs → their new home.
{ const OLD = { room: ['pmf', 'hits'], cover: ['pmf', 'hits'], audience: ['pmf', 'quality'], cross: ['pmf', 'cross'], repeat: ['pmf', 'repeat'] };
  if (OLD[ui.tab]) [ui.tab, ui.sub] = OLD[ui.tab]; }
// Who is signed in (email login), and the page's half of usage tracking.
const auth = { mode: null, user: null, clientId: null, domains: [], busy: false, error: '' };
const usage = { data: null, days: 30, loading: false, error: '' };
async function apiFetch(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401 && auth.mode === 'google') { auth.user = null; renderLogin(); throw new Error('Signed out'); }
  return r;
}
const remember = () => { try { localStorage.setItem('khoj-ui', JSON.stringify({ tab: ui.tab, sub: ui.sub, win: ui.win, cat: ui.cat, live: ui.live, sig: ui.sig, showDone: ui.showDone })); } catch {} };

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
      const r = await apiFetch('/api/sources');
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
        const r = await apiFetch('/api/sources/' + names[i].name + (force ? '?force=1' : ''), { method: 'POST' });
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
    const res = await apiFetch('/api/state');
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
  const tabs = [['status', 'Overall Status', ''], ['plan', 'Scaling Plan & Status', ''], ['pmf', 'PMF View', ''], ['rules', 'Rules', ''], ['tasks', 'Task log', open ? `${open} open` : ''], ...(auth.user?.admin ? [['usage', 'Usage', '']] : [])];
  $('cats').style.display = (ui.tab === 'pmf' && ui.sub === 'hits') || ui.tab === 'tasks' ? '' : 'none';
  $('tabs').innerHTML = tabs.map(([k, l, b]) => `<button type="button" class="tab" role="tab" data-tab="${k}" aria-selected="${k === ui.tab}">${l}${b ? ' ' + chip('orange', b) : ''}</button>`).join('');
  $('who').innerHTML = auth.user ? `<span class="small muted">${esc(auth.user.email)}</span><button type="button" class="btn btn-quiet" id="signOut">Sign out</button>` : '';
  $('refresh').disabled = ui.busy;
  if (!ui.busy) $('refresh').textContent = 'Refresh from Metabase';
  $('freshness').textContent = d ? `Data ${new Date(d.meta.loadedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  const notices = [];
  if (ui.msg) notices.push(`<div class="notice notice-orange">${esc(ui.msg)}</div>`);
  if (ui.note) notices.push(`<div class="notice notice-green">${esc(ui.note)}</div>`);
  // Data-load issues live on the Rules tab; the engine's data notes also show on Hit % & Scalability.
  const showLoad = ui.tab === 'rules', showNotes = ui.tab === 'rules' || (ui.tab === 'pmf' && ui.sub === 'hits');
  if (d && showLoad) {
    for (const [k, s] of Object.entries(d.meta.sources)) {
      if (s.status === 'pulling') notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: first pull is running in the background (${esc(s.error)}). Refresh in a few minutes.</div>`);
      else if (s.status === 'error' && s.daily) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: not pulled yet. The scheduled pull checks every 5 minutes (last try: ${esc(s.error)}).</div>`);
      else if (s.status === 'error') notices.push(`<div class="notice notice-orange"><strong>${esc(k)}</strong> source failed (${esc(s.origin)}): ${esc(s.error)}</div>`);
      else if (s.fallback) { /* stale copy in use: shown in the Data sources card, not as a banner */ }
      else if (s.stale) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong> didn't refresh (${esc(s.error)}). Showing the pull from ${esc(fmtWhen(s.loadedAt))}${s.daily ? '; the scheduled pull retries within 5 minutes' : ''}.</div>`);
      else if (s.daily && s.status === 'missing' && s.origin === 'waiting for the daily pull') notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong>: waiting for the scheduled pull, which checks every 5 minutes.</div>`);
      else if (s.status === 'missing' && !['universe', 'overlap', 'history', 'events', 'benchmark', 'browsing', 'personalise'].includes(k)) notices.push(`<div class="notice notice-amber"><strong>${esc(k)}</strong> source not connected (${esc(s.origin)}). Sections that need it are empty.</div>`);
    }
  }
  if (d && showNotes) for (const n of d.notes) notices.push(`<div class="notice notice-amber">${esc(n)}</div>`);
  if (d && showLoad) {
    if (d.meta.store === 'memory') notices.push('<div class="notice notice-amber">No persistent store: task ticks and the decision log are kept in memory and reset on restart.</div>');
  }
  $('notices').innerHTML = notices.join('');
}

function render() {
  if (auth.mode === 'google' && !auth.user) return renderLogin();
  renderChrome();
  const d = ui.data;
  if (!d) {
    if (!ui.busy) $('view').innerHTML = `<div class="card"><p>Nothing loaded yet.</p><p><button type="button" class="btn btn-primary" id="retry">Try again</button></p></div>`;
    return;
  }
  if (ui.tab === 'usage' && !auth.user?.admin) ui.tab = 'status';
  const view = { status: viewStatus, plan: viewPlan, pmf: viewPmf, tasks: viewTasks, rules: viewRules, usage: viewUsage }[ui.tab] || viewStatus;
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
    sourcesCard(d)
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
    <td>${t.hit ? chip('green', 'Hit') : actionChip(t.action)}</td>
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

function sourcesCard(d) {
  const label = { products: 'Products (hero base)', ads: 'Trial and scale ads', catalog: 'Product spend, PPO-distributed', adsetMap: 'Ad set → product map', universe: 'ShopDeck universe (PQ ≥ 3)', overlap: 'Khoj × parent seller overlap', history: 'Khoj buyers\' order history', browsing: 'Khoj buyers\' browsing', daywise: 'Khoj day-wise', pnl: 'Khoj P&L (today to L7D)', pnlWeeks: 'Khoj P&L (weeks)', prodQuality: 'Order quality: Khoj vs same products on seller sites', events: 'Site sessions vs parent sellers', personalise: 'Visitor personalisation', benchmark: 'Repeat benchmark (parent sellers)' };
  return `<section class="card" aria-label="Data sources">
    <h2>Data sources</h2>
    <div class="sources">${Object.entries(d.meta.sources).map(([k, s]) => `<div class="source"><strong>${label[k]}</strong><span class="muted small">${esc(s.origin)}</span><span>${s.status === 'pulling' ? chip('blue', 'Pulling in the background') : s.fallback ? chip('amber', `Repo copy · ${fmtWhen(s.loadedAt)}`) : s.stale ? chip('amber', `Last pull ${fmtWhen(s.loadedAt)} · refresh failed`) : s.daily && s.status === 'ok' ? chip('green', `${int(s.rows)} rows · ${s.everyHours >= 24 ? 'daily' : `every ${s.everyHours} h`}, pulled ${fmtWhen(s.loadedAt)}`) : s.daily && s.status === 'missing' && s.origin === 'waiting for the daily pull' ? chip('amber', 'Waiting for the daily pull') : s.status === 'ok' ? chip('green', int(s.rows) + ' rows') : s.status === 'missing' ? chip('amber', 'Not connected') : chip('orange', 'Error')}</span>${s.error ? `<span class="small" style="color:var(--orange-fg)">${esc(s.error)}</span>` : ''}${s.rows ? `<a class="small" href="/api/sources/${esc(k)}.csv" download>Download the rows (CSV)</a>` : ''}${s.daily ? `<button type="button" class="btn" data-repull="${esc(k)}" style="align-self:flex-start;min-height:32px;padding:4px 10px;font-size:12px">${ui.repulled?.[k] ? 'Queued: next check within 5 min' : 'Pull again'}</button>` : ''}${s.columns && s.columns.length ? `<details><summary class="small">Columns received (${s.columns.length})</summary><ul class="small muted" style="margin:6px 0 0;padding-left:18px">${s.columns.map((c) => `<li><code>${esc(c)}</code> · ${esc((s.sample || {})[c] || '')}</li>`).join('')}</ul></details>` : ''}</div>`).join('')}</div>
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
// Repeat per cut: back on Khoj within 7 / 14 days (buyers old enough to count); base = parent sellers' own sites,
// order-weighted, where the benchmark has that cut (payment, new vs returning) or overall.
const repCell = (x) => (x && x.eligible ? `${pc(x.pct, 1)} <span class="muted small">n=${int(x.eligible)}</span>` : '<span class="muted small">—</span>');
const segCols = (head, baseOf = () => null) => [
  { h: head, v: (r) => esc(r.key) },
  { h: 'Buyers', r: 1, v: (r) => int(r.buyers) }, { h: 'Share', r: 1, v: (r) => pc(r.share, 1) },
  { h: 'COD', r: 1, v: (r) => pc(r.codPct) }, { h: 'RTO', r: 1, v: (r) => pc(r.rtoPct), cls: (r) => rtoTone(r.rtoPct) },
  { h: 'Repeat 7d', r: 1, v: (r) => repCell(r.rep7) },
  { h: 'Repeat 14d', r: 1, v: (r) => repCell(r.rep14), cls: (r) => { const b = baseOf(r); return b === null || b === undefined || !r.rep14?.eligible ? '' : r.rep14.pct >= b ? 'good' : 'bad'; } },
  { h: 'Base sellers 14d', r: 1, v: (r) => { const b = baseOf(r); return b === null || b === undefined ? '<span class="muted small">—</span>' : pc(b, 1); } }
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
  const RB14 = d.repeatBench?.rates?.d14 ?? null, RBs = d.repeatBench?.segments || null;
  const who = card('Who buys on Khoj', 'Who buys on Khoj', historySub(d), kpiRow([
    ['New to ShopDeck', pc(a.newToSdPct, 1), 'ShopDeck marks their Khoj order as their first ever ShopDeck order (all time, not just 12 months)'],
    ['No ShopDeck order in the 12 months before', pc(a.noPriorPct, 1), 'new or lapsed when they found Khoj'],
    ['Power users', pc(a.powerPct, 1), '4+ ShopDeck orders in the 12 months before their first Khoj order'],
    ['Bought on ShopDeck in the 7 days before', pc(recent7?.share, 1), 'active shoppers when Khoj reached them'],
    ['Already a customer of the parent seller', pc(pa.beforePct, 1), 'bought from the seller whose product they bought on Khoj']
  ]) + `<div style="display:flex;flex-direction:column;gap:14px">
      ${tbl(segCols('ShopDeck history', (r) => RBs?.[r.key === 'New to ShopDeck' ? 'New to ShopDeck' : 'Returning to ShopDeck'] ?? RB14), a.byUserType, { min: 760 })}
      ${tbl(segCols('Last ShopDeck order before Khoj', () => RB14), a.byRecency, { min: 760 })}
      ${tbl(segCols('First Khoj category', () => RB14), a.byCategory, { min: 760 })}
      ${tbl(segCols('Payment, first Khoj order', (r) => RBs?.[r.key] ?? RB14), a.byPayment, { min: 760 })}
    </div>
    <p class="small muted">Repeat: another Khoj order within 7 / 14 days of the first (more than ${d.settings.sessionMinutes} minutes later), among buyers whose first order is at least that old. Base sellers: the parent sellers' own sites, weighted by Khoj orders (Q16725)${RB14 === null ? ', not loaded yet' : `; overall ${pc(RB14, 1)} at 14 days, with a split for payment and new vs returning`}.</p>
    <details><summary class="small">By state (from pincode)</summary><div style="margin-top:8px">${tbl(segCols('State', () => RB14), a.byState, { min: 760 })}</div></details>`);
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
    const r = await apiFetch('/api/customers');
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
function chartSvg({ labels, bars = null, lines = [], refLine = null, height = 180, yFmt = (v) => v, barColor = 'var(--blue)', barColors = null, barOpacity = 0.28, barLabel = '', yCap = null, log = false }) {
  const W = 760, H = height, pl = 44, pr = 12, pt = 12, pb = 26;
  const n = labels.length; if (!n) return '';
  const raw = [...(bars || []), ...lines.flatMap((l) => l.values), ...(refLine ? [refLine.value] : [])].filter((v) => v !== null && Number.isFinite(v));
  // Log scale (for plans that grow 100×): values map through log10 from a floor just under the smallest one.
  const lo = log ? 10 ** Math.floor(Math.log10(Math.max(1, Math.min(...raw.filter((v) => v > 0), 1e12)))) : 0;
  const tf = log ? (v) => Math.log10(Math.max(v, lo)) - Math.log10(lo) : (v) => v;
  const max = (log ? tf(Math.max(...raw, lo * 10)) : Math.min(Math.max(...raw, 0), yCap ?? Infinity)) * 1.12 || 1;
  const x = (i) => pl + ((W - pl - pr) * (i + 0.5)) / n, y = (v) => pt + (H - pt - pb) * (1 - Math.min(tf(v), max) / max);
  const bw = Math.max(2, ((W - pl - pr) / n) * 0.62);
  const ticks = log ? Array.from({ length: Math.floor(max / 1.12) + 1 }, (_, i) => lo * 10 ** i) : [0, 0.5, 1].map((f) => max * f / 1.12);
  const grid = ticks.map((v) => `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${pl - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${esc(yFmt(v))}</text>`).join('');
  const base = H - pb;
  const barsSvg = bars ? bars.map((v, i) => v === null ? '' : `<rect x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0, base - y(v))}" rx="2" fill="${barColors?.[i] || barColor}" opacity="${barOpacity}"><title>${esc(labels[i])}: ${esc(yFmt(v))} ${esc(barLabel)}</title></rect>`).join('') : '';
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
const addDays = (iso, n) => { const x = new Date(iso + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const shortDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '');

// ---------- Overall Status ----------
function viewStatus(d) {
  const O = d.overview;
  if (!O) return card('Overall Status', 'Overall Status', '', '<p class="small muted">Waiting for the day-wise question (Q16083). It is pulled every hour in the background.</p>', chip('amber', 'No data yet'));
  const Wn = O.windows, PR = O.predictedRto;
  // Snapshot: a quiet scorecard. Big number = the selected window; the line under it compares with L7D (or, for L7D,
  // the 7 days before); a grey sparkline shows the last 14 days. Colour only on the comparison text.
  const sel = Wn.find((w) => w.key === ui.win) || Wn[1];
  const L7 = Wn.find((w) => w.key === 'l7d'), P7 = O.prev7;
  const ref = sel.key === 'l7d' ? { w: { ...P7, nr: null, predictedRto: null, cmPct: null }, label: 'prior 7d' } : { w: L7, label: 'L7D' };
  const R14 = O.rolling.slice(-14);
  const spark = (vals) => {
    const v = vals.map((x) => (x === null || x === undefined || !Number.isFinite(x) ? null : x));
    const ok = v.filter((x) => x !== null); if (ok.length < 3) return '<div class="kspark"></div>';
    const mn = Math.min(...ok), mx = Math.max(...ok), W2 = 120, H2 = 28;
    const pts = v.map((x, i) => (x === null ? null : `${(i / (v.length - 1)) * W2},${H2 - 2 - (mx === mn ? 0.5 : (x - mn) / (mx - mn)) * (H2 - 4)}`)).filter(Boolean).join(' ');
    return `<svg class="kspark" viewBox="0 0 ${W2} ${H2}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--muted)" stroke-width="1.25" vector-effect="non-scaling-stroke"/></svg>`;
  };
  const cmpLine = (a, b, { fmt, pts = false, better = 'up', label = ref.label } = {}) => {
    if (a === null || a === undefined || b === null || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return `<span class="muted">${esc(label)} —</span>`;
    const d2 = pts ? a - b : b ? ((a - b) / b) * 100 : null;
    if (d2 === null) return `<span class="muted">${esc(label)} ${fmt(b)}</span>`;
    const good = better === 'none' ? null : (better === 'up' ? d2 > 0 : d2 < 0);
    const cls = Math.abs(d2) < (pts ? 0.3 : 2) || good === null ? 'muted' : good ? 'kgood' : 'kbad';
    return `<span class="muted">${esc(label)} ${fmt(b)}</span> <span class="${cls}">${d2 >= 0 ? '+' : '−'}${Math.abs(d2).toFixed(pts ? 1 : 0)}${pts ? ' pts' : '%'}</span>`;
  };
  const f0 = (v) => int(v), f1 = (v) => pc(v, 1);
  const nrS = sel.nr, nrR = ref.w.nr;
  const nrNote = `<span class="muted">${O.newRepeat ? `order data up to ${shortDate(O.newRepeat.asOf)}` : 'needs order data'}</span>`;
  const groups = [
    ['Volume', [
      { label: 'Orders / day', v: int(sel.ordersPerDay), sub: cmpLine(sel.ordersPerDay, ref.w.ordersPerDay, { fmt: f0 }), sp: R14.map((r) => r.orders), note: sel.key === 'today' ? 'so far today' : '' },
      { label: 'New-user orders / day', v: nrS ? int(nrS.newPerDay) : '—', sub: nrS ? cmpLine(nrS.newPerDay, nrR?.newPerDay, { fmt: f0 }) : nrNote, sp: R14.map((r) => r.newOrders) },
      { label: 'Repeat orders / day', v: nrS ? int(nrS.repeatPerDay) : '—', sub: nrS ? cmpLine(nrS.repeatPerDay, nrR?.repeatPerDay, { fmt: f0 }) : nrNote, sp: R14.map((r) => r.repeatOrders) },
      { label: 'Repeat share of orders', v: nrS ? pc(nrS.repeatPct, 1) : '—', sub: nrS ? cmpLine(nrS.repeatPct, nrR?.repeatPct, { fmt: f1, pts: true }) : nrNote, sp: R14.map((r) => r.repeatPct7) }
    ]],
    ['Efficiency', [
      { label: 'Spend / GMV', v: pc(sel.sgmv, 1), sub: cmpLine(sel.sgmv, ref.w.sgmv, { fmt: f1, pts: true, better: 'down' }), sp: R14.map((r) => r.sgmv7) },
      { label: 'CM %', v: sel.cmPct === null ? '—' : `<span class="${sel.cmPct >= 0 ? '' : 'kbadv'}">${pc(sel.cmPct, 1)}</span>`, sub: sel.cmPct === null ? '<span class="muted">P&amp;L pending</span>' : cmpLine(sel.cmPct, ref.w.cmPct, { fmt: f1, pts: true }), sp: [] },
      { label: 'Daily avg spend', v: inr(sel.spendPerDay), sub: cmpLine(sel.spendPerDay, ref.w.spendPerDay, { fmt: inr, better: 'none' }), sp: R14.map((r) => r.spend) },
      { label: 'AOV', v: inr(sel.aov), sub: cmpLine(sel.aov, ref.w.aov, { fmt: inr }), sp: R14.map((r) => r.aov7 ?? r.aov) }
    ]],
    ['Quality', [
      { label: 'Online %', v: pc(sel.onlinePct, 1), sub: cmpLine(sel.onlinePct, ref.w.onlinePct, { fmt: f1, pts: true }), sp: R14.map((r) => r.online7) },
      { label: 'Online % · new users', v: nrS ? pc(nrS.newOnlinePct, 1) : '—', sub: nrS ? cmpLine(nrS.newOnlinePct, nrR?.newOnlinePct, { fmt: f1, pts: true }) : nrNote, sp: R14.map((r) => r.newOnline7) },
      { label: 'Online % · repeat users', v: nrS ? pc(nrS.repeatOnlinePct, 1) : '—', sub: nrS ? cmpLine(nrS.repeatOnlinePct, nrR?.repeatOnlinePct, { fmt: f1, pts: true }) : nrNote, sp: R14.map((r) => r.repeatOnline7) },
      { label: 'Cancelled %', v: pc(sel.cancelPct, 1), sub: cmpLine(sel.cancelPct, ref.w.cancelPct, { fmt: f1, pts: true, better: 'down' }), sp: R14.map((r) => r.cancel7) },
      { label: 'Predicted RTO', v: pc(sel.predictedRto, 1), sub: `<span class="muted">COD ${pc(PR?.cod.rtoPct, 1)} · online ${pc(PR?.online.rtoPct, 1)}${PR?.online.fromSellers ? ' (sellers)' : ''}</span>`, sp: [] }
    ]]
  ];
  const toggle = `<div class="wseg" role="tablist" aria-label="Window">${Wn.map((w) => `<button type="button" data-win="${w.key}" aria-pressed="${w.key === sel.key}">${esc(w.label)}<span>${w.from === w.to ? shortDate(w.from) : `${shortDate(w.from)}–${shortDate(w.to)}`}</span></button>`).join('')}</div>`;
  const body = groups.map(([g, ms]) => `<div class="kgroup"><div class="kgroup-label">${esc(g)}</div><div class="kgrid${ms.length === 5 ? ' kgrid-5' : ''}">${ms.map((m) => `<div class="kcell"><div class="klabel">${esc(m.label)}${m.note ? ` <span class="muted">· ${esc(m.note)}</span>` : ''}</div><div class="kval">${m.v}</div><div class="ksub small">${m.sub}</div>${spark(m.sp)}</div>`).join('')}</div></div>`).join('');
  const notes = `<p class="small muted" style="margin:0;line-height:1.6">Predicted RTO: on Khoj orders placed ${shortDate(PR?.from)}–${shortDate(PR?.to)}, leaving out cancelled and cancellation-initiated orders (enqueued, invalid and initiated never count), RTO = 1 − delivered ÷ the rest. COD from Khoj's own orders; online ${PR?.online.fromSellers ? `taken as the base sellers' online RTO on the same products (Khoj's own: ${pc(PR.online.actualRtoPct, 1)})` : 'from Khoj\'s own orders until the order-quality question loads'}; weighted by each window's online share. CM %: the P&amp;L at that RTO. Repeat: a customer's Khoj order more than ${d.settings.sessionMinutes} minutes after their first${O.newRepeat?.source === 'history' ? ` (from the daily order-history pull, so up to ${shortDate(O.newRepeat.asOf)}; connect the Khoj orders question for today)` : ''}. Sparklines: last 14 days.</p>`;
  const top = `<section class="card" aria-label="Snapshot"><div class="card-head"><div><h2>Snapshot</h2></div>${toggle}</div>${body}${notes}</section>`;

  const R = O.rolling;
  const lab = R.map((r) => shortDate(r.date));
  const trend = card('Trend', 'Trends', 'Daily since launch · lines are 7-day averages',
    `<div class="grid-2"><div><div class="group-title">Orders per day</div>${chartSvg({ labels: lab, bars: R.map((r) => r.orders), lines: [{ values: R.map((r) => r.orders7), color: 'var(--blue)' }], yFmt: (v) => Math.round(v), barLabel: 'orders' })}${legend([['var(--blue)', '7-day average']])}</div>
     <div><div class="group-title">Spend / GMV</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.sgmv), color: 'var(--orange)', width: 1, dots: true }, { values: R.map((r) => r.sgmv7), color: 'var(--orange)' }], yFmt: (v) => `${Math.round(v)}%`, yCap: 80 })}${legend([['var(--orange)', '7-day Spend/GMV']])}</div>
     <div><div class="group-title">GMV and spend per day (₹)</div>${chartSvg({ labels: lab, bars: R.map((r) => r.gmv), lines: [{ values: R.map((r) => r.spend), color: 'var(--purple)' }], yFmt: (v) => `${Math.round(v / 1000)}k`, barColor: 'var(--green)', barLabel: 'GMV' })}${legend([['var(--green)', 'GMV (bars)'], ['var(--purple)', 'spend']])}</div>
     <div><div class="group-title">Online and cancelled % (7-day)</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.online7), color: 'var(--blue)' }, { values: R.map((r) => r.cancel7), color: 'var(--orange)' }], yFmt: (v) => `${Math.round(v)}%` })}${legend([['var(--blue)', 'online %'], ['var(--orange)', 'cancelled %']])}</div>
     <div><div class="group-title">Repeat share of orders</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.repeatPct), color: 'var(--purple)', width: 1, dots: true }, { values: R.map((r) => r.repeatPct7), color: 'var(--purple)' }], yFmt: (v) => `${v.toFixed(0)}%` })}${legend([['var(--purple)', 'repeat orders ÷ all orders, 7-day']])}</div>
     <div><div class="group-title">AOV (7-day)</div>${chartSvg({ labels: lab, lines: [{ values: R.map((r) => r.aov7), color: 'var(--ink)' }], yFmt: (v) => inr(v) })}${legend([['var(--ink)', 'AOV']])}</div></div>`);

  let unit = '';
  const PY = O.pnl.yesterday;
  if (PY && PY.perOrder) {
    const u = PY.perOrder;
    const lines = [['GMV per shipped order', u.gmv, ''], ['− lost to RTO, returns, discounts', u.nmv - u.gmv, `NMV ${pc(PY.nmvOfGmv, 0)} of GMV`], ['− paid to the seller (TP)', -u.tp, `${pc(PY.tpOfGmv, 0)} of GMV`], ['− logistics', -u.logistics, `${pc(PY.logOfGmv, 0)} of GMV`], ['− marketing (incl. GST)', -u.mkt, `${pc(PY.mktOfGmv, 1)} of GMV`], ['= contribution margin', u.profit, `${pc(PY.profitPct, 1)} of NMV`]];
    const max = u.gmv;
    unit = card('Unit economics', `Unit economics · yesterday (${shortDate(PY.start)})`, `P&L at ${pc(PY.rtoPct, 0)} RTO · ${int(PY.shipped || PY.orders)} shipped orders`,
      `<div style="max-width:760px">${lines.map(([l, v, note], i) => `<div style="display:grid;grid-template-columns:200px 1fr 80px;gap:10px;align-items:center;margin:6px 0"><span class="small">${esc(l)}</span><span class="bar" style="min-width:0"><span style="width:${Math.min(100, Math.abs(v) / max * 100)}%;background:${i === 0 ? 'var(--blue)' : i === lines.length - 1 ? (v >= 0 ? 'var(--green)' : 'var(--orange)') : 'var(--muted)'}"></span></span><span class="num r small ${i === lines.length - 1 ? (v >= 0 ? 'good' : 'bad') : ''}">${inr(v)}</span></div><div class="muted small" style="margin:-4px 0 4px 210px">${esc(note)}</div>`).join('')}</div>
</div>`);
  } else unit = card('Unit economics', 'Unit economics · yesterday', '', '<p class="small muted">Waiting for yesterday\'s P&amp;L (Q16167), pulled every 2 hours.</p>');

  const weeks = card('Week over week', 'Week over week', 'Mon–Sun · the current week runs to yesterday · RTO and CM from the P&L at the predicted RTO', tbl([
    { h: 'Week', v: (w) => `<strong>${esc(w.label)}</strong> <span class="muted small">${shortDate(w.week)}${w.partial ? ` · ${w.days}d` : ''}</span>` },
    { h: 'Orders/day', r: 1, v: (w) => int(w.ordersPerDay) }, { h: 'GMV/day', r: 1, v: (w) => inr(w.gmvPerDay) }, { h: 'Spend/day', r: 1, v: (w) => inr(w.spendPerDay) },
    { h: 'Spend/GMV', r: 1, v: (w) => pc(w.sgmv, 1) },
    { h: 'AOV', r: 1, v: (w) => inr(w.aov) }, { h: 'Online', r: 1, v: (w) => pc(w.onlinePct, 1) }, { h: 'Cancelled', r: 1, v: (w) => pc(w.cancelPct, 1) }, { h: 'Repeat share', r: 1, v: (w) => (w.nr ? pc(w.nr.repeatPct, 1) : '—') },
    { h: 'CTR', r: 1, v: (w) => pc(w.ctr, 2) }, { h: 'CPM', r: 1, v: (w) => inr(w.cpm) }, { h: 'Click→order', r: 1, v: (w) => pc(w.c2pr, 2) },
    { h: 'RTO', r: 1, v: (w) => (w.pnl ? pc(w.pnl.rtoPct, 1) : '—') }, { h: 'CM %', r: 1, v: (w) => (w.pnl ? pc(w.pnl.profitPct, 1) : '—'), cls: (w) => (w.pnl ? (w.pnl.profitPct >= 0 ? 'good' : 'bad') : '') }
  ], O.weeks, { min: 1100 }));
  return top + trend + unit + weeks;
}

// ---------- Scaling Plan & Status ----------
// Orders are the scaling metric: everything here leads with orders per day against plan, coloured
// green (on or above plan), amber (within 10%) or red (more than 10% behind).
const TONE = { good: 'var(--green)', warn: 'var(--amber)', bad: 'var(--orange)', muted: 'var(--line)' };
const toneOf = (a, p, lower = false) => {
  if (a === null || a === undefined || !Number.isFinite(a) || !p) return 'muted';
  const r = a / p;
  return lower ? (r <= 1 ? 'good' : r <= 1.1 ? 'warn' : 'bad') : (r >= 1 ? 'good' : r >= 0.9 ? 'warn' : 'bad');
};
const TONE_WORD = { good: 'On plan', warn: 'Slightly behind', bad: 'Behind plan', muted: 'No data yet' };
function viewPlan(d) {
  const S = d.scaling;
  if (!S) return '';
  const P = S.plan, A = P.assumptions, L = S.labels;
  const k = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `₹${(v / 1e5).toFixed(1)} L` : Math.abs(v) >= 1000 ? `₹${(v / 1000).toFixed(1)}k` : inr(v));
  const p1 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v.toFixed(0)}%`);
  const n0 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-IN'));
  const rows = S.rows;
  const cur = rows.find((r) => r.current) || rows.filter((r) => r.actual).at(-1);
  const ca = cur?.actual, cp = cur?.plan;

  // 1. Headline: orders per day this week vs plan.
  const t = toneOf(ca?.ordersPerDay, cp?.ordersPerDay);
  const pctOf = ca?.ordersPerDay !== undefined && cp?.ordersPerDay ? (ca.ordersPerDay / cp.ordersPerDay) * 100 : null;
  const C = S.cum;
  const cumT = C ? toneOf(C.actual, C.plan) : 'muted';
  const sub = (a, p, f, lower = false, label = '') => { const tt = toneOf(a, p, lower); return `<div class="plan-mini plan-${tt}"><span class="label">${esc(label)}</span><span class="value num">${f(a)}</span><span class="sub">plan ${f(p)}</span></div>`; };
  const G = S.gap;
  const gapLine = G && Math.abs(G.delta) >= 1 ? `<p class="small" style="margin:0">${G.delta < 0 ? 'Behind' : 'Ahead'} by <strong>${n0(Math.abs(G.delta))} orders a day</strong>: ${G.rows.map((r) => `${esc(r.label)} <span class="${r.orders >= 0 ? 'good' : 'bad'}">${r.orders >= 0 ? '+' : '−'}${n0(Math.abs(r.orders))}</span>`).join(' · ')}</p>` : '';
  const head = card('Orders vs plan', `Orders vs plan · week of ${shortDate(cur?.week)}`, ca?.partial ? `${ca.days} days so far this week, per-day averages` : '',
    `<div class="plan-hero plan-${t}">
       <div><span class="label">Orders per day</span><span class="big num">${n0(ca?.ordersPerDay)}</span><span class="small">plan ${n0(cp?.ordersPerDay)}${pctOf !== null ? ` · <strong>${pctOf.toFixed(0)}% of plan</strong>` : ''}</span></div>
       <div class="plan-verdict">${esc(TONE_WORD[t])}</div>
       ${C ? `<div><span class="label">Orders since the plan started</span><span class="big num" style="font-size:26px">${n0(C.actual)}</span><span class="small">plan ${n0(C.plan)} · <span class="${cumT === 'bad' ? 'bad' : cumT === 'warn' ? 'warn' : 'good'}">${C.plan ? ((C.actual / C.plan) * 100).toFixed(0) : '—'}%</span> over ${C.weeks} week${C.weeks > 1 ? 's' : ''}</span></div>` : ''}
     </div>` + gapLine +
    `<div class="plan-minis">${[
      sub(ca?.gmvPerDay, cp?.gmvPerDay, k, false, 'GMV / day'),
      sub(ca?.das.total, cp?.das.total, k, false, 'Spend / day'),
      sub(ca?.sgmv.overall, cp?.sgmv.overall, p1, true, 'Spend / GMV'),
      sub(ca?.aov, cp?.aov, inr, false, 'AOV'),
      sub(ca?.testing.winners, cp?.testing.winners, n0, false, 'Winners (lifetime)'),
      sub(ca?.testing.inTesting, cp?.testing.inTesting, n0, false, 'Trials running')
    ].join('')}</div>`);

  // 2. Week strip: one tile per week, coloured by orders vs plan.
  const strip = `<div class="week-strip">${rows.map((r) => {
    const tt = r.actual ? toneOf(r.actual.ordersPerDay, r.plan?.ordersPerDay) : 'future';
    const a = r.actual?.ordersPerDay, p = r.plan?.ordersPerDay;
    return `<div class="wk wk-${tt}${r.current ? ' wk-now' : ''}" title="${esc(shortDate(r.week))}: ${n0(a)} orders/day vs ${n0(p)} planned"><span class="small">${esc(shortDate(r.week))}</span><span class="num"><strong>${r.actual ? n0(a) : '·'}</strong></span><span class="small">${p ? `of ${n0(p)}` : 'no plan'}</span></div>`;
  }).join('')}</div>`;

  // 3. Charts.
  const lab = rows.map((r) => shortDate(r.week));
  const bars = (f) => rows.map((r) => (r.actual ? f(r.actual) ?? null : null));
  const plan = (f) => rows.map((r) => (r.plan ? f(r.plan) ?? null : null));
  const tones = (f, lower) => rows.map((r) => TONE[r.actual ? toneOf(f(r.actual), r.plan ? f(r.plan) : null, lower) : 'muted']);
  const charts = card('Weekly charts', 'Week by week against plan', 'Bars are actuals (per-day averages; colour = vs plan), the dashed line is the plan · orders, spend and winners on a log scale (each gridline is 10×)',
    `<div class="grid-2">
      <div><div class="group-title">Orders per day</div>${chartSvg({ labels: lab, bars: bars((x) => x.ordersPerDay), barColors: tones((x) => x.ordersPerDay), barOpacity: 0.85, lines: [{ values: plan((x) => x.ordersPerDay), color: 'var(--ink)', dash: true, dots: true }], yFmt: (v) => n0(v), barLabel: 'orders/day', log: true })}${legend([['var(--ink)', 'plan', true]])}</div>
      <div><div class="group-title">Spend per day (₹)</div>${chartSvg({ labels: lab, bars: bars((x) => x.das.total), barColors: tones((x) => x.das.total), barOpacity: 0.85, lines: [{ values: plan((x) => x.das.total), color: 'var(--ink)', dash: true, dots: true }], yFmt: k, log: true })}${legend([['var(--ink)', 'plan', true]])}</div>
      <div><div class="group-title">Spend / GMV</div>${chartSvg({ labels: lab, bars: bars((x) => x.sgmv.overall), barColors: tones((x) => x.sgmv.overall, true), barOpacity: 0.85, lines: [{ values: plan((x) => x.sgmv.overall), color: 'var(--ink)', dash: true, dots: true }], refLine: d.overview?.breakevenAdSgmv ? { value: d.overview.breakevenAdSgmv, label: `breakeven ~${d.overview.breakevenAdSgmv.toFixed(0)}%`, color: 'var(--green)' } : null, yFmt: (v) => `${Math.round(v)}%`, yCap: 80 })}${legend([['var(--ink)', 'plan', true], ['var(--green)', 'breakeven', true]])}</div>
      <div><div class="group-title">Winners found (lifetime)</div>${chartSvg({ labels: lab, bars: bars((x) => x.testing.winners), barColors: tones((x) => x.testing.winners), barOpacity: 0.85, lines: [{ values: plan((x) => x.testing.winners), color: 'var(--ink)', dash: true, dots: true }], yFmt: (v) => n0(v), log: true })}${legend([['var(--ink)', 'plan', true]])}</div>
    </div>`);

  // 4. Assumptions and risks, colour-coded.
  const fmtC = (c, v) => (v === null || v === undefined ? '—' : c.unit === '₹' ? inr(v) : `${v.toFixed(c.unit === '%' ? 0 : 0)}${c.unit}`);
  const checks = `<div class="checks">${S.checks.map((c) => `<div class="check check-${c.ok === null ? 'muted' : c.ok ? 'good' : 'bad'}"><span class="small">${esc(c.label)}</span><span class="num"><strong>${fmtC(c, c.actual)}</strong> <span class="muted small">plan ${fmtC(c, c.assumed)}</span></span></div>`).join('')}</div>`;
  const risks = card('Plan assumptions', 'Are the plan\'s assumptions holding?', 'Green: holding · red: off by more than 10% · grey: no data yet', checks +
    (S.risks.length ? `<div class="group-title" style="margin-top:4px">Risks to the plan</div><ul class="small" style="margin:0;padding-left:18px;line-height:1.6">${S.risks.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''));

  // 5. Simple week table + full bucket detail (collapsed).
  const cell = (r, f, fmt, lower = false) => {
    const a = r.actual ? f(r.actual) : null, p = r.plan ? f(r.plan) : null;
    if (!r.actual) return `<span class="muted">${p === null || p === undefined ? '—' : fmt(p)}</span>`;
    return `<div class="${{ good: 'good', warn: 'warn', bad: 'bad', muted: '' }[toneOf(a, p, lower)]}">${fmt(a)}</div>${p !== null && p !== undefined ? `<div class="muted small">plan ${fmt(p)}</div>` : ''}`;
  };
  const simple = tbl([
    { h: 'Week', v: (r) => `<strong>${shortDate(r.week)}</strong>${r.current ? ' ' + chip('blue', 'now') : ''}${r.actual?.partial ? `<div class="muted small">${r.actual.days} days ${r.current ? 'so far' : 'of data'}</div>` : ''}` },
    { h: 'Orders / day', r: 1, v: (r) => cell(r, (x) => x.ordersPerDay, n0) },
    { h: '% of plan', r: 1, v: (r) => { if (!r.actual || !r.plan?.ordersPerDay) return '<span class="muted">—</span>'; const tt = toneOf(r.actual.ordersPerDay, r.plan.ordersPerDay); return `<span class="chip chip-${{ good: 'green', warn: 'amber', bad: 'orange', muted: 'muted' }[tt]}">${((r.actual.ordersPerDay / r.plan.ordersPerDay) * 100).toFixed(0)}%</span>`; } },
    { h: 'GMV / day', r: 1, v: (r) => cell(r, (x) => x.gmvPerDay, k) },
    { h: 'Spend / day', r: 1, v: (r) => cell(r, (x) => x.das.total, k) },
    { h: 'Spend / GMV', r: 1, v: (r) => cell(r, (x) => x.sgmv.overall, p1, true) },
    { h: 'AOV', r: 1, v: (r) => cell(r, (x) => x.aov, inr) },
    { h: 'Hits scaling', r: 1, v: (r) => cell(r, (x) => (x.hits ? x.hits.active : x.testing.winners), n0) },
    { h: 'Trials running', r: 1, v: (r) => cell(r, (x) => (x.hits ? x.hits.trialsRunning : x.testing.inTesting), n0) }
  ], rows, { min: 980 });
  const col = (h, get, f, lower) => ({ h, r: 1, v: (r) => cell(r, get, f, lower) });
  const full = tbl([
    { h: 'Week', v: (r) => `<strong>${shortDate(r.week)}</strong>` },
    col('DAS total', (x) => x.das.total, k), col(`DAS ${L.catalog}`, (x) => x.das.catalog, k), col(`DAS ${L.winners}`, (x) => x.das.winners, k), col(`DAS ${L.testing}`, (x) => x.das.testing, k), col(`DAS ${L.metaOther}`, (x) => x.das.metaOther, k), col('DAS Google', (x) => x.das.google, k),
    col('S/GMV catalog', (x) => x.sgmv.catalog, p1, true), col('S/GMV winners', (x) => x.sgmv.winners, p1, true), col('S/GMV testing', (x) => x.sgmv.testing, p1, true),
    { h: 'GMV mix: catalog / winners / testing / Google', r: 1, v: (r) => (r.plan?.gmvMix ? `<span class="muted">${['catalog', 'winners', 'testing', 'google'].map((b) => Math.round(r.plan.gmvMix[b])).join(' / ')}%</span>` : '—') },
    { h: 'New trials / week', r: 1, v: (r) => (r.plan?.hits ? `<span class="muted">${n0(r.plan.hits.trialsStarted)}</span>` : '—') }
  ], rows, { min: 1500 });
  const weekCard = card('Week-wise plan', 'Week-wise plan and actuals', 'Actual on top (green on/above plan, amber within 10%, red behind), plan underneath; future weeks show the plan.', simple +
    `<details><summary style="cursor:pointer;font-weight:600" class="small">Spend by bucket, catalog efficiency needed, GMV mix and trials</summary><p class="small muted" style="margin:8px 0">DAS = daily average spend. Actual Meta S/GMV per bucket is Meta-reported (×${d.settings.metaSgmvFactor} correction) and over-counts across buckets; overall S/GMV uses actual orders. Google = day-wise total spend − Meta spend. Plan S/GMV catalog is what catalog must run at for the total to stay at ${P.targetSgmv}%.</p>${full}</details>`);

  // 6. Editor: the targets and assumptions; everything week by week follows from them.
  const inp = (name, v, w = 120) => `<input name="${name}" value="${esc(v)}" ${name === 'startWeek' || name.startsWith('m_date') ? '' : 'inputmode="decimal"'} style="width:${w}px;min-height:34px;border:1px solid var(--line);border-radius:6px;padding:0 6px;background:var(--surface);color:inherit;font:inherit;font-size:13px">`;
  const f = (name, label, v, hint = '') => `<div class="field"><label>${esc(label)}</label>${inp(name, v)}${hint ? `<span class="def">${esc(hint)}</span>` : ''}</div>`;
  const ms = P.milestones;
  const editor = `<details ${P.saved ? '' : 'open'}><summary style="cursor:pointer;font-weight:600">Targets and assumptions</summary>
    <form id="planForm" style="margin-top:12px;display:flex;flex-direction:column;gap:16px">
      <div><div class="group-title">Targets</div><div class="settings" style="margin-top:8px">
        ${f('startWeek', 'Plan starts (week of)', P.startWeek)}${f('startOpd', 'Orders/day at the start', P.startOpd, `L7D now: ${n0(d.overview?.last7?.ordersPerDay)}`)}
        ${ms.map((m, i) => f(`m_date_${i}`, `Milestone ${i + 1}: date`, m.date) + f(`m_opd_${i}`, `Milestone ${i + 1}: orders/day`, m.opd)).join('')}
        ${f('targetSgmv', 'Total Spend/GMV to hold (%)', P.targetSgmv)}${f('bandLo', 'Band low (%)', P.sgmvBand[0])}${f('bandHi', 'Band high (%)', P.sgmvBand[1])}
      </div></div>
      <div><div class="group-title">Hits</div><div class="settings" style="margin-top:8px">
        ${f('a_winnersShare', 'GMV from hits by the end (%)', A.winnersShare, 'ramps up from 0 at the start')}${f('a_winnerDas', 'Daily budget per hit at scale (₹)', A.winnerDas, `top of the ladder: ${inr(d.settings.ladder?.at(-1))}`)}
        ${f('s_winners', 'Spend/GMV of a hit at scale (%)', A.sgmv.winners)}${f('a_winnerLifeWeeks', 'Weeks a hit keeps scaling', A.winnerLifeWeeks)}
        ${f('a_successPct', 'Trial success (%)', A.successPct, `actual so far: ${pc(S.checks.find((c) => c.key === 'success')?.actual, 0)}`)}${f('a_trialBudget', 'Trial budget (₹/day)', A.trialBudget)}${f('a_trialDays', 'Days per trial', A.trialDays)}${f('s_testing', 'Spend/GMV in testing (%)', A.sgmv.testing)}
      </div></div>
      <div><div class="group-title">Other channels</div><div class="settings" style="margin-top:8px">
        ${f('a_googleShare', 'GMV from Google (%)', A.googleShare)}${f('s_google', 'Google Spend/GMV (%)', A.sgmv.google)}${f('a_otherShare', 'GMV from other Meta (%)', A.otherShare)}${f('s_metaOther', 'Other Meta Spend/GMV (%)', A.sgmv.metaOther)}${f('a_aov', 'AOV (₹)', A.aov)}
      </div><p class="small muted" style="margin-top:6px">Catalog carries the rest of the GMV with the rest of the budget: the plan shows the Spend/GMV it needs.</p></div>
      <div style="display:flex;gap:8px"><button type="submit" class="btn btn-primary">Save plan</button><button type="button" class="btn" id="resetPlan">Reset to default</button></div>
    </form></details>`;
  const noData = !rows.some((r) => r.actual && r.actual.ordersPerDay) ? `<div class="notice notice-amber">No orders from the day-wise question yet (Q16083), so actuals are blank. It's pulled every hour in the background; press Refresh after the next pull.</div>` : '';
  const end = rows.filter((r) => r.plan).at(-1)?.plan;
  const summary = end ? `<p style="margin:0;font-size:15px;line-height:1.6">${ms.map((m) => { const r = rows.find((x) => x.plan && x.week <= m.date && addDays(x.week, 6) >= m.date) || rows.filter((x) => x.plan).at(-1); return `<strong>${n0(m.opd)} orders/day by ${shortDate(m.date)}</strong> takes ${k(r.plan.das.total)} a day of spend (${k(r.plan.gmvPerDay)} GMV), ${n0(r.plan.hits.active)} hits scaling and ${n0(r.plan.hits.trialsStarted)} new trials a week, with catalog at ${p1(r.plan.sgmv.catalog)} Spend/GMV.`; }).join(' ')} Total Spend/GMV held at ${P.targetSgmv}% throughout.</p>` : '';
  return noData + head + card('Week strip', 'Orders per day, week by week', 'Green on or above plan · amber within 10% · red more than 10% behind · grey future', strip) + charts + risks + weekCard +
    card('Plan editor', 'The plan', (P.saved ? 'Saved plan. ' : 'Default plan from the targets you gave: 1,000 orders/day by the end of November and 10,000 by the end of January at 20–22% Spend/GMV. ') + 'Change the targets or assumptions and the weeks recompute.', summary + editor);
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
    early: () => viewEarly(d),
    repeat: () => viewRepeat(d),
    cross: () => viewCross(d),
    data: () => viewAudience(d, 'data')
  }[sub]();
  return bar + body;
}

// PMF summary: the theses Khoj has to prove, each with a clean "is it playing out?" call and the evidence behind it.
const STATUS = {
  yes: ['green', 'Playing out'], partly: ['amber', 'Partly'], no: ['orange', 'Not playing out'],
  early: ['muted', 'Too early'], data: ['muted', 'Needs data'], model: ['blue', 'Modelled'], potential: ['blue', 'Shown, not yet used'], none: ['muted', 'Not started']
};
const stChip = (s) => chip(...STATUS[s]);
// Early signs of likability: Khoj vs parent sellers on comparable products, weighted by Khoj orders.
function viewEarly(d) {
  const L = d.likability, RV = d.revisit, RB = d.repeatBench, rp = d.customers?.repeat;
  const w7 = rp?.curves.find((c) => c.days === 7)?.khoj;
  const cell = (label, k, b, fmt, better, n, extra = '') => {
    const ok = k === null || k === undefined || b === null || b === undefined ? null : better === 'up' ? k >= b : k <= b;
    return `<div class="kcell"><div class="klabel">${esc(label)}</div><div class="kval">${k === null || k === undefined ? '—' : fmt(k)}</div><div class="ksub small"><span class="muted">base sellers ${b === null || b === undefined ? '—' : fmt(b)}</span>${ok === null ? '' : ` · <span class="${ok ? 'kgood' : 'kbad'}">${ok ? 'better' : 'worse'}</span>`}</div><div class="ksub small muted">${n}${extra ? ` · ${extra}` : ''}</div></div>`;
  };
  const r2 = (v) => v.toFixed(2), p1 = (v) => pc(v, 1);
  const tiles = `<div class="kgrid kgrid-early">
    ${cell('Average rating', L?.rating?.khoj, L?.rating?.parent, r2, 'up', L?.rating ? `${int(L.rating.khojN)} Khoj ratings · ${int(L.rating.products)} products` : 'Q16826')}
    ${cell('Return requests per delivered order', L?.returns?.khoj, L?.returns?.parent, p1, 'down', L?.returns ? `${int(L.returns.khojN)} Khoj deliveries · ${int(L.returns.products)} products` : 'Q16859')}
    ${cell('Orders using a bumper coupon', L?.bumper?.khoj, L?.bumper?.parent, p1, 'up', L?.bumper ? `${int(L.bumper.khojN)} Khoj orders` : 'Q16830')}
    ${cell('Visited again within 7 days of delivery', RV?.khoj7, RV?.base7, p1, 'up', RV ? `${int(RV.khojN)} Khoj customers delivered` : 'needs MB_Q_REVISIT', RV?.khoj14 !== null && RV ? `14 days: ${pc(RV.khoj14, 1)} vs ${pc(RV.base14, 1)}` : '')}
    ${cell('Repeat order within 7 days of order placement', w7?.eligible ? w7.pct : null, RB?.rates?.d7, p1, 'up', w7?.eligible ? `${int(w7.eligible)} Khoj buyers` : 'order history')}
  </div>`;
  const disc = L?.rating?.aovDiscount ?? L?.returns?.aovDiscount;
  const head = `<section class="card" aria-label="Early signs"><div class="card-head"><div><h2>Early signs on repeats &amp; likability</h2><span class="muted small">Khoj vs the parent sellers' own sites on comparable products, weighted by Khoj orders · orders since 1 Oct</span></div></div>${tiles}
    <p class="small muted" style="margin:0">${disc !== null && disc !== undefined ? `Khoj's AOV on these products is ${pc(disc, 0)} below the parent sellers' (price is part of the comparison). ` : ''}Bumper coupon: higher read as better (buyers coming back to use it). Visits after delivery count only visitors tied to the customer (logged in, or seen with their id), on both sides.</p></section>`;
  const sellerTbl = (title, rows, fmt, better) => (rows?.length ? `<details><summary class="small" style="cursor:pointer;font-weight:600">${esc(title)} by parent seller</summary><div style="margin-top:8px">${tbl([
    { h: 'Parent seller', v: (r) => esc(r.name) },
    { h: 'Khoj', r: 1, v: (r) => (r.khoj === null ? '—' : fmt(r.khoj)), cls: (r) => (r.khoj === null || r.parent === null || r.khojN < 10 ? '' : (better === 'up' ? r.khoj >= r.parent : r.khoj <= r.parent) ? 'good' : 'bad') },
    { h: 'Parent', r: 1, v: (r) => (r.parent === null ? '—' : fmt(r.parent)) },
    { h: 'Khoj n', r: 1, v: (r) => int(r.khojN) }, { h: 'Parent n', r: 1, v: (r) => int(r.parentN) }
  ], rows.slice(0, 25), { min: 640 })}</div></details>` : '');
  const detail = L ? card('By seller', 'By parent seller', 'Top 25 by Khoj volume; colour only where Khoj has 10+ orders', `${sellerTbl('Rating', L.rating?.rows, r2, 'up')}${sellerTbl('Return requests', L.returns?.rows, p1, 'down')}${sellerTbl('Bumper coupon use', L.bumper?.rows, p1, 'up')}`) : '';
  return head + detail;
}

function viewPmfSummary(d) {
  const st = d.settings || {};
  const allK = Object.values(d.kpis || {});
  const S = (f) => allK.reduce((a, k) => a + (k[f] || 0), 0);
  const wins = S('winners'), losses = S('losses'), tested = S('tested'), live = S('liveTrials');
  const decided = wins + losses;
  const sr = decided ? (wins / decided) * 100 : null;
  const ci = decided ? 1.96 * Math.sqrt((sr / 100) * (1 - sr / 100) / decided) * 100 : null;
  const O = d.overview, PA = O?.pnl.all, P7 = O?.pnl.last7;
  const snm = (p) => (p && p.nmv ? (p.mkt / p.nmv) * 100 : null);
  const a = d.customers?.audience, cmp = a?.compare;
  const rp = d.customers?.repeat, RB = d.repeatBench, pay = rp?.payment;
  const w14 = rp?.curves.find((c) => c.days === 14)?.khoj, b14 = RB?.rates?.d14;
  const M = d.sessions?.matched, MM = M ? Object.fromEntries(M.metrics.map((m) => [m.key, m])) : {};
  const B = d.sessions?.beyond;
  const pers = a?.personalisation, V = d.visitorPersonalisation;
  const anyPred = pers ? (pers.browsing?.levels.find((x) => x.key === 'all_any') || pers.levels.find((x) => x.key === 'any')) : null;
  const U = d.universe ? Object.values(d.universe.byCat) : null;
  const uHero = U ? U.reduce((x, c) => x + (c.hero || 0), 0) : null, uAll = U ? U.reduce((x, c) => x + (c.all || 0), 0) : null;
  const testSpend = (d.trials || []).reduce((x, t) => x + (t.spend || 0), 0);
  const f1 = (v, dd = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dd));

  // ---- Thesis 1: lower cost of doing business ----
  // Spend/NMV, Khoj (best 3 of the last 5 days) vs the same products on their own seller sites:
  // S/GMV ÷ ((1 − cancelled) × (1 − RTO)).
  const QQ = d.productQuality, SG = d.sellerSgmv;
  const nmvShare = (c, r) => (c === null || r === null || c === undefined || r === undefined ? null : (1 - c / 100) * (1 - r / 100));
  // Khoj side: the best 3 of the last 5 complete days by Spend/NMV, pooled (worked out on the server).
  const B3 = O?.best3, PRd = O?.predictedRto;
  const kSide = B3 ? { sgmv: B3.sgmv, cancel: B3.cancelPct, online: B3.onlinePct, codRto: PRd?.cod.rtoPct, onlineRto: PRd?.online.rtoPct, rto: B3.predictedRto, nmv: B3.nmvShare, snmv: B3.snmv } : null;
  const bestLabel = B3 ? B3.dates.map(shortDate).join(', ') : '';
  const sSide = { sgmv: SG?.value ?? null, cancel: QQ?.cancel.seller ?? null, online: QQ?.online.seller ?? null, codRto: QQ?.codRto.seller ?? null, onlineRto: QQ?.onlineRto.seller ?? null };
  sSide.rto = sSide.online !== null && sSide.codRto !== null ? (1 - sSide.online / 100) * sSide.codRto + (sSide.online / 100) * (sSide.onlineRto ?? sSide.codRto) : null;
  sSide.nmv = nmvShare(sSide.cancel, sSide.rto); sSide.snmv = sSide.nmv && sSide.sgmv !== null ? sSide.sgmv / sSide.nmv : null;
  const kSn = kSide?.snmv ?? null, baseSn = sSide.snmv;
  const t1 = kSn === null || baseSn === null ? 'data' : kSn <= baseSn ? 'yes' : kSn <= baseSn * 1.15 ? 'partly' : 'no';

  const baseHit = st.baseHitPct || (uAll ? (uHero / uAll) * 100 : null);
  const hitS = sr === null ? 'data' : !st.baseHitPct ? 'data' : decided < 10 ? 'early' : sr >= baseHit * 1.5 ? 'yes' : sr >= baseHit ? 'partly' : 'no';
  // Customer quality: Khoj vs the same products on their own seller sites (order-quality question).
  const Q = d.productQuality;
  const qChecks = Q ? [[Q.rto, true], [Q.online, false], [Q.cancel, true]].filter(([m]) => m && m.khoj !== null && m.seller !== null) : [];
  const qWins = qChecks.filter(([m, lower]) => (lower ? m.khoj <= m.seller : m.khoj >= m.seller)).length;
  const qS = !qChecks.length ? 'data' : qWins === qChecks.length ? 'yes' : qWins ? 'partly' : 'no';
  // Repeat: early indicator (back within 7 days) and actual repeat (14 days), each vs parent sellers.
  const w7 = rp?.curves.find((c) => c.days === 7)?.khoj, b7 = RB?.rates?.d7;
  const rStat = (w, b) => (!rp || b === null || b === undefined ? 'data' : !w?.eligible || w.eligible < 100 ? 'early' : w.pct >= b ? 'yes' : w.pct >= b * 0.8 ? 'partly' : 'no');
  const eS = rStat(w7, b7), rS = rStat(w14, b14);
  // Early indicators: rating, return requests, bumper coupon use, visits after delivery, 7-day repeat (vs base sellers).
  const LK = d.likability, RV = d.revisit;
  const early = [
    LK?.rating && { l: 'rating', ok: LK.rating.khoj >= LK.rating.parent, txt: `rating ${LK.rating.khoj?.toFixed(2)} vs ${LK.rating.parent?.toFixed(2)}` },
    LK?.returns && { l: 'returns', ok: LK.returns.khoj <= LK.returns.parent, txt: `return requests ${pc(LK.returns.khoj, 1)} vs ${pc(LK.returns.parent, 1)}` },
    LK?.bumper && { l: 'bumper', ok: LK.bumper.khoj >= LK.bumper.parent, txt: `bumper coupon use ${pc(LK.bumper.khoj, 1)} vs ${pc(LK.bumper.parent, 1)}` },
    RV && RV.khoj7 !== null && RV.base7 !== null && { l: 'visit', ok: RV.khoj7 >= RV.base7, txt: `visit within 7 days of delivery ${pc(RV.khoj7, 1)} vs ${pc(RV.base7, 1)}` },
    w7?.eligible && b7 !== null && b7 !== undefined && { l: 'r7', ok: w7.pct >= b7, txt: `repeat within 7 days of order ${pc(w7.pct, 1)} vs ${pc(b7, 1)}` }
  ].filter(Boolean);
  const eWins = early.filter((x) => x.ok).length;
  const eS2 = !early.length ? 'data' : eWins === early.length ? 'yes' : eWins ? 'partly' : 'no';
  const earlyEv = early.length ? `Khoj vs parent sellers (Khoj-order weighted): ${early.map((x) => `<span class="${x.ok ? 'good' : 'bad'}">${esc(x.txt)}</span>`).join(' · ')}.${RV ? '' : ' Visits after delivery need sql/revisit_after_delivery.sql (MB_Q_REVISIT).'}` : 'Waiting for the rating, returns and bumper-coupon questions.';
  const repEv = (w, b, days) => (!w?.eligible ? `Not enough buyers ${days}+ days past their first order yet.` : b === null || b === undefined ? `Repeat within ${days} days of order placement: <strong>${pc(w.pct, 1)}</strong> Khoj. The parent-seller benchmark (Q16725) hasn't loaded yet.` : `Repeat within ${days} days of order placement: ${vs(w.pct, b)} parent sellers (order-weighted), on ${int(w.eligible)} buyers old enough to count.${w.eligible < 100 ? ' Under 100 buyers, so early.' : ''}`);
  const cat = d.catalog?.summary ? d.catalog.summary.reduce((a, x) => ({ hits: a.hits + x.hits, readable: a.readable + x.readable }), { hits: 0, readable: 0 }) : null;
  const catHit = cat && cat.readable ? (cat.hits / cat.readable) * 100 : null;
  // Conversion: orders per 100 sessions, Khoj vs parent sellers' sites (seller-level, order-weighted); browsing depth
  // from the product-matched comparison.
  const SM = d.sessions?.metrics ? Object.fromEntries(d.sessions.metrics.map((m) => [m.key, m])) : {};
  const conv = SM.ordersPerSession, pps = MM.productsPerSession || SM.productsPerSession;
  const cS = !conv || conv.khoj === null || !conv.bench ? 'data' : conv.khoj >= conv.bench && pps?.khoj >= pps?.bench ? 'yes' : conv.khoj >= conv.bench || pps?.khoj >= pps?.bench ? 'partly' : 'no';
  const dS = anyPred ? (anyPred.d30 >= 25 ? 'potential' : 'partly') : 'data';

  const row = (status, claim, ev, sub) => `<div class="thesis-row"><div>${stChip(status)}</div><div class="claim">${esc(claim)}</div><div class="ev">${ev}</div><div>${sub ? `<button type="button" class="btn" data-sub="${sub}" style="min-height:30px;padding:2px 10px;font-size:12px">Open</button>` : ''}</div></div>`;
  const vs = (k2, b, unit = '%', dd = 1) => `<strong>${f1(k2, dd)}${unit}</strong> Khoj vs <strong>${f1(b, dd)}${unit}</strong>`;
  const subs1 = [
    row(hitS, 'Lower wasted spend in finding hits (step-higher hit %)',
      sr === null ? 'No trial verdicts yet.' : `${st.baseHitPct ? `Hit rate ${vs(sr, baseHit, '%', 0)} base sellers.` : `Khoj hit rate <strong>${pc(sr, 0)}</strong>. Base sellers' hit rate on products they advertise isn't measured yet: set it in Rules → PMF benchmarks.${baseHit ? ` For context, ${pc(baseHit, 1)} of ShopDeck PQ ≥ 3 listings clear the hero bar (not like for like: most listings are never advertised).` : ''}`} ${wins} hits from ${decided} decided trials (±${Math.round(ci)} pts), ${live} still testing. Testing spend per hit: <strong>${wins ? inr(testSpend / wins) : '—'}</strong>.${decided < 10 ? ' Fewer than 10 verdicts, so the rate can still swing a lot.' : ''}${catHit !== null ? ` Catalog (directional): <strong>${pc(catHit, 0)}</strong> of ${int(cat.readable)} products with ≥ ${inr(st.catalogMinSpend)} catalog spend run at ≤ ${st.winBar}% Spend/GMV.` : ''}`, 'hits'),
    row(qS, 'Better customer quality than base sellers',
      Q ? `Khoj vs the same products on their own seller sites: RTO ${vs(Q.rto.khoj, Q.rto.seller)} (D-17 to D-10) · COD RTO ${vs(Q.codRto.khoj, Q.codRto.seller)} · online ${vs(Q.online.khoj, Q.online.seller)} (L15D) · cancelled ${vs(Q.cancel.khoj, Q.cancel.seller)}.${pay ? ` Repeat Khoj orders paid online: <strong>${pc(pay.repeatOnlinePct, 1)}</strong> (first orders ${pc(pay.firstOnlinePct, 1)}).` : ''}` : 'Needs the order-quality question (sql/product_quality.sql, MB_Q_PRODUCT_QUALITY).', 'quality'),
    row(eS2, 'Better repeat rate: early indicators', earlyEv, 'early'),
    row(rS, 'Better repeat rate: actual repeats', repEv(w14, b14, 14), 'repeat'),
    row(cS, 'Better website conversion from more cross-selling',
      conv ? `Orders per 100 sessions ${vs(conv.khoj, conv.bench, '', 2)} parent sellers' sites (Khoj-order weighted) · products viewed per session ${vs(pps?.khoj, pps?.bench, '', 2)}${MM.productsPerSession ? ' on the same landing products' : ''}.${B?.otherPct !== undefined ? ` ${pc(B.otherPct, 1)} of buy-now clicks are on a different product than the one landed on.` : ''}` : 'The site sessions question (Q16724) hasn\'t loaded: see Rules → Data sources.', 'cross'),
    row(dS, 'ShopDeck\'s data advantage',
      anyPred ? `<strong>${pc(anyPred.d30, 1)}</strong> of Khoj orders were predictable from the buyer's ShopDeck orders and browsing in the 30 days before. ${V ? `${pc(V.linkedPct, 1)} of visitors are identifiable at landing; personalising them could take conversion from ${pc(V.conversionPct, 2)} to ~${pc(V.estimate?.conservative?.newConversionPct, 2)}.` : ''} Not used on the site yet.` : 'Needs the browsing and personalisation questions.', 'data')
  ];
  const counts = (list) => { const c = { yes: 0, partly: 0, no: 0 }; for (const s of list) if (c[s] !== undefined) c[s]++; return c; };
  const c1 = counts([hitS, qS, eS2, rS, cS]);
  const sec1 = `<section class="card" aria-label="Lower cost of doing business"><div class="card-head"><div><h2>1 · Lower cost of doing business</h2><span class="muted small">Thesis: Khoj sells at a lower Spend/NMV than base sellers, because each of the drivers below is better</span></div>${stChip(t1)}</div>
    <div class="thesis-head plan-${{ yes: 'good', partly: 'warn', no: 'bad' }[t1] || ''}">
      <div><div class="small muted">Khoj Spend / NMV · best 3 of last 5 days (${esc(bestLabel)})</div><div class="big num">${pc(kSn, 1)}</div></div>
      <div><div class="small muted">Sellers, same products (Khoj-order weighted)</div><div class="big num">${pc(baseSn, 1)}</div></div>
      <div class="small" style="max-width:460px">${t1 === 'data' ? `Needs ${SG ? '' : 'seller S/GMV from the universe question and '}the order-quality question (MB_Q_PRODUCT_QUALITY) for the seller side's cancellations, online share and RTO.` : kSn <= baseSn ? `Playing out: Khoj spends ${f1(baseSn - kSn)} pts less per rupee of NMV than the same products on their sellers' sites.` : `${t1 === 'partly' ? 'Close, not there yet' : 'Not playing out yet'}: Khoj spends ${f1(kSn - baseSn)} pts more per rupee of NMV.`} Drivers: ${c1.yes} playing out, ${c1.partly} partly, ${c1.no} not.</div>
    </div>
    ${tbl([
      { h: 'Spend / NMV build-up', v: (r) => `<span class="${r.strong ? '' : 'muted'}">${r.strong ? `<strong>${esc(r.l)}</strong>` : esc(r.l)}</span>` },
      { h: 'Khoj · best 3 of L5D', r: 1, v: (r) => (r.strong ? `<strong>${r.k}</strong>` : r.k) },
      { h: 'Sellers · same products', r: 1, v: (r) => (r.strong ? `<strong>${r.s}</strong>` : r.s) },
      { h: 'Source (sellers)', v: (r) => `<span class="muted small">${esc(r.src)}</span>` }
    ], [
      { l: 'Spend / GMV', k: pc(kSide?.sgmv, 1), s: pc(sSide.sgmv, 1), src: SG ? `universe question, L30D, ${int(SG.products)} products, ${pc(SG.coverage, 0)} of Khoj orders` : 'universe question' },
      { l: 'Cancelled', k: pc(kSide?.cancel, 1), s: pc(sSide.cancel, 1), src: 'order-quality question, L15D' },
      { l: 'Online share', k: pc(kSide?.online, 1), s: pc(sSide.online, 1), src: 'order-quality question, L15D' },
      { l: 'RTO: COD / online', k: `${pc(kSide?.codRto, 1)} / ${pc(kSide?.onlineRto, 1)}`, s: `${pc(sSide.codRto, 1)} / ${pc(sSide.onlineRto, 1)}`, src: `Khoj: orders ${shortDate(O?.predictedRto?.from)}–${shortDate(O?.predictedRto?.to)} · sellers: D-17 to D-10` },
      { l: 'RTO at that payment mix', k: pc(kSide?.rto, 1), s: pc(sSide.rto, 1), src: '' },
      { l: 'NMV ÷ GMV = (1 − cancelled) × (1 − RTO)', k: pc(kSide?.nmv === null || kSide?.nmv === undefined ? null : kSide.nmv * 100, 1), s: pc(sSide.nmv === null ? null : sSide.nmv * 100, 1), src: '' },
      { l: 'Spend / NMV', k: pc(kSn, 1), s: pc(baseSn, 1), src: '', strong: true }
    ], { min: 760 })}
    <div class="thesis-rows">${subs1.join('')}</div></section>`;

  // ---- Thesis 2: scalability ----
  const winnersPerDay = O?.last7.ordersPerDay && wins ? O.last7.ordersPerDay / wins : null;
  const A = d.scaling?.plan.assumptions;
  const planPerHit = A && A.sgmv.winners && A.aov ? A.winnerDas / (A.sgmv.winners / 100) / A.aov : null;
  const perHit = st.ordersPerHitPerDay || planPerHit || winnersPerDay;
  const perHitNote = st.ordersPerHitPerDay ? 'set in Rules' : planPerHit ? `plan: ₹${int(A.winnerDas)}/day per hit at ${A.sgmv.winners}% S/GMV, ₹${int(A.aov)} AOV${winnersPerDay ? ` (all orders ÷ hits today: ${f1(winnersPerDay, 0)})` : ''}` : `today: ${f1(O.last7.ordersPerDay, 0)} orders/day ÷ ${wins} hits`;
  const ctrl = (d.bySource || []).find((x) => x.key === 'control');
  const ctrlSr = ctrl && ctrl.decided >= 5 ? (ctrl.winners / ctrl.decided) * 100 : null;
  const uSr = ctrlSr ?? st.unexploredSuccessPct ?? null;
  const uSrNote = ctrlSr !== null ? `control trials: ${ctrl.winners} of ${ctrl.decided}` : 'assumed (Rules); not enough control trials yet';
  const ceil1 = uHero && sr !== null && perHit ? uHero * (sr / 100) * perHit : null;
  const unexplored = uAll !== null ? uAll - uHero : null;
  const ceil2 = unexplored && uSr && perHit ? unexplored * (uSr / 100) * perHit : null;
  const now = O?.last7.ordersPerDay;
  const term = (label, v, note, cls = '') => `<div class="term ${cls}"><span class="small muted">${esc(label)}</span><span class="num">${v}</span><span class="small muted">${esc(note)}</span></div>`;
  const formula = (parts, result) => `<div class="formula">${parts.map((p, i) => (i ? '<span class="op">×</span>' : '') + p).join('')}<span class="op">=</span>${result}</div>`;
  const sec2 = `<section class="card" aria-label="Scalability"><div class="card-head"><div><h2>2 · Scalability</h2><span class="muted small">Thesis: the hit model has a ceiling far above today, inside ShopDeck and beyond it</span></div>${stChip(ceil1 ? 'model' : 'data')}</div>
    <div class="thesis-rows">
      <div class="thesis-row"><div>${stChip(ceil1 ? 'model' : 'data')}</div><div class="claim">Theoretical ceiling<div class="small muted" style="font-weight:400">Hits universe × success rate × scalability per hit</div></div><div class="ev">${formula([
        term('ShopDeck heroes', int(uHero), uHero !== null ? `${int(S('universeHeroLive') || S('heroLive'))} already live on Khoj` : 'needs the universe question'),
        term('Khoj success rate', pc(sr, 0), decided ? `${wins} of ${decided} decided` : 'no verdicts yet'),
        term('Orders/day per hit', f1(perHit, 1), perHitNote)
      ], term('Ceiling, orders/day', int(ceil1), now ? `${ceil1 ? (ceil1 / now).toFixed(0) : '—'}× today's ${int(now)}` : '', 'result'))}</div><div><button type="button" class="btn" data-sub="hits" style="min-height:30px;padding:2px 10px;font-size:12px">Open</button></div></div>
      <div class="thesis-row"><div>${stChip(ceil2 ? 'model' : 'data')}</div><div class="claim">Added ceiling<div class="small muted" style="font-weight:400">Listed on ShopDeck but unexplored × success rate × scalability</div></div><div class="ev">${formula([
        term('Listed, not yet heroes', int(unexplored), 'ShopDeck PQ ≥ 3 products below the hero bar'),
        term('Success rate', pc(uSr, 0), uSrNote),
        term('Orders/day per hit', f1(perHit, 1), perHitNote)
      ], term('Added, orders/day', int(ceil2), 'on top of the hero ceiling', 'result'))}</div><div></div></div>
      ${row('none', 'Can we replicate this with brands and sellers outside ShopDeck?', 'Not started.', '')}
    </div>
    <p class="small muted" style="margin:0">Ceilings are a model, not a forecast: they assume every hit sustains the same orders a day, ignore demand overlap between similar products, and the listed-but-unexplored base includes ShopDeck's long tail. Change the inputs in Rules → PMF benchmarks.</p></section>`;

  // ---- Other ----
  const sec3 = `<section class="card" aria-label="Other subjective points"><div class="card-head"><div><h2>3 · Other subjective points</h2><span class="muted small">Judgement calls the numbers don't settle</span></div></div>
    <div class="thesis-rows">${row('none', 'Customer value proposition', 'Why a buyer would come to Khoj rather than the seller\'s own site or a marketplace: selection of proven products, price, trust, delivery. To be written up.', 'early')}</div></section>`;

  return sec1 + sec2 + sec3;
}

function qualityTopCard(d) {
  const Q = d.productQuality, O = d.overview, pay = d.customers?.repeat?.payment;
  const l15 = O ? (() => { const days = O.daily.filter((r) => r.date >= addDays(O.today, -15) && r.date < O.today); const o = days.reduce((a, r) => a + r.orders, 0); return { online: o ? days.reduce((a, r) => a + r.online, 0) / o * 100 : null, cancel: o ? days.reduce((a, r) => a + r.cancelled, 0) / o * 100 : null, orders: o }; })() : null;
  const cmp = (m, lowerBetter) => {
    if (!m || m.khoj === null) return { v: '—', tone: '' };
    const tone = m.seller === null ? '' : (lowerBetter ? m.khoj <= m.seller : m.khoj >= m.seller) ? 'good' : 'bad';
    return { v: `<span class="${tone}">${pc(m.khoj, 1)}</span>${m.seller !== null ? ` <span class="muted" style="font-size:15px">vs ${pc(m.seller, 1)}</span>` : ''}`, tone };
  };
  const cov = (m) => (m && m.coverage !== null ? ` · seller data for ${pc(m.coverage, 0)} of Khoj orders` : '');
  const PR = O?.predictedRto;
  const rtoWin = PR ? `orders ${shortDate(PR.from)}–${shortDate(PR.to)} (D-17 to D-10)` : 'D-17 to D-10';
  const cards = [
    ['Online orders, L15D', pc(l15?.online, 1), l15 ? `all Khoj orders, ${int(l15.orders)} in 15 days` : ''],
    ['Online share: Khoj vs same products', cmp(Q?.online).v, Q ? `on their own seller sites, L15D${cov(Q.online)}` : 'needs the order-quality question'],
    ['RTO: Khoj vs same products', cmp(Q?.rto, true).v, `not delivered ÷ non-cancelled, ${rtoWin}`],
    ['COD RTO: Khoj vs same products', cmp(Q?.codRto, true).v, Q?.onlineRto?.khoj !== null && Q ? `online: ${pc(Q.onlineRto.khoj, 1)} vs ${pc(Q.onlineRto.seller, 1)}` : ''],
    ['Cancelled: Khoj vs same products', cmp(Q?.cancel, true).v, 'L15D'],
    ['Repeat Khoj orders paid online', pc(pay?.repeatOnlinePct, 1), pay ? `first orders: ${pc(pay.firstOnlinePct, 1)} · ${int(pay.repeatOrders)} repeat orders` : '']
  ];
  const missing = !Q ? '<p class="small muted">The like-for-like comparison needs the order-quality question: add it to Metabase from <code>sql/product_quality.sql</code> and set <code>MB_Q_PRODUCT_QUALITY</code> on Netlify. Khoj-only numbers fill in meanwhile from the day-wise question and the predicted RTO.</p>' : '';
  if (!Q && PR) { cards[2][1] = pc(PR.all.rtoPct, 1); cards[2][2] = `Khoj only, ${rtoWin}`; cards[3][1] = pc(PR.cod.rtoPct, 1); cards[3][2] = `Khoj only · online ${pc(PR.online.rtoPct, 1)}`; cards[4][1] = pc(l15?.cancel, 1); cards[4][2] = 'Khoj only, L15D'; }
  return card('Customer quality at a glance', 'Customer quality at a glance', 'Khoj vs the same products on their own seller sites, each seller product weighted by Khoj\'s orders of it', kpiRow(cards) + missing);
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
  </form>` + sourcesCard(d);
}

// ---------- sign in ----------
function renderLogin() {
  document.body.classList.add('signed-out');
  const domains = auth.domains.map((d) => '@' + d).join(' or ');
  $('view').innerHTML = `<div class="login card">
    <div><h2 style="font-size:20px">Sign in</h2><p class="muted small" style="margin-top:4px">Use your ${esc(domains || 'work')} Google account.</p></div>
    ${auth.error ? `<div class="notice notice-orange" role="alert">${esc(auth.error)}</div>` : ''}
    <div id="googleButton" class="google-button">${auth.busy ? '<span class="muted small">Signing in…</span>' : ''}</div>
  </div>`;
  if (!auth.busy) showGoogleButton();
}

// Google Identity Services: loaded only when sign-in is needed; Google calls back with a signed ID token.
let gsi = null;
function loadGsi() {
  gsi ||= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = () => resolve(window.google.accounts.id);
    sc.onerror = () => { gsi = null; reject(new Error('Could not load Google sign-in. Check your connection and reload.')); };
    document.head.appendChild(sc);
  }).then((id) => { id.initialize({ client_id: auth.clientId, callback: onGoogleCredential, ux_mode: 'popup', auto_select: false }); return id; });
  return gsi;
}
async function showGoogleButton() {
  try {
    const id = await loadGsi();
    const box = $('googleButton');
    if (box) id.renderButton(box, { theme: 'outline', size: 'large', text: 'signin_with', shape: 'rectangular', logo_alignment: 'left', width: Math.min(340, box.clientWidth || 340) });
  } catch (e) { auth.error = e.message; const box = $('googleButton'); if (box) box.innerHTML = `<span class="bad small">${esc(e.message)}</span>`; }
}
async function onGoogleCredential({ credential }) {
  auth.busy = true; auth.error = ''; renderLogin();
  try {
    const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential }) });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || r.statusText);
    auth.user = out.user;
  } catch (e) { auth.error = e.message; }
  auth.busy = false;
  if (auth.user) boot(); else renderLogin();
}

async function boot() {
  try {
    const r = await fetch('/api/auth/me');
    const me = r.ok ? await r.json() : { mode: 'open' };
    Object.assign(auth, { mode: me.mode, user: me.user, clientId: me.googleClientId, domains: me.domains || [] });
    if (me.removed) auth.error = 'This account no longer has access.';
  } catch { auth.mode = 'open'; }
  if (auth.mode === 'google' && !auth.user) return renderLogin();
  document.body.classList.remove('signed-out');
  track('open', { tab: tabKey() });
  load();
}

// ---------- usage tracking (page side) ----------
// Sends: page open, each tab view, Refresh clicks, and active time per tab (15-second ticks while the tab is visible
// and someone moved, typed or scrolled in the last 2 minutes). Batched every 2 minutes and when the page is hidden.
const SESSION = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const queue = [];
const activeSec = {};
let lastInput = Date.now();
const tabKey = () => (ui.tab === 'pmf' ? 'pmf/' + ui.sub : ui.tab);
function track(type, extra = {}) { if (auth.mode === 'google' && auth.user) queue.push({ type, ...extra }); }
function flushUsage(beacon = false) {
  if (!auth.user) return Promise.resolve();
  const events = queue.splice(0);
  for (const [tab, sec] of Object.entries(activeSec)) { events.push({ type: 'active', tab, sec }); delete activeSec[tab]; }
  if (!events.length) return Promise.resolve();
  const body = JSON.stringify({ session: SESSION, events });
  if (beacon && navigator.sendBeacon) return Promise.resolve(navigator.sendBeacon('/api/usage/events', new Blob([body], { type: 'application/json' })));
  return fetch('/api/usage/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
}
for (const ev of ['pointermove', 'keydown', 'scroll', 'click', 'touchstart']) addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });
setInterval(() => {
  if (auth.user && document.visibilityState === 'visible' && Date.now() - lastInput < 120_000) { const k = tabKey(); activeSec[k] = (activeSec[k] || 0) + 15; }
}, 15_000);
setInterval(() => flushUsage(), 120_000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushUsage(true); });
addEventListener('pagehide', () => flushUsage(true));

// ---------- Usage (admins) ----------
const TAB_NAMES = { status: 'Overall Status', plan: 'Scaling Plan & Status', rules: 'Rules', tasks: 'Task log', usage: 'Usage', pmf: 'PMF View' };
const tabName = (k) => (k?.startsWith('pmf/') ? `PMF · ${(PMF_SUBS.find(([s]) => s === k.slice(4)) || [, k.slice(4)])[1]}` : TAB_NAMES[k] || k || '—');
const fmtMin = (m) => (!m ? '—' : m < 60 ? `${m} min` : `${(m / 60).toFixed(m < 600 ? 1 : 0)} h`);
const EVENT_WORDS = { login: 'Signed in', logout: 'Signed out', open: 'Opened the dashboard', refresh: 'Refreshed from Metabase', task: 'Task', rules: 'Rules', plan: 'Plan', csv: 'Downloaded CSV', repull: 'Asked for a re-pull' };

async function loadUsage() {
  usage.loading = true; usage.error = ''; render();
  try {
    await flushUsage();
    const r = await apiFetch('/api/usage?days=' + usage.days);
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || r.statusText);
    usage.data = out;
  } catch (e) { usage.error = e.message; }
  usage.loading = false;
  if (ui.tab === 'usage') render();
}

function viewUsage() {
  const U = usage.data;
  if (!U && !usage.loading && !usage.error) { setTimeout(loadUsage); }
  const head = `<div class="card-head"><div><h2 style="font-size:20px">Usage</h2><span class="muted small">Who signs in, how often, where they spend time and what they change. Times in IST.</span></div>
    <div style="flex-direction:row;gap:8px;align-items:center;flex-wrap:wrap"><div class="seg-tabs">${[7, 30, 90].map((n) => `<button type="button" class="seg" data-udays="${n}" aria-pressed="${n === usage.days}">${n} days</button>`).join('')}</div>
    <a class="btn" style="display:inline-flex;align-items:center;text-decoration:none;color:inherit" href="/api/usage.csv?days=${usage.days}">Download events (CSV)</a></div></div>`;
  if (usage.error) return `<div class="card">${head}<div class="notice notice-orange">Could not load usage: ${esc(usage.error)}</div></div>`;
  if (!U) return `<div class="card">${head}<p class="muted">Loading…</p></div>`;
  const T = U.totals, seen = U.users.filter((u) => u.lastSeen);
  const kpi = (label, value, sub = '') => `<div class="kpi"><span class="label">${esc(label)}</span><span class="value num">${value}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</div>`;
  const lab = U.daily.map((x) => shortDate(x.date));
  const acts = (a) => [['task', 'tick', 'ticks'], ['rules', 'rule edit', 'rule edits'], ['plan', 'plan edit', 'plan edits'], ['refresh', 'refresh', 'refreshes'], ['csv', 'CSV', 'CSVs']].filter(([k]) => a[k]).map(([k, one, many]) => `${a[k]} ${a[k] === 1 ? one : many}`).join(' · ') || '<span class="muted">—</span>';
  const people = U.users.map((u) => `<tr><td><div class="prod"><span class="name">${esc(u.email)}</span>${U.access.admins.includes(u.email) ? '<span class="small muted">admin</span>' : ''}</div></td>
    <td class="nowrap">${u.lastSeen ? esc(fmtWhen(u.lastSeen)) : '<span class="muted">Never signed in</span>'}</td>
    <td class="r num">${u.lastSeen ? `${u.daysActive7} / ${u.daysActive}` : '—'}</td><td class="r num">${u.sessions || '—'}</td><td class="r num">${u.logins || '—'}</td>
    <td class="r num nowrap">${fmtMin(u.activeMin7)} / ${fmtMin(u.activeMin)}</td><td class="nowrap">${esc(u.topTab ? tabName(u.topTab) : '—')}</td><td class="wrap-cell small">${acts(u.actions)}</td></tr>`).join('');
  const maxTab = Math.max(1, ...U.tabs.map((t) => t.activeMin));
  const tabs = U.tabs.map((t) => `<tr><td class="nowrap">${esc(tabName(t.tab))}</td><td style="width:28%"><div class="bar" style="min-width:60px"><span style="width:${(t.activeMin / maxTab) * 100}%;background:var(--blue)"></span></div></td><td class="r num">${fmtMin(t.activeMin)}</td><td class="r num">${t.views}</td><td class="r num">${t.users}</td></tr>`).join('');
  const recent = U.recent.map((e) => `<tr><td class="nowrap small">${esc(fmtWhen(e.at))}</td><td class="nowrap">${esc(e.email)}</td><td class="wrap-cell">${esc(EVENT_WORDS[e.type] || e.type)}${e.detail ? ` <span class="muted">· ${esc(e.detail)}</span>` : ''}</td></tr>`).join('');
  const A = U.access, envChips = (xs) => (xs.length ? xs.map((x) => chip('muted', x)).join(' ') : '<span class="muted small">none</span>');
  const denied = U.denied.map((x) => `<tr><td class="nowrap">${esc(x.email)}</td><td class="r num">${x.tries}</td><td class="nowrap small">${esc(fmtWhen(x.lastAt))}</td></tr>`).join('');
  return `<div class="card">${head}
    <div class="kpis kpis-7">${kpi('Active today', T.usersToday)}${kpi('Active, last 7 days', T.users7, `of ${T.people} with access or seen`)}${kpi(`Active, last ${U.days} days`, T.usersWindow)}${kpi('Sessions, last 7 days', T.sessions7)}${kpi('Active time, last 7 days', fmtMin(T.activeMin7), 'time with the page open and in use')}${kpi('Actions, last 7 days', T.actions7, 'ticks, rule & plan edits, refreshes')}</div>
    <div class="grid-2"><div><div class="group-title">People active per day</div>${chartSvg({ labels: lab, bars: U.daily.map((x) => x.users), yFmt: (v) => Math.round(v), barLabel: 'people', barOpacity: 0.5 })}</div>
      <div><div class="group-title">Active time per day</div>${chartSvg({ labels: lab, bars: U.daily.map((x) => x.activeMin), yFmt: (v) => fmtMin(Math.round(v)), barColor: 'var(--green)', barOpacity: 0.5 })}</div></div>
  </div>
  <div class="card"><div class="card-head"><div><h2>People</h2><span class="muted small">${seen.length} signed in during the last ${U.days} days. Days and time: last 7 days / last ${U.days}.</span></div></div>
    <div class="table-box"><table><thead><tr><th>Person</th><th>Last seen</th><th class="r">Days active</th><th class="r">Sessions</th><th class="r">Sign-ins</th><th class="r">Active time</th><th>Most used tab</th><th>Actions</th></tr></thead><tbody>${people || '<tr><td colspan="8" class="muted">Nobody yet.</td></tr>'}</tbody></table></div></div>
  <div class="grid-2">
    <div class="card"><div class="card-head"><div><h2>Where time goes</h2><span class="muted small">Last ${U.days} days</span></div></div>
      <div class="table-box"><table><thead><tr><th>Tab</th><th></th><th class="r">Active time</th><th class="r">Views</th><th class="r">People</th></tr></thead><tbody>${tabs || '<tr><td colspan="5" class="muted">No tab views yet.</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h2>Recent activity</h2><span class="muted small">Sign-ins and changes, newest first</span></div></div>
      <div class="table-box" style="max-height:420px;overflow-y:auto"><table><tbody>${recent || '<tr><td class="muted">Nothing yet.</td></tr>'}</tbody></table></div></div>
  </div>
  <div class="grid-2">
    <div class="card"><div class="card-head"><div><h2>Blocked sign-ins</h2><span class="muted small">Google accounts outside the allowed domains that tried to sign in, last ${U.days} days</span></div></div>
      <div class="table-box"><table><thead><tr><th>Account</th><th class="r">Tries</th><th>Last try</th></tr></thead><tbody>${denied || '<tr><td colspan="3" class="muted">None.</td></tr>'}</tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h2>Access</h2><span class="muted small">Set in Netlify environment variables</span></div></div>
      <div class="small" style="display:flex;flex-direction:column;gap:10px"><div>Allowed domains (Google Workspace): ${envChips(A.domains)}</div><div>Admins, who see this tab: ${envChips(A.admins)}</div></div></div>
  </div>`;
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
  if (e.target.closest('#signOut')) { flushUsage(); await fetch('/api/auth/logout', { method: 'POST' }); location.reload(); return; }
  const ud = e.target.closest('[data-udays]');
  if (ud) { usage.days = Number(ud.dataset.udays); usage.data = null; loadUsage(); return; }
  const rp = e.target.closest('[data-repull]');
  if (rp) { await apiFetch(`/api/sources/${rp.dataset.repull}/repull`, { method: 'POST' }); ui.repulled = { ...(ui.repulled || {}), [rp.dataset.repull]: true }; render(); return; }
  const pg = e.target.closest('[data-cpage]');
  if (pg) { custUi.page += Number(pg.dataset.cpage); $('custTable').innerHTML = custTableInner(); $('custTable').scrollIntoView({ block: 'start', behavior: 'smooth' }); return; }
  const t = e.target.closest('[data-cat],[data-tab],[data-sub],[data-win],[data-live],#refresh,#retry,#resetRules,#resetPlan');
  if (!t) return;
  if (t.dataset.cat) { ui.cat = t.dataset.cat; remember(); render(); }
  else if (t.dataset.tab) { if (t.dataset.tab === 'usage') usage.data = null; ui.tab = t.dataset.tab; remember(); render(); track('view', { tab: tabKey() }); }
  else if (t.dataset.sub) { ui.sub = t.dataset.sub; remember(); render(); track('view', { tab: tabKey() }); }
  else if (t.dataset.win) { ui.win = t.dataset.win; remember(); render(); }
  else if (t.dataset.live) { ui.live = t.dataset.live; remember(); render(); }
  else if (t.id === 'refresh' || t.id === 'retry') { track('refresh', { tab: tabKey() }); load(true, true); }
  else if (t.id === 'resetPlan') {
    if (!confirm('Reset the plan to the default targets?')) return;
    await apiFetch('/api/plan', { method: 'DELETE' });
    load(false);
  }
  else if (t.id === 'resetRules') {
    if (!confirm('Reset every rule to its default?')) return;
    await apiFetch('/api/settings', { method: 'DELETE' });
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
  const res = await apiFetch('/api/tasks/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done }) });
  if (!res.ok) { ui.msg = 'Could not save that tick. Refresh and try again.'; if (task) task.done = !done; render(); }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'planForm') {
    e.preventDefault();
    const f = e.target, v = (n) => Number(f.querySelector(`[name="${n}"]`)?.value);
    const P = ui.data.scaling.plan;
    const sv = (n) => f.querySelector(`[name="${n}"]`)?.value.trim();
    const milestones = P.milestones.map((_, i) => ({ date: sv(`m_date_${i}`), opd: v(`m_opd_${i}`) }));
    const body = { version: 2, startWeek: sv('startWeek'), startOpd: v('startOpd'), milestones, targetSgmv: v('targetSgmv'), sgmvBand: [v('bandLo'), v('bandHi')],
      assumptions: { aov: v('a_aov'), successPct: v('a_successPct'), trialBudget: v('a_trialBudget'), trialDays: v('a_trialDays'), winnerDas: v('a_winnerDas'), winnerLifeWeeks: v('a_winnerLifeWeeks'),
        winnersShare: v('a_winnersShare'), googleShare: v('a_googleShare'), otherShare: v('a_otherShare'),
        sgmv: { testing: v('s_testing'), winners: v('s_winners'), google: v('s_google'), metaOther: v('s_metaOther') } } };
    const res = await apiFetch('/api/plan', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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
  const res = await apiFetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  ui.saving = false;
  if (!res.ok) ui.msg = 'Could not save rules.';
  await load(false);
});

boot();
