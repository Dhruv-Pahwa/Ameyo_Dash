/* ============================================
   AMEYO AGENT PERFORMANCE DASHBOARD - APP.JS
   ============================================ */

const SHEET_CSV_URL = 'https://docs.google.com/spreadsheets/d/1ZU0r6Mr0WVz-AD65Jn3uPHsnnCO9ssDepIupeFmOwsA/export?format=csv';
const BREAK_SHEET_URL = 'https://docs.google.com/spreadsheets/d/17ortJZIjY3O08iVyW_nryiiOQlo6K0ielPSpL1oKtf8/export?format=csv';
const SHEET_REFRESH_MS = 5 * 60 * 1000;

const state = {
  dataSets: [],
  allRows: [],
  filteredRows: [],
  campaigns: [],
  selectedCampaigns: new Set(),
  dates: [],
  selectedDates: new Set(),
  sortCol: null,
  sortDir: 'asc',
  hasUserUploads: false,
  uploadSets: [],
  uploadDays: [],       // one entry per uploaded day: { label, set, breakData }
  uploadDayIndex: 0,    // which uploaded day tab is active
  sheetSet: null,
  sheetText: '',
  sheetUpdated: null,
  breakText: '',
  liveBreak: null,
  uploadBreak: null,
  breakAgents: [],
  breakReasons: [],
  breakTotals: {},
  breakSearch: '',
  breakFiltered: [],
  agentType: { main: '', break: '' }, // '' = all, otherwise 'Direct' | 'DDA' | 'none' (not in the list)
  leads: { main: { all: [], selected: new Set() }, break: { all: [], selected: new Set() } },
  view: 'live' // 'live' (Google Sheet: productivity + breaks) | 'upload'
};

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupDragDrop();
  updateSourceBar(); // tabs are usable right away, even while the sheet is still loading
  loadBundledFiles();
  document.addEventListener('click', (e) => {
    const cms = document.getElementById('campaignMultiselect');
    const dms = document.getElementById('dateMultiselect');
    if (cms && !cms.contains(e.target)) closeCampaignMultiselect();
    if (dms && !dms.contains(e.target)) closeDateMultiselect();
    closeLeadMultis(e.target.closest('.lead-multi'));
  });
});

async function loadBundledFiles() {
  await Promise.all([loadSheet(), loadBreakSheet()]);
  // The sheet can finish loading after the user has already uploaded files: keep showing those.
  if (state.view === 'live' || !state.uploadDays.length) state.view = 'live';
  applyView();
  setInterval(refreshSheet, SHEET_REFRESH_MS);
}

