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
  sheetSet: null,
  sheetText: '',
  sheetUpdated: null,
  breakText: '',
  breakAgents: [],
  breakReasons: [],
  breakTotals: {},
  breakSearch: '',
  breakFiltered: [],
  leads: { main: { all: [], selected: new Set() }, break: { all: [], selected: new Set() } },
  view: 'live' // 'live' (Google Sheet) | 'upload' | 'break'
};

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  setupDragDrop();
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
  state.view = 'live';
  applyView();
  setInterval(refreshSheet, SHEET_REFRESH_MS);
}

// ---- Google Sheet source (live data) ----
// Returns true when the sheet content changed since the last load.
async function loadSheet() {
  try {
    const resp = await fetch(`${SHEET_CSV_URL}&t=${Date.now()}`, { cache: 'no-store' });
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
    const resp = await fetch(`${BREAK_SHEET_URL}&t=${Date.now()}`, { cache: 'no-store' });
    if (!resp.ok) return false;
    const text = await resp.text();
    if (text === state.breakText) return false;
    state.breakText = text;
    summarizeBreaks(text);
    return true;
  } catch (e) {
    return false;
  }
}

// One row per agent with total break time and time/count per break reason.
// The export repeats each break once per campaign, so identical breaks are counted once.
function summarizeBreaks(text) {
  const { rows } = parseCSV(text);
  const seen = new Set();
  const agents = new Map();
  const totals = {};
  rows.forEach(r => {
    const user = r['Username'];
    if (!user) return;
    const secs = durToSec(r['Break Duration']);
    if (!secs) return;
    const key = [user, r['Ready Start Time'], r['Break End Time'], r['Break Duration']].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    const reason = r['Break Reason'] || 'Unspecified';
    if (!agents.has(user)) agents.set(user, { user, lead: leadEmailFor(r['User ID']), total: 0, reasons: {}, breaks: [] });
    const a = agents.get(user);
    a.total += secs;
    if (!a.reasons[reason]) a.reasons[reason] = { secs: 0, count: 0 };
    a.reasons[reason].secs += secs;
    a.reasons[reason].count++;
    a.breaks.push({ reason, start: r['Ready End Time'], end: r['Break End Time'], secs });
    if (!totals[reason]) totals[reason] = { secs: 0, count: 0, agents: new Set() };
    totals[reason].secs += secs;
    totals[reason].count++;
    totals[reason].agents.add(user);
  });
  agents.forEach(a => a.breaks.sort((x, y) => parseSheetTime(x.start) - parseSheetTime(y.start)));
  state.breakAgents = [...agents.values()].sort((a, b) => b.total - a.total);
  state.breakTotals = totals;
  populateLeadMulti('break', state.breakAgents.map(a => a.lead));
  state.breakReasons = Object.keys(totals).sort((a, b) => {
    if (a === 'Unspecified') return 1;
    if (b === 'Unspecified') return -1;
    return totals[b].secs - totals[a].secs;
  });
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
  const a = state.breakFiltered[i];
  if (!a) return;
  const modal = document.getElementById('breakModal');
  document.getElementById('breakModalTitle').textContent = a.user;
  document.getElementById('breakModalSub').textContent = a.lead ? `Team Lead: ${teamLeadName(a.lead)}` : 'Team Lead: —';
  const reasons = state.breakReasons.filter(r => a.reasons[r]);
  document.getElementById('breakModalCards').innerHTML =
    `<div class="card"><span class="card-label">TOTAL BREAK</span><span class="card-value">${secToDur(a.total)}</span><span class="card-sub">${a.breaks.length} break${a.breaks.length === 1 ? '' : 's'}</span></div>` +
    reasons.map(r => `<div class="card"><span class="card-label">${escapeHTML(r.toUpperCase())}</span><span class="card-value">${secToDur(a.reasons[r].secs)}</span><span class="card-sub">${a.reasons[r].count} time${a.reasons[r].count === 1 ? '' : 's'}</span></div>`).join('');
  document.getElementById('breakModalBody').innerHTML = a.breaks.map((b, n) =>
    `<tr><td>${n + 1}</td><td>${escapeHTML(b.reason)}</td><td class="dur-cell">${escapeHTML(timeOnly(b.start))}</td><td class="dur-cell">${escapeHTML(timeOnly(b.end))}</td><td class="dur-cell">${secToDur(b.secs)}</td></tr>`
  ).join('');
  modal.classList.add('open');
}

