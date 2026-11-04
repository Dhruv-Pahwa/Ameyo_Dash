/* ============================================
   PAST DATA + TRENDS - built from the nightly snapshots in history/
   ============================================ */

const HISTORY_DIR = 'history';
const HISTORY_MAX_DAYS = 30;

// status: idle | loading | ready | error. days: oldest first, one entry per saved day.
const trendState = { status: 'idle', error: '', days: [], preset: 15, from: null, to: null, agents: new Map(), agentDates: [] };

// agent(row) is a value for one merged agent row, day(stats) the team value for one day.
const TREND_METRICS = {
  ready:    { label: 'Avg ready time',     kind: 'dur', goodUp: true,  color: CHART_COLORS.ready, agent: r => readySecs(r),                                   day: s => s.avgReady },
  brk:      { label: 'Avg break time',     kind: 'dur', goodUp: false, color: CHART_COLORS.brk,   agent: r => timeToSeconds(r['Total Break Duration']),       day: s => s.avgBreak },
  breakPct: { label: 'Break % of staffed', kind: 'pct', goodUp: false, color: '#e11d48',          agent: r => pctOf(r['Total Break Duration'], r['Total Staffed Duration']), day: s => s.breakPct },
  talk:     { label: 'Avg talk time',      kind: 'dur', goodUp: true,  color: CHART_COLORS.talk,  agent: r => timeToSeconds(r['Total Talk Time in Interval']), day: s => s.avgTalk },
  staffed:  { label: 'Avg staffed time',   kind: 'dur', goodUp: true,  color: '#0891b2',          agent: r => timeToSeconds(r['Total Staffed Duration']),     day: s => s.avgStaffed },
  autoOn:   { label: 'Avg auto call-on',   kind: 'dur', goodUp: true,  color: CHART_COLORS.auto,  agent: r => timeToSeconds(r['Auto Call-On Duration']),      day: s => s.avgOn }
};
const AGENT_TREND_METRICS = ['ready', 'breakPct', 'talk', 'autoOn'];

function pctOf(part, whole) {
  const w = timeToSeconds(whole);
  return w > 0 ? timeToSeconds(part) / w * 100 : 0;
}

function dayLabel(iso) {
  const [, m, d] = iso.split('-');
  return `${+d} ${MONTHS[+m - 1]}`;
}

function fullDayLabel(iso) {
  const [y, m, d] = iso.split('-');
  return `${+d} ${MONTHS[+m - 1]} ${y}`;
}

function fmtTrend(kind, v) {
  if (v === null || v === undefined || isNaN(v)) return '—';
  return kind === 'pct' ? v.toFixed(1) + '%' : secondsToTime(Math.round(v));
}

// Hours as h:mm, small values (a minute or two of break per agent) as m:ss.
function fmtTrendAxis(kind, v) {
  if (kind === 'pct') return v.toFixed(v < 10 ? 1 : 0) + '%';
  if (v >= 3600) return fmtHM(v);
  return `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, '0')}`;
}

// Small-scale metrics start at zero so a flat line does not get a negative axis.
function trendYAxis(t, m, values) {
  const max = Math.max(0, ...values.filter(v => v !== null));
  const small = m.kind === 'pct' || max < 3600;
  return { beginAtZero: small, grace: small ? 0 : '10%', ticks: { color: t.text, callback: v => fmtTrendAxis(m.kind, v) }, grid: { color: t.grid } };
}

function mean(vals) {
  const v = vals.filter(x => x !== null && x !== undefined);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
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
    setTrendPreset(15, true);
  } catch (e) {
    trendState.days = [];
    trendState.status = 'error';
    trendState.error = location.protocol === 'file:'
      ? 'History loads only from the published site, not from a local file.'
      : 'No history saved yet. A snapshot is taken every night at 11 PM IST.';
  }
  syncHistoryPicker();
  if (state.view === 'trends') applyView();
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

// ---- Past data: the whole sheet of a saved day, shown like the live view ----
function histDay() {
  return state.histDate ? trendState.days.find(d => d.date === state.histDate) || null : null;
}

function syncHistoryPicker() {
  const sel = document.getElementById('historyDateSelect');
  if (!sel) return;
  sel.innerHTML = trendState.days.slice().reverse().map(d => `<option value="${d.date}">${fullDayLabel(d.date)}</option>`).join('');
  sel.value = state.histDate || '';
}

function setHistoryDate(date) {
  if (!date) { setView('live'); return; }
  state.histDate = date;
  state.pastPick = date;
  state.view = 'live';
  applyView();
}

