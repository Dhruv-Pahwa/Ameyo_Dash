/* ============================================
   TRENDS - day-by-day history from the nightly snapshots in history/
   ============================================ */

const HISTORY_DIR = 'history';
const HISTORY_MAX_DAYS = 30;

// status: idle | loading | ready | error. days: oldest first, one entry per saved day.
const trendState = { status: 'idle', error: '', days: [], range: 15, metric: 'ready' };

// agent(row) is a value for one merged agent row, day(stats) the team value for one day.
const TREND_METRICS = {
  ready:    { label: 'Avg ready time',     kind: 'dur', goodUp: true,  agent: r => readySecs(r),                                   day: s => s.avgReady },
  brk:      { label: 'Avg break time',     kind: 'dur', goodUp: false, agent: r => timeToSeconds(r['Total Break Duration']),       day: s => s.avgBreak },
  breakPct: { label: 'Break % of staffed', kind: 'pct', goodUp: false, agent: r => pctOf(r['Total Break Duration'], r['Total Staffed Duration']), day: s => s.breakPct },
  talk:     { label: 'Avg talk time',      kind: 'dur', goodUp: true,  agent: r => timeToSeconds(r['Total Talk Time in Interval']), day: s => s.avgTalk },
  staffed:  { label: 'Avg staffed time',   kind: 'dur', goodUp: true,  agent: r => timeToSeconds(r['Total Staffed Duration']),     day: s => s.avgStaffed },
  autoOn:   { label: 'Avg auto call-on',   kind: 'dur', goodUp: true,  agent: r => timeToSeconds(r['Auto Call-On Duration']),      day: s => s.avgOn }
};

function pctOf(part, whole) {
  const w = timeToSeconds(whole);
  return w > 0 ? timeToSeconds(part) / w * 100 : 0;
}

function dayLabel(iso) {
  const [, m, d] = iso.split('-');
  return `${+d} ${MONTHS[+m - 1]}`;
}

function fmtTrend(kind, v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return kind === 'pct' ? v.toFixed(1) + '%' : secondsToTime(Math.round(v));
}

function fmtTrendAxis(kind, v) {
  return kind === 'pct' ? Math.round(v) + '%' : fmtHM(v);
}

// ---- Loading ----
async function loadHistory() {
  if (trendState.status === 'loading') return;
  trendState.status = 'loading';
  try {
    const resp = await fetchWithTimeout(`${HISTORY_DIR}/index.json?t=${Date.now()}`);
    if (!resp.ok) throw new Error('No history yet');
    const idx = await resp.json();
    const dates = (idx.dates || []).slice().sort().slice(-HISTORY_MAX_DAYS);
    const days = await Promise.all(dates.map(loadHistoryDay));
    trendState.days = days.filter(Boolean);
    trendState.status = 'ready';
  } catch (e) {
    trendState.days = [];
    trendState.status = 'error';
    trendState.error = location.protocol === 'file:'
      ? 'History loads only from the published site, not from a local file.'
      : 'No history saved yet. A snapshot is taken every night at 11 PM IST.';
  }
  // Re-render so the sparkline column and the Trends tab pick the history up.
  if (state.allRows.length) applyFilters();
}

async function loadHistoryDay(date) {
  try {
    const resp = await fetchWithTimeout(`${HISTORY_DIR}/${date}.csv`);
    if (!resp.ok) return null;
    const rows = extractAgentRows(await resp.text()).map(r => ({
      ...r, _date: date, _tl: leadEmailFor(r['User ID']), _type: agentTypeFor(r['User ID'])
    }));
    let breaks = null;
    try {
      const b = await fetchWithTimeout(`${HISTORY_DIR}/${date}-breaks.csv`);
      if (b.ok) breaks = summarizeBreaks(parseCSV(await b.text()).rows);
    } catch (e) { /* the break file is optional */ }
    return { date, rows, breaks };
  } catch (e) {
    return null;
  }
}

function historyReady() {
  return trendState.status === 'ready' && trendState.days.length >= 2;
}

// ---- Filtering and per-day numbers ----
// Same filters as the table. Campaigns only filter when some are unticked, because history can
// hold campaigns that are not in today's live sheet.
function trendFilter(r) {
  const allCampaigns = state.selectedCampaigns.size === state.campaigns.length;
  if (!allCampaigns && !state.selectedCampaigns.has(r['Campaign Name'])) return false;
  if (!leadPasses('main', r._tl)) return false;
  if (state.agentType.main && typeKey(r._type) !== state.agentType.main) return false;
  const search = document.getElementById('searchEmployee').value.toLowerCase().trim();
  if (search && !(r['User Name'] || '').toLowerCase().includes(search)) return false;
  return true;
}

