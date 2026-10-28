// ============ CHARTS TAB ============
// Charts follow the dashboard filters: they are drawn from state.filteredRows (one row per agent).

const chartState = { tab: 'table', charts: {} };

const CHART_COLORS = {
  ready: '#3b82f6',
  brk: '#f59e0b',
  talk: '#16a34a',
  auto: '#7c3aed',
  cat: ['#3b82f6', '#f59e0b', '#16a34a', '#7c3aed', '#e11d48', '#0891b2', '#84cc16', '#f97316', '#64748b']
};

function setMainTab(tab) {
  chartState.tab = tab;
  applyMainTab();
}

// Shows the Table or the Charts view. Called after every filter change.
function applyMainTab() {
  const tabs = document.getElementById('viewTabs');
  const wrap = document.getElementById('tableWrapper');
  const section = document.getElementById('chartsSection');
  if (!tabs || !wrap || !section) return;
  const charts = chartState.tab === 'charts';
  tabs.style.display = '';
  document.getElementById('tabTableBtn').classList.toggle('active', !charts);
  document.getElementById('tabChartsBtn').classList.toggle('active', charts);
  wrap.style.display = charts ? 'none' : '';
  section.style.display = charts ? '' : 'none';
  if (charts) renderCharts();
}

function readySecs(r) {
  return Math.max(0, timeToSeconds(r['Total Staffed Duration']) - timeToSeconds(r['Total Break Duration']));
}

function fmtHM(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

function themeColors() {
  const css = getComputedStyle(document.documentElement);
  return {
    text: css.getPropertyValue('--text-secondary').trim() || '#475569',
    grid: css.getPropertyValue('--border').trim() || '#e2e8f0',
    card: css.getPropertyValue('--bg-card').trim() || '#fff'
  };
}

function drawChart(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || typeof Chart === 'undefined') return;
  if (chartState.charts[id]) chartState.charts[id].destroy();
  chartState.charts[id] = new Chart(canvas, config);
}

// Shows a "no data" message instead of the chart.
function setChartEmpty(id, empty) {
  const canvas = document.getElementById(id);
  if (!canvas) return;
  canvas.style.display = empty ? 'none' : '';
  const msg = canvas.parentElement.querySelector('.chart-empty');
  if (msg) msg.style.display = empty ? '' : 'none';
  if (empty && chartState.charts[id]) { chartState.charts[id].destroy(); delete chartState.charts[id]; }
}

// Horizontal bar chart of agents ranked by a value in seconds.
function agentBar(id, items, color) {
  setChartEmpty(id, items.length === 0);
  if (!items.length) return;
  const t = themeColors();
  drawChart(id, {
    type: 'bar',
    data: { labels: items.map(i => i.name), datasets: [{ data: items.map(i => i.secs), backgroundColor: color, borderRadius: 4 }] },
    options: {
      indexAxis: 'y',
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + secondsToTime(c.parsed.x) } } },
      scales: {
        x: { ticks: { color: t.text, callback: v => fmtHM(v) }, grid: { color: t.grid } },
        y: { ticks: { color: t.text }, grid: { display: false } }
      }
    }
  });
}