function closeBreakDetail() {
  document.getElementById('breakModal').classList.remove('open');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBreakDetail(); });

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderBreakView() {
  ['filtersBar', 'exportBar', 'summaryCards', 'tableWrapper'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('dropZone').classList.add('hidden');
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
    (!q || a.user.toLowerCase().includes(q)) && leadPasses('break', a.lead));
  state.breakFiltered = agents;
  const all = state.breakAgents.reduce((n, a) => n + a.total, 0);

  document.getElementById('breakCards').innerHTML =
    `<div class="card"><span class="card-label">TOTAL BREAK TIME</span><span class="card-value">${secToDur(all)}</span><span class="card-sub">${state.breakAgents.length} agents</span></div>` +
    state.breakReasons.map(r => {
      const t = state.breakTotals[r];
      return `<div class="card"><span class="card-label">${escapeHTML(r.toUpperCase())}</span><span class="card-value">${secToDur(t.secs)}</span><span class="card-sub">${t.count} break${t.count === 1 ? '' : 's'} · ${t.agents.size} agent${t.agents.size === 1 ? '' : 's'}</span></div>`;
    }).join('');

  document.getElementById('breakHead').innerHTML =
    '<tr><th>#</th><th>Agent Name</th><th>Team Lead</th><th>Total Break Duration</th>' +
    state.breakReasons.map(r => `<th>${escapeHTML(r)}</th>`).join('') + '</tr>';

  document.getElementById('breakBody').innerHTML = agents.map((a, i) =>
    `<tr><td>${i + 1}</td><td>${escapeHTML(a.user)}</td><td>${a.lead ? escapeHTML(teamLeadName(a.lead)) : '—'}</td><td class="dur-cell">${secToDur(a.total)} <button class="info-btn" title="View break details" onclick="openBreakDetail(${i})">i</button></td>` +
    state.breakReasons.map(r => {
      const x = a.reasons[r];
      return x ? `<td class="dur-cell">${secToDur(x.secs)} <span class="break-count">(${x.count}×)</span></td>` : '<td class="dur-cell break-none">—</td>';
    }).join('') + '</tr>'
  ).join('');
  document.getElementById('breakCount').textContent = `${agents.length} agents`;
}