function dayStats(day) {
  const agents = mergeByAgent(day.rows.filter(trendFilter))
    .filter(r => timeToSeconds(r['Total Staffed Duration']) > 0);
  const n = agents.length;
  const sum = f => agents.reduce((s, r) => s + timeToSeconds(r[f]), 0);
  const staffed = sum('Total Staffed Duration');
  const brk = sum('Total Break Duration');
  const ready = agents.reduce((s, r) => s + readySecs(r), 0);
  const per = v => (n ? v / n : null);

  // Average break time per agent, by reason, for the agents left after the filters.
  const ids = new Set(agents.map(r => (r['User ID'] || '').trim().toLowerCase()));
  const reasons = {};
  if (day.breaks) {
    day.breaks.agents.filter(a => ids.has(a.userId)).forEach(a => {
      Object.entries(a.reasons).forEach(([k, v]) => { reasons[k] = (reasons[k] || 0) + v.secs; });
    });
  }
  return {
    date: day.date, n,
    avgStaffed: per(staffed), avgReady: per(ready), avgBreak: per(brk),
    avgTalk: per(sum('Total Talk Time in Interval')), avgOn: per(sum('Auto Call-On Duration')),
    breakPct: staffed > 0 ? brk / staffed * 100 : null,
    reasons: Object.fromEntries(Object.entries(reasons).map(([k, v]) => [k, v / n]))
  };
}