// Past data button: the day picked last, or the newest saved day.
function openPastData() {
  const days = trendState.days;
  if (!days.length) {
    showToast(trendState.status === 'loading' ? 'History is still loading' : 'No past data saved yet');
    return;
  }
  setHistoryDate(state.pastPick && days.some(d => d.date === state.pastPick) ? state.pastPick : days[days.length - 1].date);
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

function dayStats(day, merged) {
  const agents = merged.filter(r => timeToSeconds(r['Total Staffed Duration']) > 0);
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

// ---- Trends view ----
// Last N saved days, ending on the newest one.
function setTrendPreset(n, quiet) {
  trendState.preset = n;
  const d = trendState.days;
  if (!d.length) return;
  trendState.to = d[d.length - 1].date;
  trendState.from = d[Math.max(0, d.length - n)].date;
  if (!quiet) applyFilters();
}

function renderTrends() {
  if (state.view !== 'trends') return;
  const note = document.getElementById('trendsNote');
  const body = document.getElementById('trendsBody');

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

  document.querySelectorAll('.trend-presets button').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.days === trendState.preset);
  });

  const merged = new Map(trendState.days.map(d => [d.date, mergeByAgent(d.rows.filter(trendFilter))]));
  const all = trendState.days.map(d => dayStats(d, merged.get(d.date)));
  const shown = all.filter(s => s.date >= trendState.from && s.date <= trendState.to);
  if (!shown.length) {
    body.style.display = 'none';
    note.textContent = 'No saved days between these dates.';
    return;
  }
  body.style.display = '';
  note.textContent = `${shown.length} saved day${shown.length !== 1 ? 's' : ''} in this range (${dayLabel(shown[0].date)} – ${dayLabel(shown[shown.length - 1].date)}). Filters above apply. One snapshot per day, taken at 11 PM IST.`;

  renderTrendCards(all, shown);
  renderTrendCharts(shown);
  renderTrendTable(shown);
  renderTrendAgents(shown, merged);
}