function breakExportTable() {
  const headers = ['#', 'Agent Name', 'Team Lead', 'Total Break Duration'];
  state.breakReasons.forEach(r => headers.push(`${r} Duration`, `${r} Count`));
  const rows = state.breakFiltered.map((a, i) => {
    const row = [i + 1, a.user, a.lead ? teamLeadName(a.lead) : '', secToDur(a.total)];
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
  if ((state.view === 'live' && changed) || (state.view === 'break' && breakChanged)) applyView();
  updateSourceBar();
  if (manual === true) showToast(changed || breakChanged ? 'Data updated' : 'Data is up to date');
}

function showEmpty(message, showDrop) {
  document.getElementById('breakSection').style.display = 'none';
  ['filtersBar', 'exportBar', 'summaryCards', 'tableWrapper'].forEach(id => {
    document.getElementById(id).style.display = 'none';
  });
  document.getElementById('emptyMessage').textContent = message;
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('dropZone').classList.toggle('hidden', !showDrop);
}

function applyView() {
  if (state.view !== 'break') document.getElementById('breakSection').style.display = 'none';
  if (state.view === 'break') {
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
  if (state.view === view) return;
  state.view = view;
  applyView();
}

function updateSourceBar() {
  const bar = document.getElementById('sourceBar');
  if (!bar) return;
  const time = state.sheetUpdated ? state.sheetUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const v = state.view;
  document.getElementById('sourceText').textContent = v === 'live'
    ? `Showing live data from Google Sheet${time ? ' · updated ' + time : ''}`
    : v === 'break'
      ? `Showing break breakdown from Google Sheet${time ? ' · updated ' + time : ''}`
      : (state.uploadSets.length ? 'Showing uploaded data' : 'Showing uploaded data · nothing uploaded yet');
  document.getElementById('viewLiveBtn').classList.toggle('active', v === 'live');
  document.getElementById('viewBreakBtn').classList.toggle('active', v === 'break');
  document.getElementById('viewUploadBtn').classList.toggle('active', v === 'upload');
  document.getElementById('sourceRefreshBtn').style.display = v === 'upload' ? 'none' : '';
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
    'Manual Calls Talk Time': '00:00:00',
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
      state.allRows.push({ ...r, _date: ds.isBundled ? ds.dateLabel : null, _tl: leadEmailFor(r['User ID']) });
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
  const SESSION = ['Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Total Break Duration'];
  const groups = new Map();
  rows.forEach(r => {
    const key = ((r['User ID'] || r['User Name'] || '') + '|' + (r._date || '')).toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { ...r, _campaigns: [], _manual: 0, _session: {} });
      SESSION.forEach(f => { groups.get(key)._session[f] = 0; });
    }
    const g = groups.get(key);
    if (r['Campaign Name'] && !g._campaigns.includes(r['Campaign Name'])) g._campaigns.push(r['Campaign Name']);
    g._manual += timeToSeconds(r['Manual Calls Talk Time']);
    SESSION.forEach(f => { g._session[f] = Math.max(g._session[f], timeToSeconds(r[f])); });
  });
  return [...groups.values()].map(g => {
    g._campaigns.sort();
    g['Campaign Name'] = g._campaigns.join(', ');
    g['Manual Calls Talk Time'] = secToDur(g._manual);
    SESSION.forEach(f => { g[f] = secToDur(g._session[f]); });
    return g;
  });
}

// ---- Summary Cards ----
function renderSummary() {
  const rows = state.filteredRows;
  const n = rows.length;

  if (n === 0) {
    ['cardStaffed', 'cardAutoOn', 'cardAutoOff', 'cardManual', 'cardBreak'].forEach(id => {
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
  document.getElementById('cardManual').textContent = avgTime('Manual Calls Talk Time');
  document.getElementById('cardBreak').textContent = avgTime('Total Break Duration');
}

// ---- Table Rendering ----
function renderTable() {
  const tbody = document.getElementById('tableBody');
  tbody.innerHTML = '';
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const rows = state.filteredRows;
  document.getElementById('tableCount').textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;

  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td><div class="campaign-stack">${(r._campaigns && r._campaigns.length ? r._campaigns : [r['Campaign Name'] || '—']).map(c => `<span class="campaign-badge">${escapeHTML(c)}</span>`).join('')}</div></td>
      <td>${r['User Name'] || '—'}</td>
      <td>${r._tl ? teamLeadName(r._tl) : '—'}</td>
      <td class="dur-cell">${r['Total Staffed Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Auto Call-On Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Auto Call-Off Duration'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Manual Calls Talk Time'] || '00:00:00'}</td>
      <td class="dur-cell">${r['Total Break Duration'] || '00:00:00'}</td>
      ${showDates ? `<td><span class="date-badge">${r._date || '—'}</span></td>` : ''}
    `;
    tbody.appendChild(tr);
  });
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
    6: 'Manual Calls Talk Time',
    7: 'Total Break Duration'
  };

  const key = colMap[colIdx];
  if (!key) return;

  if (state.sortCol === colIdx) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortCol = colIdx;
    state.sortDir = 'asc';
  }

  const isTime = colIdx >= 3 && colIdx <= 7;
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
function handleFileUpload(event) {
  const files = event.target.files;
  if (!files.length) return;
  processUploadedFiles(files);
  event.target.value = '';
}

function finishUpload() {
  state.uploadSets = [...state.dataSets];
  state.view = 'upload';
  applyView();
}

function processUploadedFiles(files) {
  // User is uploading their own files — clear bundled data and replace
  state.dataSets = [];
  let processed = 0;
  const total = files.length;

  Array.from(files).forEach(file => {
    if (!file.name.endsWith('.csv')) {
      showToast(`Skipped "${file.name}" — only CSV files are supported`);
      processed++;
      if (processed === total) finishUpload();
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const dateLabel = extractDateLabel(file.name);
      processCSV(text, file.name, dateLabel, false);
      processed++;
      if (processed === total) finishUpload();
    };
    reader.readAsText(file);
  });
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

  dropZone.addEventListener('click', () => document.getElementById('fileInput').click());
}

// ---- Export ----
function exportCSV() {
  if (state.filteredRows.length === 0) { showToast('No data to export'); return; }
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Team Lead', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Manual Calls Talk Time', 'Total Break Duration'];
  if (showDates) headers.push('Date');
  const csvRows = [headers.join(',')];

  state.filteredRows.forEach((r, i) => {
    const row = [
      i + 1,
      `"${(r._campaigns || [r['Campaign Name'] || '']).join(', ')}"`,
      `"${r['User Name'] || ''}"`,
      `"${r._tl ? teamLeadName(r._tl) : ''}"`,
      r['Total Staffed Duration'] || '00:00:00',
      r['Auto Call-On Duration'] || '00:00:00',
      r['Auto Call-Off Duration'] || '00:00:00',
      r['Manual Calls Talk Time'] || '00:00:00',
      r['Total Break Duration'] || '00:00:00'
    ];
    if (showDates) row.push(r._date || '');
    csvRows.push(row.join(','));
  });

  downloadFile(csvRows.join('\n'), 'ameyo_agent_report.csv', 'text/csv');
  showToast('CSV exported successfully');
}

function exportExcel() {
  if (state.filteredRows.length === 0) { showToast('No data to export'); return; }
  const showDates = !state.hasUserUploads && state.dates.length > 0;

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Team Lead', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Manual Calls Talk Time', 'Total Break Duration'];
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
    html += `<td>${r['Total Staffed Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Auto Call-On Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Auto Call-Off Duration'] || '00:00:00'}</td>`;
    html += `<td>${r['Manual Calls Talk Time'] || '00:00:00'}</td>`;
    html += `<td>${r['Total Break Duration'] || '00:00:00'}</td>`;
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