// fetch() that gives up after 15s, so a slow or blocked sheet cannot keep the page loading forever.
function fetchWithTimeout(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  return fetch(url, { cache: 'no-store', signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ---- Google Sheet source (live data) ----
// Returns true when the sheet content changed since the last load.
async function loadSheet() {
  try {
    const resp = await fetchWithTimeout(`${SHEET_CSV_URL}&t=${Date.now()}`);
    if (!resp.ok) return false;
    const text = await resp.text();
    if (text === state.sheetText) { state.sheetUpdated = new Date(); return false; }
    const rows = extractAgentRows(text);
    state.sheetText = text;
    state.sheetUpdated = new Date();
    state.sheetSet = rows.length
      ? { fileName: 'Google Sheet', dateLabel: 'Google Sheet', rows, isBundled: false }
      : null;
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Break breakdown (Google Sheet of ready/break segments) ----
async function loadBreakSheet() {
  try {
    const resp = await fetchWithTimeout(`${BREAK_SHEET_URL}&t=${Date.now()}`);
    if (!resp.ok) return false;
    const text = await resp.text();
    if (text === state.breakText) return false;
    state.breakText = text;
    state.liveBreak = summarizeBreaks(parseCSV(text).rows);
    return true;
  } catch (e) {
    return false;
  }
}

// One row per agent with total break time and time/count per break reason.
// The export has one row per auto-call on/off interval, repeated once per campaign, so rows are
// folded into ready segments (same ready start/end) and each break is counted once.
function summarizeBreaks(rows) {
  const users = new Map();
  rows.forEach(r => {
    const user = r['Username'];
    if (!user) return;
    if (!users.has(user)) users.set(user, { userId: r['User ID'], segs: new Map(), autos: new Map() });
    const u = users.get(user);
    const segKey = r['Ready Start Time'] + '|' + r['Ready End Time'];
    if (!u.segs.has(segKey)) u.segs.set(segKey, { rs: r['Ready Start Time'], re: r['Ready End Time'], be: '', reason: 'Unspecified', ready: durToSec(r['Ready Duration']), brk: 0 });
    const g = u.segs.get(segKey);
    const brk = durToSec(r['Break Duration']);
    // The same break can differ by a second between campaigns: keep the longest.
    if (r['Break End Time'] && brk > g.brk) {
      g.be = r['Break End Time'];
      g.brk = brk;
      g.reason = r['Break Reason'] || 'Unspecified';
    }
    const onStart = parseSheetTime(r['Auto Call-On Start Time']);
    if (onStart === Infinity) return;
    const onEnd = parseSheetTime(r['Auto Call-On End Time']);
    let offEnd = parseSheetTime(r['Auto Call-Off End Time']);
    if (offEnd === Infinity) offEnd = onEnd + durToSec(r['Auto Call-Off Duration']) * 1000;
    u.autos.set([onStart, onEnd, offEnd].join('|'), { onStart, onEnd, offEnd });
  });

  const agents = [];
  const totals = {};
  users.forEach((u, user) => {
    const segments = [...u.segs.values()];
    const autos = [...u.autos.values()];
    // Auto call-on/off time counts only while the agent was ready: the intervals are clipped to the
    // ready segment (an auto-off interval keeps running through the break that follows).
    const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)) / 1000;
    segments.forEach(g => {
      const rs = parseSheetTime(g.rs);
      const re = parseSheetTime(g.re);
      g.on = 0;
      g.off = 0;
      if (rs === Infinity || re === Infinity) return;
      autos.forEach(a => {
        g.on += overlap(a.onStart, a.onEnd, rs, re);
        g.off += overlap(a.onEnd, a.offEnd, rs, re);
      });
      g.on = Math.round(g.on);
      g.off = Math.round(g.off);
    });
    const a = { user, userId: (u.userId || '').trim().toLowerCase(), lead: leadEmailFor(u.userId), type: agentTypeFor(u.userId), total: 0, reasons: {}, breaks: [] };
    segments.filter(g => g.brk > 0).forEach(g => {
      a.total += g.brk;
      if (!a.reasons[g.reason]) a.reasons[g.reason] = { secs: 0, count: 0 };
      a.reasons[g.reason].secs += g.brk;
      a.reasons[g.reason].count++;
      a.breaks.push({ reason: g.reason, start: g.re, end: g.be, secs: g.brk });
      if (!totals[g.reason]) totals[g.reason] = { secs: 0, count: 0, agents: new Set() };
      totals[g.reason].secs += g.brk;
      totals[g.reason].count++;
      totals[g.reason].agents.add(user);
    });
    if (!a.total) return;
    a.breaks.sort((x, y) => parseSheetTime(x.start) - parseSheetTime(y.start));
    a.timeline = buildTimeline(segments);
    agents.push(a);
  });
  const reasons = Object.keys(totals).sort((a, b) => {
    if (a === 'Unspecified') return 1;
    if (b === 'Unspecified') return -1;
    return totals[b].secs - totals[a].secs;
  });
  return { agents: agents.sort((a, b) => b.total - a.total), totals, reasons };
}

// Ready / break / gap events in time order. A "gap" is time that is neither ready nor on a break
// (e.g. logged out), so a ready stretch between two breaks shows up with its auto-dial time.
function buildTimeline(segments) {
  const segs = segments.filter(g => parseSheetTime(g.rs) !== Infinity);
  segs.sort((x, y) => parseSheetTime(x.rs) - parseSheetTime(y.rs));
  const ev = [];
  let prevEnd = null;
  segs.forEach(g => {
    const rs = parseSheetTime(g.rs);
    const re = parseSheetTime(g.re);
    if (prevEnd !== null && rs - prevEnd > 5000) ev.push({ kind: 'gap', start: prevEnd, end: rs, secs: Math.round((rs - prevEnd) / 1000) });
    if (g.ready > 0) ev.push({ kind: 'ready', start: rs, end: re, secs: g.ready, on: g.on, off: g.off });
    const be = parseSheetTime(g.be);
    if (g.brk > 0) ev.push({ kind: 'break', start: re, end: be !== Infinity ? be : re + g.brk * 1000, secs: g.brk, reason: g.reason });
    prevEnd = Math.max(re, be !== Infinity ? be : re);
  });
  return ev;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function clockOnly(ms) {
  return new Date(ms).toISOString().substr(11, 8);
}
function dayOnly(ms) {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Makes one break data set (live sheet or an uploaded file) the one the break view shows.
function activateBreak(data) {
  const d = data || { agents: [], totals: {}, reasons: [] };
  state.breakAgents = d.agents;
  state.breakTotals = d.totals;
  state.breakReasons = d.reasons;
  populateLeadMulti('break', d.agents.map(a => a.lead));
}

// ---- Team lead helpers ----
function leadEmailFor(userId) {
  return TEAM_LEAD_BY_USER[(userId || '').trim().toLowerCase()] || '';
}

// Team lead multiselect. `key` is 'main' or 'break'; options are only the leads present in `emails`.
const LEAD_UI = {
  main: { box: 'mainLeadMulti', onChange: () => applyFilters() },
  break: { box: 'breakLeadMulti', onChange: () => renderBreakView() }
};

function populateLeadMulti(key, emails) {
  const st = state.leads[key];
  const wasAll = st.selected.size === st.all.length;
  const leads = [...new Set(emails.filter(Boolean))];
  const names = leads.map(teamLeadName);
  st.all = leads
    .map((e, i) => ({ email: e, label: names.filter(n => n === names[i]).length > 1 ? `${names[i]} (${e})` : names[i] }))
    .sort((x, y) => x.label.localeCompare(y.label));
  st.selected = wasAll ? new Set(st.all.map(o => o.email)) : new Set(st.all.map(o => o.email).filter(e => st.selected.has(e)));
  renderLeadMulti(key);
}

function renderLeadMulti(key) {
  const st = state.leads[key];
  const box = document.getElementById(LEAD_UI[key].box);
  const wasOpen = box.querySelector('.multiselect-dropdown.open') !== null;
  box.classList.add('lead-multi');
  box.innerHTML = `
    <div class="multiselect-toggle"><span></span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </div>
    <div class="multiselect-dropdown${wasOpen ? ' open' : ''}">
      <label class="multiselect-item multiselect-all"><input type="checkbox" class="lead-all"><span>Select All</span></label>
      <div class="lead-options"></div>
    </div>`;
  const toggle = box.querySelector('.multiselect-toggle');
  const dropdown = box.querySelector('.multiselect-dropdown');
  const allCb = box.querySelector('.lead-all');
  const list = box.querySelector('.lead-options');
  toggle.classList.toggle('open', wasOpen);
  toggle.addEventListener('click', () => {
    const open = !dropdown.classList.contains('open');
    closeLeadMultis();
    dropdown.classList.toggle('open', open);
    toggle.classList.toggle('open', open);
  });
  st.all.forEach(o => {
    const label = document.createElement('label');
    label.className = 'multiselect-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = st.selected.has(o.email);
    cb.addEventListener('change', () => {
      if (cb.checked) st.selected.add(o.email); else st.selected.delete(o.email);
      updateLeadMultiText(key);
      LEAD_UI[key].onChange();
    });
    const span = document.createElement('span');
    span.textContent = o.label;
    label.appendChild(cb);
    label.appendChild(span);
    list.appendChild(label);
  });
  allCb.addEventListener('change', () => {
    st.selected = allCb.checked ? new Set(st.all.map(o => o.email)) : new Set();
    list.querySelectorAll('input').forEach(cb => { cb.checked = allCb.checked; });
    updateLeadMultiText(key);
    LEAD_UI[key].onChange();
  });
  updateLeadMultiText(key);
}

function updateLeadMultiText(key) {
  const st = state.leads[key];
  const box = document.getElementById(LEAD_UI[key].box);
  const total = st.all.length;
  const n = st.selected.size;
  box.querySelector('.lead-all').checked = total > 0 && n === total;
  let text;
  if (total === 0 || n === total) text = 'All Team Leads';
  else if (n === 0) text = 'No Team Leads';
  else if (n <= 2) text = st.all.filter(o => st.selected.has(o.email)).map(o => o.label).join(', ');
  else text = `${n} of ${total} Team Leads`;
  box.querySelector('.multiselect-toggle span').textContent = text;
}

function closeLeadMultis(except) {
  document.querySelectorAll('.lead-multi').forEach(box => {
    if (box === except) return;
    box.querySelector('.multiselect-dropdown').classList.remove('open');
    box.querySelector('.multiselect-toggle').classList.remove('open');
  });
}

function setAgentType(key, value) {
  state.agentType[key] = value;
  if (key === 'main') applyFilters(); else renderBreakView();
}

// Break data that goes with the productivity table being shown (live sheet or uploaded break file).
function breakData() {
  return state.view === 'live' ? state.liveBreak : state.uploadBreak;
}

function breakAgentFor(userId) {
  const d = breakData();
  const id = (userId || '').trim().toLowerCase();
  return d && id ? d.agents.find(x => x.userId === id) : null;
}

function typeKey(type) {
  return type || 'none';
}

function typeBadge(type) {
  return type ? `<span class="type-badge type-${type.toLowerCase()}">${escapeHTML(type)}</span>` : '—';
}

// An agent passes when every lead is selected, or when their own lead is selected.
function leadPasses(key, email) {
  const st = state.leads[key];
  if (st.selected.size === st.all.length) return true;
  return !!email && st.selected.has(email);
}

// "17/10/2026 10:03:57" (or with AM/PM) -> sortable number; unparseable values sort last.
function parseSheetTime(str) {
  const m = (str || '').match(/(\d+)\/(\d+)\/(\d+)\s+(\d+):(\d+):(\d+)\s*([AP]M)?/i);
  if (!m) return Infinity;
  let h = +m[4] % 12 + (m[7] && m[7].toUpperCase() === 'PM' ? 12 : 0);
  if (!m[7]) h = +m[4];
  return Date.UTC(+m[3], +m[2] - 1, +m[1], h, +m[5], +m[6]);
}

function timeOnly(str) {
  const m = (str || '').match(/\d+:\d+:\d+(\s*[AP]M)?/i);
  return m ? m[0] : '—';
}

function openBreakDetail(i) {
  openBreakAgent(state.breakFiltered[i]);
}

// Break details of one agent, found by login id (used from the productivity table).
function openBreakDetailFor(userId) {
  const d = breakData();
  openBreakAgent(d && d.agents.find(x => x.userId === userId));
}

function openBreakAgent(a) {
  if (!a) return;
  const modal = document.getElementById('breakModal');
  document.getElementById('breakModalTitle').textContent = a.user;
  document.getElementById('breakModalSub').textContent = (a.lead ? `Team Lead: ${teamLeadName(a.lead)}` : 'Team Lead: —') + (a.type ? ` · ${a.type}` : '');
  const reasons = state.breakReasons.filter(r => a.reasons[r]);
  const ready = (a.timeline || []).filter(e => e.kind === 'ready');
  const readySecs = ready.reduce((n, e) => n + e.secs, 0);
  const onSecs = ready.reduce((n, e) => n + e.on, 0);
  const offSecs = ready.reduce((n, e) => n + e.off, 0);
  document.getElementById('breakModalCards').innerHTML =
    `<div class="card"><span class="card-label">TOTAL BREAK</span><span class="card-value">${secToDur(a.total)}</span><span class="card-sub">${a.breaks.length} break${a.breaks.length === 1 ? '' : 's'}</span></div>` +
    `<div class="card"><span class="card-label">READY TIME</span><span class="card-value">${secToDur(readySecs)}</span><span class="card-sub">${ready.length} stretch${ready.length === 1 ? '' : 'es'} between breaks</span></div>` +
    `<div class="card"><span class="card-label">AUTO CALL-ON</span><span class="card-value">${secToDur(onSecs)}</span><span class="card-sub">total while ready</span></div>` +
    `<div class="card"><span class="card-label">AUTO CALL-OFF</span><span class="card-value">${secToDur(offSecs)}</span><span class="card-sub">total while ready</span></div>` +
    reasons.map(r => `<div class="card"><span class="card-label">${escapeHTML(r.toUpperCase())}</span><span class="card-value">${secToDur(a.reasons[r].secs)}</span><span class="card-sub">${a.reasons[r].count} time${a.reasons[r].count === 1 ? '' : 's'}</span></div>`).join('');
  let day = '';
  document.getElementById('breakModalBody').innerHTML = (a.timeline || []).map((e, n) => {
    // A date row whenever the day changes, so sessions on different days are not mixed up.
    let dateRow = '';
    if (dayOnly(e.start) !== day) {
      day = dayOnly(e.start);
      dateRow = `<tr class="row-date"><td colspan="6">${day}</td></tr>`;
    }
    const time = e.kind === 'gap' && dayOnly(e.end) !== day
      ? `${clockOnly(e.start)} – ${dayOnly(e.end)} ${clockOnly(e.end)}`
      : `${clockOnly(e.start)} – ${clockOnly(e.end)}`;
    const head = `<td>${n + 1}</td><td class="dur-cell">${time}</td>`;
    if (e.kind === 'gap') return dateRow + `<tr class="row-muted">${head}<td><span class="act act-gap">Not ready</span></td><td class="dur-cell">${secToDur(e.secs)}</td><td colspan="2" class="ad-note">No ready or break activity recorded</td></tr>`;
    if (e.kind === 'break') return dateRow + `<tr class="row-break">${head}<td><span class="act act-break">Break</span> ${escapeHTML(e.reason)}</td><td class="dur-cell">${secToDur(e.secs)}</td><td colspan="2" class="ad-note">On break</td></tr>`;
    return dateRow + `<tr>${head}<td><span class="act act-ready">Ready</span></td><td class="dur-cell">${secToDur(e.secs)}</td><td class="dur-cell ad-on-t">${secToDur(e.on)}</td><td class="dur-cell ad-off-t">${secToDur(e.off)}</td></tr>`;
  }).join('');
  modal.classList.add('open');
}

// Talk time of one agent split by campaign (the table shows the total across campaigns).
function openTalkDetail(i) {
  const a = state.filteredRows[i];
  if (!a) return;
  const rows = (a._rows || []).map(r => ({
    campaign: r['Campaign Name'] || '—',
    total: timeToSeconds(r['Total Talk Time in Interval']),
    manual: timeToSeconds(r['Manual Calls Talk Time']),
    auto: Math.max(0, timeToSeconds(r['Total Talk Time in Interval']) - timeToSeconds(r['Manual Calls Talk Time']))
  })).sort((x, y) => y.total - x.total || x.campaign.localeCompare(y.campaign));
  const total = rows.reduce((n, r) => n + r.total, 0);
  const manual = rows.reduce((n, r) => n + r.manual, 0);
  const auto = rows.reduce((n, r) => n + r.auto, 0);
  const active = rows.filter(r => r.total > 0).length;
  document.getElementById('talkModalTitle').textContent = a['User Name'] || '—';
  document.getElementById('talkModalSub').textContent = (a._tl ? `Team Lead: ${teamLeadName(a._tl)}` : 'Team Lead: —') + (a._type ? ` · ${a._type}` : '');
  document.getElementById('talkModalCards').innerHTML =
    `<div class="card"><span class="card-label">TOTAL TALK TIME</span><span class="card-value">${secToDur(total)}</span><span class="card-sub">across ${rows.length} campaign${rows.length === 1 ? '' : 's'}</span></div>` +
    `<div class="card"><span class="card-label">MANUAL TALK TIME</span><span class="card-value">${secToDur(manual)}</span><span class="card-sub">part of the total</span></div>` +
    `<div class="card"><span class="card-label">TALK TIME IN AUTO DIAL</span><span class="card-value">${secToDur(auto)}</span><span class="card-sub">total minus manual</span></div>` +
    `<div class="card"><span class="card-label">CAMPAIGNS WITH TALK</span><span class="card-value">${active}</span><span class="card-sub">of ${rows.length}</span></div>`;
  document.getElementById('talkModalBody').innerHTML = rows.map((r, n) =>
    `<tr${r.total ? '' : ' class="row-muted"'}><td>${n + 1}</td><td>${escapeHTML(r.campaign)}</td><td class="dur-cell">${secToDur(r.total)}</td><td class="dur-cell">${secToDur(r.manual)}</td><td class="dur-cell">${secToDur(r.auto)}</td></tr>`
  ).join('');
  document.getElementById('talkModal').classList.add('open');
}

function closeTalkDetail() {
  document.getElementById('talkModal').classList.remove('open');
}

function closeBreakDetail() {
  document.getElementById('breakModal').classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeBreakDetail(); closeTalkDetail(); } });

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Live view: shown below the productivity table. Uploaded break file: shown on its own.
function renderBreakView() {
  if (state.view !== 'live') {
    ['filtersBar', 'exportBar', 'summaryCards', 'tableWrapper'].forEach(id => {
      document.getElementById(id).style.display = 'none';
    });
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('dropZone').classList.add('hidden');
  }
  document.getElementById('breakSection').style.display = '';
  if (!state.breakAgents.length) {
    document.getElementById('breakCards').innerHTML = '';
    document.getElementById('breakHead').innerHTML = '';
    document.getElementById('breakBody').innerHTML = '<tr><td style="padding:24px;text-align:center">No break data available in the Google Sheet yet.</td></tr>';
    document.getElementById('breakCount').textContent = '';
    state.breakFiltered = [];
    return;
  }

  const q = state.breakSearch.trim().toLowerCase();
  const agents = state.breakAgents.filter(a =>
    (!q || a.user.toLowerCase().includes(q)) && leadPasses('break', a.lead) &&
    (!state.agentType.break || typeKey(a.type) === state.agentType.break));
  state.breakFiltered = agents;
  const all = state.breakAgents.reduce((n, a) => n + a.total, 0);

  document.getElementById('breakCards').innerHTML =
    `<div class="card"><span class="card-label">TOTAL BREAK TIME</span><span class="card-value">${secToDur(all)}</span><span class="card-sub">${state.breakAgents.length} agents</span></div>` +
    state.breakReasons.map(r => {
      const t = state.breakTotals[r];
      return `<div class="card"><span class="card-label">${escapeHTML(r.toUpperCase())}</span><span class="card-value">${secToDur(t.secs)}</span><span class="card-sub">${t.count} break${t.count === 1 ? '' : 's'} · ${t.agents.size} agent${t.agents.size === 1 ? '' : 's'}</span></div>`;
    }).join('');

  document.getElementById('breakHead').innerHTML =
    '<tr><th>#</th><th>Agent Name</th><th>Team Lead</th><th>Agent Type</th><th>Total Break Duration</th>' +
    state.breakReasons.map(r => `<th>${escapeHTML(r)}</th>`).join('') + '</tr>';

  document.getElementById('breakBody').innerHTML = agents.map((a, i) =>
    `<tr><td>${i + 1}</td><td>${escapeHTML(a.user)}</td><td>${a.lead ? escapeHTML(teamLeadName(a.lead)) : '—'}</td><td>${typeBadge(a.type)}</td><td class="dur-cell">${secToDur(a.total)} <button class="info-btn" title="View break details" onclick="openBreakDetail(${i})">i</button></td>` +
    state.breakReasons.map(r => {
      const x = a.reasons[r];
      return x ? `<td class="dur-cell">${secToDur(x.secs)} <span class="break-count">(${x.count}×)</span></td>` : '<td class="dur-cell break-none">—</td>';
    }).join('') + '</tr>'
  ).join('');
  document.getElementById('breakCount').textContent = `${agents.length} agents`;
}

function breakExportTable() {
  const headers = ['#', 'Agent Name', 'Team Lead', 'Agent Type', 'Total Break Duration'];
  state.breakReasons.forEach(r => headers.push(`${r} Duration`, `${r} Count`));
  const rows = state.breakFiltered.map((a, i) => {
    const row = [i + 1, a.user, a.lead ? teamLeadName(a.lead) : '', a.type, secToDur(a.total)];
    state.breakReasons.forEach(r => {
      const x = a.reasons[r];
      row.push(x ? secToDur(x.secs) : '00:00:00', x ? x.count : 0);
    });
    return row;
  });
  return { headers, rows };
}

function exportBreakCSV() {
  if (!state.breakFiltered.length) { showToast('No data to export'); return; }
  const { headers, rows } = breakExportTable();
  const q = v => `"${String(v).replace(/"/g, '""')}"`;
  const csv = [headers.map(q).join(','), ...rows.map(r => r.map(q).join(','))].join('\n');
  downloadFile(csv, 'ameyo_break_report.csv', 'text/csv');
  showToast('CSV exported successfully');
}

function exportBreakExcel() {
  if (!state.breakFiltered.length) { showToast('No data to export'); return; }
  const { headers, rows } = breakExportTable();
  let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
  html += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Break Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>';
  html += '<body><table border="1">';
  html += '<tr>' + headers.map(h => `<th style="background:#2563eb;color:#fff;font-weight:bold;padding:8px">${escapeHTML(h)}</th>`).join('') + '</tr>';
  rows.forEach(r => { html += '<tr>' + r.map(v => `<td>${escapeHTML(v)}</td>`).join('') + '</tr>'; });
  html += '</table></body></html>';
  downloadFile(html, 'ameyo_break_report.xls', 'application/vnd.ms-excel');
  showToast('Excel exported successfully');
}

function filterBreaks(value) {
  state.breakSearch = value;
  renderBreakView();
}

async function refreshSheet(manual) {
  const [changed, breakChanged] = await Promise.all([loadSheet(), loadBreakSheet()]);
  if (state.view === 'live' && (changed || breakChanged)) applyView();
  updateSourceBar();
  if (manual === true) showToast(changed || breakChanged ? 'Data updated' : 'Data is up to date');
}

function showEmpty(message, showDrop) {
  document.getElementById('breakSection').style.display = 'none';
  ['filtersBar', 'exportBar', 'summaryCards', 'tableWrapper'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('loadingSpinner').style.display = 'none';
  document.getElementById('emptyIcon').style.display = '';
  document.getElementById('emptyMessage').textContent = message;
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('dropZone').classList.toggle('hidden', !showDrop);
}

function applyView() {
  // Uploaded break file with no productivity file: show the break table on its own.
  const breakOnly = state.view === 'upload' && !state.uploadSets.length && state.uploadBreak;
  if (!breakOnly) document.getElementById('breakSection').style.display = 'none';
  if (breakOnly) {
    activateBreak(state.uploadBreak);
    renderBreakView();
  } else if (state.view === 'live') {
    if (state.sheetSet) {
      state.dataSets = [state.sheetSet];
      mergeAndRender();
    } else {
      state.dataSets = [];
      showEmpty('No live data available in the Google Sheet yet.', false);
    }
  } else if (state.uploadSets.length > 0) {
    state.dataSets = state.uploadSets;
    mergeAndRender();
  } else {
    state.dataSets = [];
    showEmpty('Data not uploaded', true);
  }
  updateSourceBar();
}

function setView(view) {
  if (view === 'upload') {
    // No uploaded days yet: ask for files. Otherwise show the day that was last active.
    if (!state.uploadDays.length) { openUploadModal(); return; }
    setUploadDay(state.uploadDayIndex < state.uploadDays.length ? state.uploadDayIndex : 0);
    return;
  }
  if (state.view === view) return;
  state.view = view;
  applyView();
}

function updateSourceBar() {
  const bar = document.getElementById('sourceBar');
  if (!bar) return;
  const v = state.view;
  const day = state.uploadDays[state.uploadDayIndex];
  document.getElementById('sourceText').textContent = v === 'live'
    ? 'Showing live data from Google Sheet'
    : (day ? `Showing uploaded data · ${day.label}` : 'Showing uploaded data');
  document.getElementById('viewLiveBtn').classList.toggle('active', v === 'live');

  // One tab per uploaded day, between the Live tab and the Upload button.
  const tabs = document.getElementById('uploadTabs');
  if (tabs) {
    tabs.innerHTML = state.uploadDays.map((d, i) =>
      `<button class="btn-source${v === 'upload' && i === state.uploadDayIndex ? ' active' : ''}" onclick="setUploadDay(${i})">${escapeHTML(d.label)}</button>`
    ).join('');
  }
  bar.style.display = '';
}

// ---- CSV Parsing ----
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return { headers: [], rows: [] };
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',');
    if (vals.length < headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h.trim()] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return { headers, rows };
}

function extractDateLabel(fileName) {
  const match = fileName.match(/(\d+)\s*(?:th|st|nd|rd)?\s*[_\-]?\s*(oct|nov|sep|dec|jan|feb|mar|apr|may|jun|jul|aug)/i);
  if (match) {
    const day = match[1];
    const month = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();
    const fullMonth = { Oct: 'October', Nov: 'November', Sep: 'September', Dec: 'December', Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June', Jul: 'July', Aug: 'August' };
    return `${day}${getOrdinal(parseInt(day))} ${fullMonth[month] || month}`;
  }
  return fileName.replace('.csv', '');
}

// A day label used to group uploaded files. Handles the Ameyo "2026-10-28" filename style
// (so a day's productivity file and break file land in the same tab) and falls back to the
// "28th Oct" style, then to the file name.
function fileDateLabel(fileName) {
  const iso = fileName.match(/(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})/);
  if (iso) {
    const y = iso[1], mo = +iso[2], d = +iso[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) return `${d} ${MONTHS[mo - 1]} ${y}`;
  }
  return extractDateLabel(fileName);
}

function getOrdinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

function extractDayNumber(dateLabel) {
  const m = dateLabel.match(/^(\d+)/);
  return m ? parseInt(m[1]) : 999;
}

function durToSec(t) {
  const p = (t || '').split(':').map(Number);
  if (p.length !== 3 || p.some(isNaN)) return 0;
  return p[0] * 3600 + p[1] * 60 + p[2];
}

function secToDur(s) {
  const pad = n => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s % 3600 / 60))}:${pad(s % 60)}`;
}

// Session-level export (one row per ready/break/auto-call segment) -> per agent + campaign summary rows.
// Staffed = Auto Call-On + Auto Call-Off; this export has no manual talk time, so it is reported as 00:00:00.
function summarizeSessionRows(rows) {
  const agg = new Map();
  const seenBreaks = new Set();
  rows.forEach(r => {
    const user = r['Username'];
    const campaign = r['Campaign Name'];
    if (!user || !campaign) return;
    const key = user + '\u0000' + campaign;
    if (!agg.has(key)) agg.set(key, { campaign, user, userId: r['User ID'] || '', on: 0, off: 0, brk: 0 });
    const a = agg.get(key);
    a.on += durToSec(r['Auto Call-On Duration']);
    a.off += durToSec(r['Auto Call-Off Duration']);
    const breakKey = [key, r['Ready Start Time'], r['Break End Time'], r['Break Duration']].join('|');
    if (!seenBreaks.has(breakKey)) {
      seenBreaks.add(breakKey);
      a.brk += durToSec(r['Break Duration']);
    }
  });
  return [...agg.values()].map(a => ({
    'Campaign Name': a.campaign,
    'User Name': a.user,
    'User ID': a.userId,
    'Total Staffed Duration': secToDur(a.on + a.off),
    'Auto Call-On Duration': secToDur(a.on),
    'Auto Call-Off Duration': secToDur(a.off),
    'Total Talk Time in Interval': '00:00:00',
    'Manual Calls Talk Time': '00:00:00',
    'Talk Time in Auto Dial': '00:00:00',
    'Total Break Duration': secToDur(a.brk)
  }));
}

function extractAgentRows(text) {
  const { headers, rows } = parseCSV(text);
  const isSessionReport = headers.some(h => h.trim() === 'Username') && !headers.some(h => h.trim() === 'User Name');
  return isSessionReport ? summarizeSessionRows(rows) : rows.filter(r => {
    const pn = r['Process Name'] || '';
    const un = r['User Name'] || '';
    return pn !== 'Campaign Summary' && un !== '';
  });
}

function processCSV(text, fileName, dateLabel, isBundled) {
  const agentRows = extractAgentRows(text);
  const existingIdx = state.dataSets.findIndex(d => d.fileName === fileName);
  if (existingIdx >= 0) {
    state.dataSets[existingIdx] = { fileName, dateLabel, rows: agentRows, isBundled };
  } else {
    state.dataSets.push({ fileName, dateLabel, rows: agentRows, isBundled });
  }
}

// ---- Merge datasets and render ----
function mergeAndRender() {
  state.allRows = [];
  state.hasUserUploads = state.dataSets.some(ds => !ds.isBundled);

  state.dataSets.forEach(ds => {
    ds.rows.forEach(r => {
      state.allRows.push({ ...r, _date: ds.isBundled ? ds.dateLabel : null, _tl: leadEmailFor(r['User ID']), _type: agentTypeFor(r['User ID']) });
    });
  });

  const campaignSet = new Set();
  const dateSet = new Set();
  state.allRows.forEach(r => {
    if (r['Campaign Name']) campaignSet.add(r['Campaign Name']);
    if (r._date) dateSet.add(r._date);
  });
  state.campaigns = [...campaignSet].sort();
  state.dates = [...dateSet].sort((a, b) => extractDayNumber(a) - extractDayNumber(b));

  state.selectedCampaigns = new Set(state.campaigns);
  state.selectedDates = new Set(state.dates);

  populateCampaignMultiselect();
  populateDateMultiselect();
  updateDateVisibility();
  populateLeadMulti('main', state.allRows.map(r => r._tl));

  document.getElementById('filtersBar').style.display = '';
  document.getElementById('exportBar').style.display = '';
  document.getElementById('summaryCards').style.display = '';
  document.getElementById('tableWrapper').style.display = '';
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('dropZone').classList.add('hidden');

  applyFilters();
  showToast(`Loaded ${state.dataSets.length} file(s) — ${state.allRows.length} agent records`);
}

function updateDateVisibility() {
  const showDates = !state.hasUserUploads && state.dates.length > 0;
  document.getElementById('dateFilterGroup').style.display = showDates ? '' : 'none';
  document.getElementById('dateColumnHeader').style.display = showDates ? '' : 'none';
}

// ---- Multi-select Campaign Filter ----
function populateCampaignMultiselect() {
  const container = document.getElementById('campaignOptions');
  container.innerHTML = '';

  state.campaigns.forEach(c => {
    const label = document.createElement('label');
    label.className = 'multiselect-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = c;
    cb.checked = state.selectedCampaigns.has(c);
    cb.addEventListener('change', () => {
      if (cb.checked) { state.selectedCampaigns.add(c); }
      else { state.selectedCampaigns.delete(c); }
      syncCampaignSelectAll();
      updateCampaignToggleText();
      applyFilters();
    });
    const span = document.createElement('span');
    span.textContent = c;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });

  syncCampaignSelectAll();
  updateCampaignToggleText();
}

function toggleMultiselect() {
  const toggle = document.getElementById('campaignToggle');
  const dropdown = document.getElementById('campaignDropdown');
  if (dropdown.classList.contains('open')) {
    closeCampaignMultiselect();
  } else {
    closeDateMultiselect();
    toggle.classList.add('open');
    dropdown.classList.add('open');
  }
}

function closeCampaignMultiselect() {
  document.getElementById('campaignToggle').classList.remove('open');
  document.getElementById('campaignDropdown').classList.remove('open');
}

function toggleAllCampaigns(checked) {
  state.campaigns.forEach(c => {
    if (checked) { state.selectedCampaigns.add(c); }
    else { state.selectedCampaigns.delete(c); }
  });
  document.querySelectorAll('#campaignOptions input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
  updateCampaignToggleText();
  applyFilters();
}

function syncCampaignSelectAll() {
  document.getElementById('campaignSelectAll').checked = state.selectedCampaigns.size === state.campaigns.length;
}

function updateCampaignToggleText() {
  const el = document.getElementById('campaignToggleText');
  const total = state.campaigns.length;
  const selected = state.selectedCampaigns.size;
  if (selected === 0) el.textContent = 'No Campaigns';
  else if (selected === total) el.textContent = 'All Campaigns';
  else if (selected <= 2) el.textContent = [...state.selectedCampaigns].join(', ');
  else el.textContent = `${selected} of ${total} Campaigns`;
}

// ---- Multi-select Date Filter ----
function populateDateMultiselect() {
  const container = document.getElementById('dateOptions');
  container.innerHTML = '';

  state.dates.forEach(d => {
    const label = document.createElement('label');
    label.className = 'multiselect-item';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = d;
    cb.checked = state.selectedDates.has(d);
    cb.addEventListener('change', () => {
      if (cb.checked) { state.selectedDates.add(d); }
      else { state.selectedDates.delete(d); }
      syncDateSelectAll();
      updateDateToggleText();
      applyFilters();
    });
    const span = document.createElement('span');
    span.textContent = d;
    label.appendChild(cb);
    label.appendChild(span);
    container.appendChild(label);
  });

  syncDateSelectAll();
  updateDateToggleText();
}

function toggleDateMultiselect() {
  const toggle = document.getElementById('dateToggle');
  const dropdown = document.getElementById('dateDropdown');
  if (dropdown.classList.contains('open')) {
    closeDateMultiselect();
  } else {
    closeCampaignMultiselect();
    toggle.classList.add('open');
    dropdown.classList.add('open');
  }
}

function closeDateMultiselect() {
  document.getElementById('dateToggle').classList.remove('open');
  document.getElementById('dateDropdown').classList.remove('open');
}

function toggleAllDates(checked) {
  state.dates.forEach(d => {
    if (checked) { state.selectedDates.add(d); }
    else { state.selectedDates.delete(d); }
  });
  document.querySelectorAll('#dateOptions input[type="checkbox"]').forEach(cb => { cb.checked = checked; });
  updateDateToggleText();
  applyFilters();
}

function syncDateSelectAll() {
  document.getElementById('dateSelectAll').checked = state.selectedDates.size === state.dates.length;
}

function updateDateToggleText() {
  const el = document.getElementById('dateToggleText');
  const total = state.dates.length;
  const selected = state.selectedDates.size;
  if (selected === 0) el.textContent = 'No Dates';
  else if (selected === total) el.textContent = 'All Dates';
  else if (selected <= 2) el.textContent = [...state.selectedDates].join(', ');
  else el.textContent = `${selected} of ${total} Dates`;
}

// ---- Filters ----
function applyFilters() {
  const search = document.getElementById('searchEmployee').value.toLowerCase().trim();
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const matched = state.allRows.filter(r => {
    if (state.selectedCampaigns.size === 0) return false;
    if (!state.selectedCampaigns.has(r['Campaign Name'])) return false;
    if (showDates) {
      if (state.selectedDates.size === 0) return false;
      if (r._date && !state.selectedDates.has(r._date)) return false;
    }
    if (!leadPasses('main', r._tl)) return false;
    if (state.agentType.main && typeKey(r._type) !== state.agentType.main) return false;
    if (search && !(r['User Name'] || '').toLowerCase().includes(search)) return false;
    return true;
  });

  state.filteredRows = mergeByAgent(matched);
  renderSummary();
  renderTable();
}

// One row per agent (and date): campaigns are listed together instead of repeating the agent.
// Session times (staffed, auto call on/off, break) are the same in every campaign row, so the
// largest value is used; manual talk time belongs to each campaign's calls, so it is added up.
function mergeByAgent(rows) {
  const TALK = ['Total Talk Time in Interval', 'Manual Calls Talk Time'];
  const SESSION = ['Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Total Break Duration'];
  const groups = new Map();
  rows.forEach(r => {
    const key = ((r['User ID'] || r['User Name'] || '') + '|' + (r._date || '')).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { ...r, _campaigns: [], _rows: [], _talk: {}, _session: {} });
      TALK.forEach(f => { groups.get(key)._talk[f] = 0; });
      SESSION.forEach(f => { groups.get(key)._session[f] = 0; });
    }
    const g = groups.get(key);
    g._rows.push(r);
    if (r['Campaign Name'] && !g._campaigns.includes(r['Campaign Name'])) g._campaigns.push(r['Campaign Name']);
    TALK.forEach(f => { g._talk[f] += timeToSeconds(r[f]); });
    SESSION.forEach(f => { g._session[f] = Math.max(g._session[f], timeToSeconds(r[f])); });
  });
  return [...groups.values()].map(g => {
    g._campaigns.sort();
    g['Campaign Name'] = g._campaigns.join(', ');
    TALK.forEach(f => { g[f] = secToDur(g._talk[f]); });
    g['Talk Time in Auto Dial'] = secToDur(Math.max(0, g._talk['Total Talk Time in Interval'] - g._talk['Manual Calls Talk Time']));
    SESSION.forEach(f => { g[f] = secToDur(g._session[f]); });
    return g;
  });
}

// ---- Summary Cards ----
function renderSummary() {
  const rows = state.filteredRows;
  const n = rows.length;

  if (n === 0) {
    ['cardStaffed', 'cardAutoOn', 'cardAutoOff', 'cardTalk', 'cardManual', 'cardBreak'].forEach(id => {
      document.getElementById(id).textContent = '0:00:00';
    });
    return;
  }

  const avgTime = (field) => {
    let totalSec = 0;
    rows.forEach(r => { totalSec += timeToSeconds(r[field]); });
    return secondsToTime(Math.round(totalSec / n));
  };

  document.getElementById('cardStaffed').textContent = avgTime('Total Staffed Duration');
  document.getElementById('cardAutoOn').textContent = avgTime('Auto Call-On Duration');
  document.getElementById('cardAutoOff').textContent = avgTime('Auto Call-Off Duration');
  document.getElementById('cardTalk').textContent = avgTime('Total Talk Time in Interval');
  document.getElementById('cardManual').textContent = avgTime('Manual Calls Talk Time');
  document.getElementById('cardBreak').textContent = avgTime('Total Break Duration');
}

// ---- Table Rendering ----
function renderTable() {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const bd = breakData();
  const reasons = bd ? bd.reasons : [];
  syncBreakHeaders(reasons);

  const rows = state.filteredRows;
  document.getElementById('tableCount').textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><div class="campaign-stack">${(r._campaigns && r._campaigns.length ? r._campaigns : [r['Campaign Name'] || '—']).map(c => `<span class="campaign-badge">${escapeHTML(c)}</span>`).join('')}</div></td>
      <td>${r['User Name'] || '—'}</td>
      <td>${r._tl ? teamLeadName(r._tl) : '—'}</td>
      <td>${typeBadge(r._type)}</td>
      <td class="dur-cell">${r['Total Staffed Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Auto Call-On Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Auto Call-Off Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Total Talk Time in Interval'] || '00:00:00'} <button class="info-btn" title="Talk time by campaign" onclick="openTalkDetail(${i})">i</button></td>
      <td class="dur-cell">${r['Manual Calls Talk Time'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Talk Time in Auto Dial'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Total Break Duration'] || '00:00:00'}${breakAgentFor(r['User ID']) ? ` <button class="info-btn" title="Break timeline" onclick="openBreakDetailFor('${escapeHTML((r['User ID'] || '').trim().toLowerCase())}')">i</button>` : ''}</td>
      ${breakReasonCells(r, reasons)}
      ${showDates ? `<td><span class="date-badge">${r._date || '—'}</span></td>` : ''}
    `;
    tbody.appendChild(tr);
  });
}