function mean(vals) {
  const v = vals.filter(x => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// ---- Trends tab ----
function setTrendRange(v) { trendState.range = +v; applyFilters(); }
function setTrendMetric(v) { trendState.metric = v; applyFilters(); }

function renderTrends() {
  if (chartState.tab !== 'trends') return;
  const note = document.getElementById('trendsNote');
  const body = document.getElementById('trendsBody');
  document.getElementById('trendRange').value = String(trendState.range);
  document.getElementById('trendMetric').value = trendState.metric;

  if (trendState.status !== 'ready' || !trendState.days.length) {
    body.style.display = 'none';
    note.textContent = trendState.status === 'error' ? trendState.error
      : trendState.status === 'ready' ? 'No history saved yet. A snapshot is taken every night at 11 PM IST.'
      : 'Loading history…';
    return;
  }
  if (typeof Chart === 'undefined') {
    body.style.display = 'none';
    note.textContent = 'Charts could not load (check your internet connection).';
    return;
  }
  body.style.display = '';

  const all = trendState.days.map(dayStats);
  const R = trendState.range;
  const shown = all.slice(-R);
  const first = shown[0].date, last = shown[shown.length - 1].date;
  note.textContent = `${shown.length} day${shown.length !== 1 ? 's' : ''} shown (${dayLabel(first)} – ${dayLabel(last)})`
    + (all.length < R ? `, the most history saved so far` : '')
    + '. Filters above apply. One snapshot per day, taken at 11 PM IST.';

  renderTrendCards(all, R);
  renderTrendCharts(shown);
  renderTrendTable(shown);
}

function renderTrendCards(all, R) {
  const cur = all.slice(-R).filter(s => s.n > 0);
  const prev = all.slice(-2 * R, -R).filter(s => s.n > 0);
  document.getElementById('trendCards').innerHTML = Object.values(TREND_METRICS).map(m => {
    const c = mean(cur.map(m.day));
    const p = prev.length ? mean(prev.map(m.day)) : null;
    let delta = '<span class="card-sub">No earlier period to compare</span>';
    if (c !== null && p) {
      const ch = (c - p) / p * 100;
      const flat = Math.abs(ch) < 0.5;
      const good = ch > 0 === m.goodUp;
      delta = `<span class="card-sub delta ${flat ? 'delta-flat' : good ? 'delta-good' : 'delta-bad'}">${flat ? '●' : ch > 0 ? '▲' : '▼'} ${Math.abs(ch).toFixed(1)}% vs previous ${prev.length} day${prev.length !== 1 ? 's' : ''}</span>`;
    }
    return `<div class="card"><span class="card-label">${escapeHTML(m.label.toUpperCase())}</span><span class="card-value">${fmtTrend(m.kind, c)}</span>${delta}</div>`;
  }).join('');
}

function trendChartDefaults() {
  const t = themeColors();
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.color = t.text;
  return t;
}

function renderTrendCharts(shown) {
  const t = trendChartDefaults();
  const m = TREND_METRICS[trendState.metric];
  const labels = shown.map(s => dayLabel(s.date));
  const noData = shown.every(s => s.n === 0);
  ['chTrMetric', 'chTrSplit', 'chTrAgents', 'chTrReasons'].forEach(id => setChartEmpty(id, noData));
  if (noData) return;

  const xScale = { ticks: { color: t.text }, grid: { display: false } };
  const yDur = { beginAtZero: true, ticks: { color: t.text, callback: v => fmtHM(v) }, grid: { color: t.grid } };

  document.getElementById('trMetricTitle').textContent = m.label + ' per day';
  drawChart('chTrMetric', {
    type: 'line',
    data: { labels, datasets: [{ label: m.label, data: shown.map(s => m.day(s)), borderColor: CHART_COLORS.ready, backgroundColor: CHART_COLORS.ready + '22', fill: true, tension: 0.25, spanGaps: true, pointRadius: 3 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtTrend(m.kind, c.parsed.y) } } },
      scales: { x: xScale, y: { grace: '10%', ticks: { color: t.text, callback: v => fmtTrendAxis(m.kind, v) }, grid: { color: t.grid } } }
    }
  });

  drawChart('chTrSplit', {
    type: 'bar',
    data: { labels, datasets: [
      { label: 'Avg ready', data: shown.map(s => s.avgReady), backgroundColor: CHART_COLORS.ready, borderRadius: 3 },
      { label: 'Avg break', data: shown.map(s => s.avgBreak), backgroundColor: CHART_COLORS.brk, borderRadius: 3 }
    ] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: t.text } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${secondsToTime(Math.round(c.parsed.y))}` } } },
      scales: { x: { ...xScale, stacked: true }, y: { ...yDur, stacked: true } }
    }
  });

  drawChart('chTrAgents', {
    type: 'bar',
    data: { labels, datasets: [{ data: shown.map(s => s.n), backgroundColor: CHART_COLORS.auto, borderRadius: 4 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y} agent${c.parsed.y !== 1 ? 's' : ''}` } } },
      scales: { x: xScale, y: { beginAtZero: true, ticks: { color: t.text, precision: 0 }, grid: { color: t.grid } } }
    }
  });

  const totals = {};
  shown.forEach(s => Object.entries(s.reasons).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; }));
  const reasons = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  setChartEmpty('chTrReasons', reasons.length === 0);
  if (reasons.length) {
    drawChart('chTrReasons', {
      type: 'bar',
      data: { labels, datasets: reasons.map((k, i) => ({ label: k, data: shown.map(s => s.reasons[k] || 0), backgroundColor: CHART_COLORS.cat[i % CHART_COLORS.cat.length], borderRadius: 2 })) },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'right', labels: { color: t.text } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${secondsToTime(Math.round(c.parsed.y))}` } } },
        scales: { x: { ...xScale, stacked: true }, y: { ...yDur, stacked: true } }
      }
    });
  }
}

function renderTrendTable(shown) {
  const cell = (m, v) => `<td class="dur-cell">${fmtTrend(m.kind, v)}</td>`;
  document.getElementById('trendTableBody').innerHTML = shown.slice().reverse().map(s =>
    s.n === 0
      ? `<tr><td>${dayLabel(s.date)}</td><td>0</td><td colspan="6" class="ad-note">No agents logged in for these filters</td></tr>`
      : `<tr><td>${dayLabel(s.date)}</td><td>${s.n}</td>` +
        ['staffed', 'ready', 'brk', 'breakPct', 'talk', 'autoOn'].map(k => cell(TREND_METRICS[k], TREND_METRICS[k].day(s))).join('') + '</tr>'
  ).join('');
}

// ---- Per-agent history ----
// Merged agent rows of a saved day, by user id (built once per day).
function dayAgents(day) {
  if (!day._agents) {
    const map = new Map();
    mergeByAgent(day.rows).forEach(r => map.set(agentKey(r), r));
    day._agents = map;
  }
  return day._agents;
}

function agentKey(r) {
  return (r['User ID'] || r['User Name'] || '').trim().toLowerCase();
}

function agentSeries(key, metric) {
  return trendState.days.slice(-trendState.range).map(d => {
    const a = dayAgents(d).get(key);
    return a && timeToSeconds(a['Total Staffed Duration']) > 0 ? metric.agent(a) : null;
  });
}

// Small inline line for the table. Green when the agent moved the right way over the range.
function sparkline(key) {
  const m = TREND_METRICS[trendState.metric];
  const vals = agentSeries(key, m);
  const pts = vals.map((v, i) => ({ v, i })).filter(p => p.v !== null);
  if (pts.length < 2) return '<span class="break-none">—</span>';
  const w = 96, h = 26, pad = 3;
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  const x = i => pad + i * (w - 2 * pad) / Math.max(1, vals.length - 1);
  const y = v => (hi === lo ? h / 2 : h - pad - (v - lo) / (hi - lo) * (h - 2 * pad));
  const up = pts[pts.length - 1].v >= pts[0].v;
  const color = up === m.goodUp ? '#16a34a' : '#dc2626';
  const line = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const end = pts[pts.length - 1];
  const tip = `${dayLabel(trendState.days.slice(-trendState.range)[pts[0].i].date)}: ${fmtTrend(m.kind, pts[0].v)} → ${dayLabel(trendState.days.slice(-trendState.range)[end.i].date)}: ${fmtTrend(m.kind, end.v)}`;
  return `<button class="spark-btn" title="${escapeHTML(tip)}" onclick="openAgentTrend('${escapeHTML(key)}')"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(end.i).toFixed(1)}" cy="${y(end.v).toFixed(1)}" r="2.4" fill="${color}"/></svg></button>`;
}

function trendColumnVisible() {
  return state.view === 'live' && historyReady();
}

function syncTrendHeader() {
  const th = document.getElementById('trendColumnHeader');
  th.style.display = trendColumnVisible() ? '' : 'none';
  document.getElementById('trendColumnLabel').textContent = TREND_METRICS[trendState.metric].label;
}

function openAgentTrend(key) {
  const days = trendState.days.slice(-trendState.range);
  const m = TREND_METRICS[trendState.metric];
  const rows = days.map(d => ({ date: d.date, a: dayAgents(d).get(key) }));
  const named = rows.map(r => r.a).filter(Boolean);
  const name = (named.length && named[named.length - 1]['User Name']) || key;
  document.getElementById('agentTrendTitle').textContent = name;
  document.getElementById('agentTrendSub').textContent = `Last ${days.length} saved day${days.length !== 1 ? 's' : ''}. Days the agent was not logged in are left out of the chart.`;
  document.getElementById('agentTrendBody').innerHTML = rows.slice().reverse().map(({ date, a }) =>
    a ? `<tr><td>${dayLabel(date)}</td><td class="dur-cell">${a['Total Staffed Duration']}</td><td class="dur-cell">${secToDur(readySecs(a))}</td><td class="dur-cell">${a['Total Break Duration']}</td><td class="dur-cell">${pctOf(a['Total Break Duration'], a['Total Staffed Duration']).toFixed(1)}%</td><td class="dur-cell">${a['Auto Call-On Duration']}</td><td class="dur-cell">${a['Total Talk Time in Interval'] || '00:00:00'}</td></tr>`
      : `<tr class="row-muted"><td>${dayLabel(date)}</td><td colspan="6" class="ad-note">Not logged in</td></tr>`
  ).join('');
  document.getElementById('agentTrendModal').classList.add('open');

  const series = agentSeries(key, m);
  const hasData = series.some(v => v !== null);
  document.querySelector('.agent-trend-chart').style.display = hasData ? '' : 'none';
  if (typeof Chart === 'undefined' || !hasData) return;
  const t = trendChartDefaults();
  drawChart('chAgentTrend', {
    type: 'line',
    data: { labels: days.map(d => dayLabel(d.date)), datasets: [{ label: m.label, data: series, borderColor: CHART_COLORS.ready, backgroundColor: CHART_COLORS.ready + '22', fill: true, tension: 0.25, spanGaps: true, pointRadius: 3 }] },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtTrend(m.kind, c.parsed.y) } } },
      scales: { x: { ticks: { color: t.text }, grid: { display: false } }, y: { grace: '10%', ticks: { color: t.text, callback: v => fmtTrendAxis(m.kind, v) }, grid: { color: t.grid } } }
    }
  });
}

function closeAgentTrend() {
  document.getElementById('agentTrendModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', loadHistory);