function renderTrendCards(all, shown) {
  const cur = shown.filter(s => s.n > 0);
  // Compared with the same number of saved days right before the range.
  const start = all.indexOf(shown[0]);
  const prev = all.slice(Math.max(0, start - shown.length), start).filter(s => s.n > 0);
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

function chartCard(id, title, sub, wide) {
  return `<div class="chart-card${wide ? ' chart-wide' : ''}"><h3 class="chart-title">${title}</h3><p class="chart-sub">${sub}</p>` +
    `<div class="chart-box"><canvas id="${id}"></canvas><p class="chart-empty" style="display:none">No data for these filters</p></div></div>`;
}

// The chart cards are the same every time, so they are written once.
function ensureTrendChartCards() {
  const box = document.getElementById('trendCharts');
  if (box.children.length) return;
  box.innerHTML =
    Object.entries(TREND_METRICS).map(([k, m]) => chartCard('chTr_' + k, m.label + ' per day', 'Team average for the agents left after the filters')).join('') +
    chartCard('chTrSplit', 'Ready vs break', 'Average staffed time per agent, split into ready and break') +
    chartCard('chTrAgents', 'Agents logged in', 'Agents with staffed time each day') +
    chartCard('chTrReasons', 'Break reasons per day', 'Average break time per agent, by reason', true);
}

function renderTrendCharts(shown) {
  ensureTrendChartCards();
  const t = trendChartDefaults();
  const labels = shown.map(s => dayLabel(s.date));
  const noData = shown.every(s => s.n === 0);
  const ids = [...Object.keys(TREND_METRICS).map(k => 'chTr_' + k), 'chTrSplit', 'chTrAgents', 'chTrReasons'];
  ids.forEach(id => setChartEmpty(id, noData));
  if (noData) return;

  const xScale = { ticks: { color: t.text }, grid: { display: false } };
  const yDur = { beginAtZero: true, ticks: { color: t.text, callback: v => fmtHM(v) }, grid: { color: t.grid } };

  Object.entries(TREND_METRICS).forEach(([k, m]) => {
    const values = shown.map(s => m.day(s));
    drawChart('chTr_' + k, {
      type: 'line',
      data: { labels, datasets: [{ label: m.label, data: values, borderColor: m.color, backgroundColor: m.color + '22', fill: true, tension: 0.25, spanGaps: true, pointRadius: 3 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtTrend(m.kind, c.parsed.y) } } },
        scales: { x: xScale, y: trendYAxis(t, m, values) }
      }
    });
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

// ---- Per-agent trends ----
function agentKey(r) {
  return (r['User ID'] || r['User Name'] || '').trim().toLowerCase();
}

// Small inline line. Green when the agent moved the right way over the range.
function sparkline(series, m, dates, key) {
  const pts = series.map((v, i) => ({ v, i })).filter(p => p.v !== null);
  if (pts.length < 2) return '<span class="break-none">—</span>';
  const w = 96, h = 26, pad = 3;
  const lo = Math.min(...pts.map(p => p.v)), hi = Math.max(...pts.map(p => p.v));
  const x = i => pad + i * (w - 2 * pad) / Math.max(1, series.length - 1);
  const y = v => (hi === lo ? h / 2 : h - pad - (v - lo) / (hi - lo) * (h - 2 * pad));
  const first = pts[0], end = pts[pts.length - 1];
  const color = (end.v >= first.v) === m.goodUp ? '#16a34a' : '#dc2626';
  const line = pts.map(p => `${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const tip = `${dayLabel(dates[first.i])}: ${fmtTrend(m.kind, first.v)} → ${dayLabel(dates[end.i])}: ${fmtTrend(m.kind, end.v)}`;
  return `<button class="spark-btn" title="${escapeHTML(tip)}" onclick="openAgentTrend('${escapeHTML(key)}')"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(end.i).toFixed(1)}" cy="${y(end.v).toFixed(1)}" r="2.4" fill="${color}"/></svg></button>`;
}

function renderTrendAgents(shown, merged) {
  const dates = shown.map(s => s.date);
  const agents = new Map();
  dates.forEach((date, i) => merged.get(date).forEach(r => {
    if (timeToSeconds(r['Total Staffed Duration']) <= 0) return;
    const key = agentKey(r);
    if (!agents.has(key)) agents.set(key, { key, name: r['User Name'] || key, lead: r._tl, type: r._type, rows: new Array(dates.length).fill(null) });
    agents.get(key).rows[i] = r;
  }));
  const list = [...agents.values()].sort((a, b) => b.rows.filter(Boolean).length - a.rows.filter(Boolean).length || a.name.localeCompare(b.name));
  trendState.agents = agents;
  trendState.agentDates = dates;

  document.getElementById('trendAgentHead').innerHTML =
    '<tr><th>#</th><th>Agent Name</th><th>Team Lead</th><th>Agent Type</th><th>Days logged in</th>' +
    AGENT_TREND_METRICS.map(k => `<th>${escapeHTML(TREND_METRICS[k].label.replace('Avg ', ''))}</th>`).join('') + '</tr>';
  document.getElementById('trendAgentCount').textContent = `${list.length} agent${list.length !== 1 ? 's' : ''}`;
  document.getElementById('trendAgentBody').innerHTML = list.map((a, i) => {
    const days = a.rows.filter(Boolean).length;
    return `<tr><td>${i + 1}</td><td>${escapeHTML(a.name)}</td><td>${a.lead ? escapeHTML(teamLeadName(a.lead)) : '—'}</td><td>${typeBadge(a.type)}</td><td>${days} of ${dates.length}</td>` +
      AGENT_TREND_METRICS.map(k => {
        const m = TREND_METRICS[k];
        const series = a.rows.map(r => (r ? m.agent(r) : null));
        return `<td class="spark-cell">${sparkline(series, m, dates, a.key)} <span class="spark-val">${fmtTrend(m.kind, mean(series))}</span></td>`;
      }).join('') + '</tr>';
  }).join('');
}

function openAgentTrend(key) {
  const a = trendState.agents.get(key);
  if (!a) return;
  const dates = trendState.agentDates;
  document.getElementById('agentTrendTitle').textContent = a.name;
  document.getElementById('agentTrendSub').textContent = `${dates.length} saved day${dates.length !== 1 ? 's' : ''} (${dayLabel(dates[0])} – ${dayLabel(dates[dates.length - 1])}). Days the agent was not logged in are left out of the charts.`;
  document.getElementById('agentTrendBody').innerHTML = dates.map((date, i) => {
    const r = a.rows[i];
    return r
      ? `<tr><td>${dayLabel(date)}</td><td class="dur-cell">${r['Total Staffed Duration']}</td><td class="dur-cell">${secToDur(readySecs(r))}</td><td class="dur-cell">${r['Total Break Duration']}</td><td class="dur-cell">${pctOf(r['Total Break Duration'], r['Total Staffed Duration']).toFixed(1)}%</td><td class="dur-cell">${r['Auto Call-On Duration']}</td><td class="dur-cell">${r['Total Talk Time in Interval'] || '00:00:00'}</td></tr>`
      : `<tr class="row-muted"><td>${dayLabel(date)}</td><td colspan="6" class="ad-note">Not logged in</td></tr>`;
  }).reverse().join('');
  document.getElementById('agentTrendModal').classList.add('open');
  if (typeof Chart === 'undefined') return;

  const t = trendChartDefaults();
  document.getElementById('agentTrendCharts').innerHTML = AGENT_TREND_METRICS.map(k =>
    `<div><h3 class="chart-title">${escapeHTML(TREND_METRICS[k].label)}</h3><div class="chart-box agent-trend-chart"><canvas id="chAg_${k}"></canvas></div></div>`).join('');
  AGENT_TREND_METRICS.forEach(k => {
    const m = TREND_METRICS[k];
    const values = a.rows.map(r => (r ? m.agent(r) : null));
    drawChart('chAg_' + k, {
      type: 'line',
      data: { labels: dates.map(dayLabel), datasets: [{ label: m.label, data: values, borderColor: m.color, backgroundColor: m.color + '22', fill: true, tension: 0.25, spanGaps: true, pointRadius: 3 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + fmtTrend(m.kind, c.parsed.y) } } },
        scales: { x: { ticks: { color: t.text }, grid: { display: false } }, y: trendYAxis(t, m, values) }
      }
    });
  });
}

function closeAgentTrend() {
  document.getElementById('agentTrendModal').classList.remove('open');
}

document.addEventListener('DOMContentLoaded', loadHistory);