// One column per break reason, right after Total Break Duration.
function syncBreakHeaders(reasons) {
  const row = document.querySelector('#dataTable thead tr');
  row.querySelectorAll('th.break-extra').forEach(th => th.remove());
  const before = document.getElementById('dateColumnHeader');
  reasons.forEach(reason => {
    const th = document.createElement('th');
    th.className = 'break-extra';
    th.innerHTML = `<span>${escapeHTML(reason)}</span>`;
    row.insertBefore(th, before);
  });
}

function breakReasonCells(r, reasons) {
  const a = breakAgentFor(r['User ID']);
  return reasons.map(reason => {
    const x = a && a.reasons[reason];
    return x ? `<td class="dur-cell">${secToDur(x.secs)} <span class="break-count">(${x.count}×)</span></td>` : '<td class="dur-cell break-none">—</td>';
  }).join('');
}

// ---- Sorting ----
function sortTable(colIdx) {
  const colMap = {
    0: '_idx',
    1: 'Campaign Name',
    2: 'User Name',
    3: 'Total Staffed Duration',
    4: 'Auto Call-On Duration',
    5: 'Auto Call-Off Duration',
    6: 'Total Talk Time in Interval',
    7: 'Manual Calls Talk Time',
    8: 'Talk Time in Auto Dial',
    9: 'Total Break Duration'
  };

  const key = colMap[colIdx];
  if (!key) return;

  if (state.sortCol === colIdx) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortCol = colIdx;
    state.sortDir = 'asc';
  }

  const isTime = colIdx >= 3 && colIdx <= 9;
  const dir = state.sortDir === 'asc' ? 1 : -1;

  state.filteredRows.sort((a, b) => {
    let va, vb;
    if (isTime) {
      va = timeToSeconds(a[key]);
      vb = timeToSeconds(b[key]);
    } else {
      va = (a[key] || '').toLowerCase();
      vb = (b[key] || '').toLowerCase();
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });

  document.querySelectorAll('.th-sortable').forEach((th, i) => {
    th.classList.remove('th-sorted-asc', 'th-sorted-desc');
    if (i === colIdx) {
      th.classList.add(state.sortDir === 'asc' ? 'th-sorted-asc' : 'th-sorted-desc');
    }
  });

  renderTable();
}