function renderCharts() {
  if (chartState.tab !== 'charts') return;
  const section = document.getElementById('chartsSection');
  if (typeof Chart === 'undefined') {
    section.querySelector('.charts-note').textContent = 'Charts could not load (check your internet connection).';
    return;
  }
  const rows = state.filteredRows || [];
  section.querySelector('.charts-note').textContent =
    `${rows.length} agent${rows.length !== 1 ? 's' : ''} after filters. Ready time = staffed duration minus break duration.`;
  const t = themeColors();
  Chart.defaults.font.family = "'Inter', sans-serif";
  Chart.defaults.color = t.text;

  const N = 10;
  const withStaff = rows.filter(r => timeToSeconds(r['Total Staffed Duration']) > 0);
  const named = (r, secs) => ({ name: r['User Name'] || r['User ID'] || '—', secs });
  const ready = withStaff.map(r => named(r, readySecs(r)));
  const brk = withStaff.map(r => named(r, timeToSeconds(r['Total Break Duration'])));
  const talk = rows.map(r => named(r, timeToSeconds(r['Total Talk Time in Interval'])));

  agentBar('chHighReady', [...ready].sort((a, b) => b.secs - a.secs).slice(0, N), CHART_COLORS.ready);
  agentBar('chLowReady', [...ready].sort((a, b) => a.secs - b.secs).slice(0, N), CHART_COLORS.ready);
  agentBar('chHighBreak', [...brk].sort((a, b) => b.secs - a.secs).slice(0, N), CHART_COLORS.brk);
  agentBar('chLowBreak', brk.filter(i => i.secs > 0).sort((a, b) => a.secs - b.secs).slice(0, N), CHART_COLORS.brk);
  agentBar('chTopTalk', [...talk].sort((a, b) => b.secs - a.secs).slice(0, N), CHART_COLORS.talk);

  // Break reasons (only agents left after the filters).
  const bd = breakData();
  const ids = new Set(rows.map(r => (r['User ID'] || '').trim().toLowerCase()));
  const breakAgents = bd ? bd.agents.filter(a => ids.has(a.userId)) : [];
  const reasonSecs = {};
  breakAgents.forEach(a => {
    Object.entries(a.reasons).forEach(([k, v]) => { reasonSecs[k] = (reasonSecs[k] || 0) + v.secs; });
  });
  const reasons = Object.entries(reasonSecs).sort((a, b) => b[1] - a[1]);
  setChartEmpty('chReasons', reasons.length === 0);
  if (reasons.length) {
    drawChart('chReasons', {
      type: 'doughnut',
      data: { labels: reasons.map(r => r[0]), datasets: [{ data: reasons.map(r => r[1]), backgroundColor: reasons.map((_, i) => CHART_COLORS.cat[i % CHART_COLORS.cat.length]), borderColor: t.card, borderWidth: 2 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: t.text } }, tooltip: { callbacks: { label: c => ` ${c.label}: ${secondsToTime(c.parsed)}` } } } }
    });
  }

  // Auto call-on vs auto call-off (total across agents).
  const sum = f => rows.reduce((s, r) => s + timeToSeconds(r[f]), 0);
  const autoOn = sum('Auto Call-On Duration');
  const autoOff = sum('Auto Call-Off Duration');
  setChartEmpty('chAuto', autoOn + autoOff === 0);
  if (autoOn + autoOff > 0) {
    drawChart('chAuto', {
      type: 'pie',
      data: { labels: ['Auto call-on', 'Auto call-off'], datasets: [{ data: [autoOn, autoOff], backgroundColor: [CHART_COLORS.auto, '#94a3b8'], borderColor: t.card, borderWidth: 2 }] },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: t.text } }, tooltip: { callbacks: { label: c => ` ${c.label}: ${secondsToTime(c.parsed)}` } } } }
    });
  }

  // Histogram: how many agents fall in each staffed-hours bucket.
  const hours = withStaff.map(r => timeToSeconds(r['Total Staffed Duration']) / 3600);
  const maxH = Math.max(1, Math.ceil(Math.max(0, ...hours)));
  const bins = new Array(maxH).fill(0);
  hours.forEach(h => { bins[Math.min(maxH - 1, Math.floor(h))]++; });
  setChartEmpty('chHist', hours.length === 0);
  if (hours.length) {
    drawChart('chHist', {
      type: 'bar',
      data: { labels: bins.map((_, i) => `${i}-${i + 1}h`), datasets: [{ data: bins, backgroundColor: CHART_COLORS.ready, borderRadius: 4, categoryPercentage: 1, barPercentage: 0.95 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y} agent${c.parsed.y !== 1 ? 's' : ''}` } } },
        scales: { x: { ticks: { color: t.text }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: t.text, precision: 0 }, grid: { color: t.grid }, title: { display: true, text: 'Agents', color: t.text } } }
      }
    });
  }

  // Line: break minutes started in each hour of the latest day (the sheet can also hold the previous evening).
  const perHour = new Array(24).fill(0);
  const dayMs = ms => Math.floor(ms / 86400000);
  let latestDay = -Infinity;
  breakAgents.forEach(a => a.breaks.forEach(b => {
    const ms = parseSheetTime(b.start);
    if (ms !== Infinity) latestDay = Math.max(latestDay, dayMs(ms));
  }));
  breakAgents.forEach(a => a.breaks.forEach(b => {
    const ms = parseSheetTime(b.start);
    if (ms !== Infinity && dayMs(ms) === latestDay) perHour[new Date(ms).getUTCHours()] += b.secs / 60;
  }));
  document.getElementById('chHourlySub').textContent = latestDay === -Infinity
    ? 'Line: break minutes started per hour'
    : `Line: break minutes started per hour on ${new Date(latestDay * 86400000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  const first = perHour.findIndex(v => v > 0);
  const last = perHour.length - 1 - [...perHour].reverse().findIndex(v => v > 0);
  setChartEmpty('chHourly', first === -1);
  if (first !== -1) {
    const labels = [], data = [];
    for (let h = first; h <= last; h++) { labels.push(`${String(h).padStart(2, '0')}:00`); data.push(Math.round(perHour[h])); }
    drawChart('chHourly', {
      type: 'line',
      data: { labels, datasets: [{ data, borderColor: CHART_COLORS.brk, backgroundColor: 'rgba(245,158,11,0.15)', fill: true, tension: 0.3, pointRadius: 3 }] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.parsed.y} min on break` } } },
        scales: { x: { ticks: { color: t.text }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: t.text }, grid: { color: t.grid }, title: { display: true, text: 'Break minutes', color: t.text } } }
      }
    });
  }

  // Average ready / break / talk per team lead.
  const byLead = new Map();
  rows.forEach(r => {
    const k = r._tl ? teamLeadName(r._tl) : 'Not listed';
    if (!byLead.has(k)) byLead.set(k, { n: 0, ready: 0, brk: 0, talk: 0 });
    const g = byLead.get(k);
    g.n++;
    g.ready += readySecs(r);
    g.brk += timeToSeconds(r['Total Break Duration']);
    g.talk += timeToSeconds(r['Total Talk Time in Interval']);
  });
  const leads = [...byLead.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
  setChartEmpty('chLeads', leads.length === 0);
  if (leads.length) {
    const ds = (label, key, color) => ({ label, data: leads.map(([, g]) => Math.round(g[key] / g.n)), backgroundColor: color, borderRadius: 3 });
    drawChart('chLeads', {
      type: 'bar',
      data: { labels: leads.map(([k]) => k), datasets: [ds('Avg ready', 'ready', CHART_COLORS.ready), ds('Avg break', 'brk', CHART_COLORS.brk), ds('Avg talk', 'talk', CHART_COLORS.talk)] },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: t.text } }, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${secondsToTime(c.parsed.y)}` } } },
        scales: { x: { ticks: { color: t.text }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: t.text, callback: v => fmtHM(v) }, grid: { color: t.grid } } }
      }
    });
  }
}
