/* ============================================
   AMEYO AGENT PERFORMANCE DASHBOARD - APP.JS
   ============================================ */

const BUNDLED_FILES = ['8thOct.csv', '9thOct.csv', '10thOct.csv'];

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
  hasUserUploads: false
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
  });
});

async function loadBundledFiles() {
  for (const fname of BUNDLED_FILES) {
    try {
      const resp = await fetch(fname);
      if (!resp.ok) continue;
      const text = await resp.text();
      const dateLabel = extractDateLabel(fname);
      processCSV(text, fname, dateLabel, true);
    } catch (e) {}
  }
  if (state.dataSets.length > 0) mergeAndRender();
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

function processCSV(text, fileName, dateLabel, isBundled) {
  const { headers, rows } = parseCSV(text);
  const agentRows = rows.filter(r => {
    const pn = r['Process Name'] || '';
    const un = r['User Name'] || '';
    return pn !== 'Campaign Summary' && un !== '';
  });
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
      state.allRows.push({ ...r, _date: ds.isBundled ? ds.dateLabel : null });
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

  state.filteredRows = state.allRows.filter(r => {
    if (state.selectedCampaigns.size === 0) return false;
    if (!state.selectedCampaigns.has(r['Campaign Name'])) return false;
    if (showDates) {
      if (state.selectedDates.size === 0) return false;
      if (r._date && !state.selectedDates.has(r._date)) return false;
    }
    if (search && !(r['User Name'] || '').toLowerCase().includes(search)) return false;
    return true;
  });

  renderSummary();
  renderTable();
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
      <td><span class="campaign-badge">${r['Campaign Name'] || '—'}</span></td>
      <td>${r['User Name'] || '—'}</td>
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

function processUploadedFiles(files) {
  // User is uploading their own files — clear bundled data and replace
  state.dataSets = [];
  let processed = 0;
  const total = files.length;

  Array.from(files).forEach(file => {
    if (!file.name.endsWith('.csv')) {
      showToast(`Skipped "${file.name}" — only CSV files are supported`);
      processed++;
      if (processed === total) mergeAndRender();
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const dateLabel = extractDateLabel(file.name);
      processCSV(text, file.name, dateLabel, false);
      processed++;
      if (processed === total) mergeAndRender();
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

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Manual Calls Talk Time', 'Total Break Duration'];
  if (showDates) headers.push('Date');
  const csvRows = [headers.join(',')];

  state.filteredRows.forEach((r, i) => {
    const row = [
      i + 1,
      `"${r['Campaign Name'] || ''}"`,
      `"${r['User Name'] || ''}"`,
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

  const headers = ['#', 'Campaign Name', 'Agent Name', 'Total Staffed Duration', 'Auto Call-On Duration', 'Auto Call-Off Duration', 'Manual Calls Talk Time', 'Total Break Duration'];
  if (showDates) headers.push('Date');

  let html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
  html += '<head><meta charset="UTF-8"><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Agent Report</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head>';
  html += '<body><table border="1">';
  html += '<tr>' + headers.map(h => `<th style="background:#2563eb;color:#fff;font-weight:bold;padding:8px">${h}</th>`).join('') + '</tr>';

  state.filteredRows.forEach((r, i) => {
    html += '<tr>';
    html += `<td>${i + 1}</td>`;
    html += `<td>${r['Campaign Name'] || ''}</td>`;
    html += `<td>${r['User Name'] || ''}</td>`;
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