// ---- File Upload & Drag/Drop ----
function openUploadModal() {
  ['prodFileInput', 'breakFileInput'].forEach(id => { document.getElementById(id).value = ''; });
  updateUploadModal();
  document.getElementById('uploadModal').style.display = 'flex';
}

function closeUploadModal() {
  document.getElementById('uploadModal').style.display = 'none';
}

// Upload is enabled as soon as at least one of the two inputs has a file.
function updateUploadModal() {
  const count = ['prodFileInput', 'breakFileInput']
    .reduce((n, id) => n + document.getElementById(id).files.length, 0);
  document.getElementById('uploadSubmitBtn').disabled = count === 0;
}

function submitUploadModal() {
  const files = [];
  ['prodFileInput', 'breakFileInput'].forEach(id => files.push(...document.getElementById(id).files));
  if (!files.length) return;
  closeUploadModal();
  processUploadedFiles(files);
}

// Read a File as text, returning a Promise (replaces bare FileReader callbacks).
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('read error'));
    reader.readAsText(file);
  });
}

// Break exports list one row per break (they have a "Break Reason" column).
let pendingBreakRows = [];
function isBreakFile(text) {
  const first = (text.split('\n', 1)[0] || '').replace('\uFEFF', '').replace('\r', '');
  return first.split(',').map(h => h.trim()).includes('Break Reason');
}

async function processUploadedFiles(files) {
  // Group the uploaded files by day (date in the file name). Each day becomes its own tab.
  const days = new Map(); // label -> { label, prodRows: [], breakRows: [] }
  const dayFor = label => {
    if (!days.has(label)) days.set(label, { label, prodRows: [], breakRows: [] });
    return days.get(label);
  };

  for (const file of Array.from(files)) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      showToast(`Skipped "${file.name}" \u2014 only CSV files are supported`);
      continue;
    }
    try {
      const text = await readFileAsText(file);
      const day = dayFor(fileDateLabel(file.name));
      if (isBreakFile(text)) {
        day.breakRows.push(...parseCSV(text).rows);
      } else {
        day.prodRows.push(...extractAgentRows(text));
      }
    } catch (err) {
      showToast(`Could not read "${file.name}"`);
    }
  }

  // Turn each day into a dataset + break summary.
  state.uploadDays = [...days.values()].map(d => ({
    label: d.label,
    set: d.prodRows.length ? { fileName: d.label, dateLabel: d.label, rows: d.prodRows, isBundled: false } : null,
    breakData: d.breakRows.length ? safeSummarizeBreaks(d.breakRows) : null
  })).filter(d => d.set || d.breakData);

  if (!state.uploadDays.length) {
    showToast('No usable data found in the uploaded files');
    return;
  }

  setUploadDay(0);
  showToast(`Loaded ${state.uploadDays.length} day${state.uploadDays.length === 1 ? '' : 's'} of uploaded data`);
}

function safeSummarizeBreaks(rows) {
  try { return summarizeBreaks(rows); }
  catch (err) { console.error(err); return null; }
}

// Show one uploaded day's dashboard. uploadSets/uploadBreak point at the active day,
// so the existing applyView / breakData logic works unchanged.
function setUploadDay(i) {
  if (i < 0 || i >= state.uploadDays.length) return;
  state.uploadDayIndex = i;
  const day = state.uploadDays[i];
  state.uploadSets = day.set ? [day.set] : [];
  state.uploadBreak = day.breakData;
  state.view = 'upload';
  applyView();
}

function setupDragDrop() {
  const dropZone = document.getElementById('dropZone');
  const body = document.body;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
    body.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
    dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); });
  });

  body.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
  body.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  body.addEventListener('drop', (e) => {
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) processUploadedFiles(e.dataTransfer.files);
  });

  dropZone.addEventListener('dragover', () => dropZone.classList.add('drag-over'));
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    dropZone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) processUploadedFiles(e.dataTransfer.files);
  });

  dropZone.addEventListener('click', openUploadModal);
}

// ---- Export ----
function exportCSV() {
  if (state.filteredRows.length === 0) { showToast('No data to export'); return; }
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Team Lead', 'Agent Type', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Total Talk Time in Interval', 'Manual Calls Talk Time', 'Talk Time in Auto Dial', 'Total Break Duration'];
  const exReasons = (breakData() || { reasons: [] }).reasons;
  exReasons.forEach(x => headers.push(`${x} Duration`, `${x} Count`));
  if (showDates) headers.push('Date');
  const csvRows = [headers.join(',')];

  state.filteredRows.forEach((r, i) => {
    const row = [
      i + 1,
      `"${(r._campaigns || [r['Campaign Name'] || '']).join(', ')}"`,
      `"${r['User Name'] || ''}"`,
      `"${r._tl ? teamLeadName(r._tl) : ''}"`,
      r._type,
      r['Total Staffed Duration'] || '00:00:00',
      r['Auto Call-On Duration'] || '00:00:00',
      r['Auto Call-Off Duration'] || '00:00:00',
      r['Total Talk Time in Interval'] || '00:00:00',
      r['Manual Calls Talk Time'] || '00:00:00',
      r['Talk Time in Auto Dial'] || '00:00:00',
      r['Total Break Duration'] || '00:00:00'
    ];
    const ba = breakAgentFor(r['User ID']);
    exReasons.forEach(x => row.push(ba && ba.reasons[x] ? secToDur(ba.reasons[x].secs) : '00:00:00', ba && ba.reasons[x] ? ba.reasons[x].count : 0));
    if (showDates) row.push(r._date || '');
    csvRows.push(row.join(','));
  });

  downloadFile(csvRows.join('\n'), 'ameyo_agent_report.csv', 'text/csv');
  showToast('CSV exported successfully');
}

function exportExcel() {
  if (state.filteredRows.length === 0) { showToast('No data to export'); return; }
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Team Lead', 'Agent Type', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Total Talk Time in Interval', 'Manual Calls Talk Time', 'Talk Time in Auto Dial', 'Total Break Duration'];
  const exReasons = (breakData() || { reasons: [] }).reasons;
  exReasons.forEach(x => headers.push(`${x} Duration`, `${x} Count`));
  if (showDates) headers.push('Date');

  let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
  html += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Agent Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>';
  html += '<body><table border="1">';
  html += '<tr>' + headers.map(h => `<th style="background:#2563eb;color:#fff;font-weight:bold;padding:8px">${h}</th>`).join('') + '</tr>';

  state.filteredRows.forEach((r, i) => {
    html += '<tr>';
    html += `<td>${i + 1}</td>`;
    html += `<td>${(r._campaigns || [r['Campaign Name'] || '']).map(escapeHTML).join('<br style="mso-data-placement:same-cell;">')}</td>`;
    html += `<td>${r['User Name'] || ''}</td>`;
    html += `<td>${r._tl ? teamLeadName(r._tl) : ''}</td>`;
    html += `<td>${r._type}</td>`;
    html += `<td>${r['Total Staffed Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Auto Call-On Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Auto Call-Off Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Total Talk Time in Interval'] || '00:00:00'}</td>`;
    html += `<td>${r['Manual Calls Talk Time'] || '00:00:00'}</td>`;
    html += `<td>${r['Talk Time in Auto Dial'] || '00:00:00'}</td>`;
    html += `<td>${r['Total Break Duration'] || '00:00:00'}</td>`;
    const ba = breakAgentFor(r['User ID']);
    exReasons.forEach(x => { html += `<td>${ba && ba.reasons[x] ? secToDur(ba.reasons[x].secs) : '00:00:00'}</td><td>${ba && ba.reasons[x] ? ba.reasons[x].count : 0}</td>`; });
    if (showDates) html += `<td>${r._date || ''}</td>`;
    html += '</tr>';
  });

  html += '</table></body></html>';
  downloadFile(html, 'ameyo_agent_report.xls', 'application/vnd.ms-excel');
  showToast('Excel exported successfully');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType + ';charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

// ---- Utilities ----
function timeToSeconds(str) {
  if (!str || str === '') return 0;
  const parts = str.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

function secondsToTime(totalSec) {
  if (totalSec <= 0) return '0:00:00';
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function showToast(msg) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
