/* --- State Management --- */
let rawData = [];
let filteredData = [];
let summaryData = [];

const MAX_RANGE_DAYS = 365;

// Per-table sort state: { col, dir } with dir = 1 (asc) or -1 (desc)
const sortState = {
  summary: { col: 'total', dir: -1 },
  details: { col: null, dir: 1 }
};

const SORT_SPECS = {
  summary: [
    { key: 'name', type: 'string' },
    { key: 'total', type: 'number' },
    { key: 'count', type: 'number' }
  ],
  details: [
    { key: 'date', type: 'string' },
    { key: 'name', type: 'string' },
    { key: 'hours', type: 'number' }
  ]
};

function applySort(data, table) {
  const state = sortState[table];
  if (!state.col) return data;
  const spec = SORT_SPECS[table].find(s => s.key === state.col);
  const dir = state.dir;
  return [...data].sort((a, b) => {
    const av = a[state.col];
    const bv = b[state.col];
    if (spec.type === 'number') {
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * dir;
    }
    return String(av).localeCompare(String(bv)) * dir;
  });
}

function updateSortIndicators() {
  document.querySelectorAll('#summary-table th[data-sort], #details-table th[data-sort]').forEach(th => {
    const table = th.closest('table').id === 'summary-table' ? 'summary' : 'details';
    const key = th.getAttribute('data-sort');
    const indicator = th.querySelector('.sort-indicator');
    if (!indicator) return;
    const state = sortState[table];
    if (state.col !== key) {
      indicator.textContent = '↕';
      indicator.classList.remove('active');
    } else {
      indicator.textContent = state.dir === 1 ? '▲' : '▼';
      indicator.classList.add('active');
    }
  });
}

// Initialize Lucide Icons
lucide.createIcons();

// DOM Elements
const elements = {
  urlInput: document.getElementById('url-input'),
  startDate: document.getElementById('start-date'),
  endDate: document.getElementById('end-date'),
  scrapeBtn: document.getElementById('scrape-btn'),
  statusContainer: document.getElementById('status-container'),
  statusText: document.getElementById('status-text'),
  resultsArea: document.getElementById('results-area'),
  summaryTableBody: document.querySelector('#summary-table tbody'),
  detailsTableBody: document.querySelector('#details-table tbody'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  tabContents: document.querySelectorAll('.tab-content'),
  aliasList: document.getElementById('alias-list'),
  addAliasBtn: document.getElementById('add-alias-btn')
};

// Load saved URL from localStorage
const savedUrl = localStorage.getItem('aylus_branch_url');
if (savedUrl) {
  elements.urlInput.value = savedUrl;
}

/* --- Name Aliases --- */

const ALIAS_STORAGE_KEY = 'aylus_name_aliases';
const ALIAS_EXPIRY_MS = 3 * 365 * 24 * 60 * 60 * 1000; // 3 years

let aliasEntries = [];

function loadAliases() {
  try {
    const raw = localStorage.getItem(ALIAS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.entries)) return [];
    if (parsed.expiresAt && Date.now() > parsed.expiresAt) {
      localStorage.removeItem(ALIAS_STORAGE_KEY);
      return [];
    }
    return parsed.entries.filter(e => e && typeof e.name === 'string');
  } catch {
    return [];
  }
}

function saveAliases() {
  localStorage.setItem(ALIAS_STORAGE_KEY, JSON.stringify({
    expiresAt: Date.now() + ALIAS_EXPIRY_MS,
    entries: aliasEntries
  }));
}

function renderAliasRows() {
  elements.aliasList.innerHTML = '';

  if (aliasEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'alias-empty';
    empty.textContent = 'No aliases yet. Add one to merge duplicate names in the summary.';
    elements.aliasList.appendChild(empty);
    return;
  }

  aliasEntries.forEach((entry, idx) => {
    const row = document.createElement('div');
    row.className = 'alias-row';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'alias-name';
    nameInput.placeholder = 'Primary Name';
    nameInput.value = entry.name || '';

    const eq = document.createElement('span');
    eq.className = 'alias-eq';
    eq.textContent = '==';

    const aliasInput = document.createElement('input');
    aliasInput.type = 'text';
    aliasInput.className = 'alias-inputs';
    aliasInput.placeholder = 'Alias1, Alias2';
    aliasInput.value = entry.aliases || '';

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'alias-remove-btn';
    removeBtn.title = 'Remove alias';
    removeBtn.setAttribute('aria-label', 'Remove alias');
    removeBtn.textContent = '×';

    const update = () => {
      entry.name = nameInput.value;
      entry.aliases = aliasInput.value;
      saveAliases();
      processAndDisplayData();
    };
    nameInput.addEventListener('input', update);
    aliasInput.addEventListener('input', update);

    removeBtn.addEventListener('click', () => {
      aliasEntries.splice(idx, 1);
      saveAliases();
      renderAliasRows();
      processAndDisplayData();
    });

    row.append(nameInput, eq, aliasInput, removeBtn);
    elements.aliasList.appendChild(row);
  });
}

function addAliasRow() {
  aliasEntries.push({ name: '', aliases: '' });
  saveAliases();
  renderAliasRows();
  const lastRow = elements.aliasList.lastElementChild;
  const input = lastRow?.querySelector('.alias-name');
  if (input) input.focus();
}

function canonicalName(name) {
  if (!name) return name;
  const normalized = String(name).replace(/\s+/g, ' ').trim().toLowerCase();
  for (const entry of aliasEntries) {
    const primary = (entry.name || '').replace(/\s+/g, ' ').trim();
    if (!primary) continue;
    if (primary.toLowerCase() === normalized) return primary;
    const aliases = String(entry.aliases || '')
      .split(',')
      .map(a => a.replace(/\s+/g, ' ').trim().toLowerCase())
      .filter(Boolean);
    if (aliases.includes(normalized)) return primary;
  }
  return String(name).replace(/\s+/g, ' ').trim();
}

aliasEntries = loadAliases();
renderAliasRows();
elements.addAliasBtn.addEventListener('click', addAliasRow);

// Set default dates (past month)
const today = new Date();
const lastMonth = new Date(today);
lastMonth.setMonth(today.getMonth() - 1);

elements.endDate.valueAsDate = today;
elements.startDate.valueAsDate = lastMonth;

/* --- API Interaction --- */

function isServerBusy(error) {
  const msg = `${error.response?.data?.error || ''} ${error.message || ''}`;
  return msg.includes('Server busy') ||
    msg.includes('Rate limit') ||
    msg.includes('rate limit') ||
    msg.includes('too many') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('Gemini API') ||
    msg.includes('Gemini error') ||
    msg.includes('Scraping error');
}

function getErrorMessage(error) {
  return error.response?.data?.error || error.message || 'Unknown error occurred';
}

function dateRangeError() {
  const startVal = elements.startDate.value;
  const endVal = elements.endDate.value;
  if (!startVal || !endVal) return null;
  const start = new Date(startVal);
  const end = new Date(endVal);
  if (start > end) {
    return 'Start date cannot be after the end date.';
  }
  const diffDays = (end - start) / (1000 * 60 * 60 * 24);
  if (diffDays > MAX_RANGE_DAYS) {
    return `Date range cannot exceed ${MAX_RANGE_DAYS} days. Please narrow your start and end dates.`;
  }
  return null;
}

let isScraping = false;

async function startScrape() {
  if (isScraping) return;

  const url = elements.urlInput.value.trim();
  if (!url) {
    showStatus('Please enter your branch homepage URL', 'error');
    return;
  }

  const rangeError = dateRangeError();
  if (rangeError) {
    showStatus(rangeError, 'error');
    return;
  }

  isScraping = true;
  setLoadingStatus(true);
  showStatus('It may take a few minutes. Please wait...', 'info');

  try {
    const aliases = aliasEntries
      .filter(e => String(e.name || '').trim() && String(e.aliases || '').trim())
      .map(e => ({ name: e.name.trim(), aliases: e.aliases.trim() }));

    const response = await axios.post('/api/scrape', {
      url,
      startDate: elements.startDate.value || null,
      endDate: elements.endDate.value || null,
      aliases,
    });

    if (response.data.success) {
      rawData = response.data.data;
      processAndDisplayData();
      showStatus(`Successfully found ${rawData.length} entries!`, 'success');
      elements.resultsArea.classList.remove('hidden');
    } else {
      throw new Error(response.data.error || 'Unknown error occurred');
    }
  } catch (error) {
    if (isServerBusy(error)) {
      showStatus('Server busy, please wait a few minutes', 'error');
    } else {
      showStatus(`Error: ${getErrorMessage(error)}`, 'error');
    }
    console.error(error);
  } finally {
    setLoadingStatus(false);
    isScraping = false;
  }
}

// Save URL to localStorage on blur (when input loses focus)
elements.urlInput.addEventListener('blur', () => {
  localStorage.setItem('aylus_branch_url', elements.urlInput.value.trim());
});

/* --- Data Processing --- */

function processAndDisplayData() {
  const start = elements.startDate.value ? new Date(elements.startDate.value) : null;
  const end = elements.endDate.value ? new Date(elements.endDate.value) : null;

  // Filter by date range and merge alias names into their primary name
  filteredData = rawData
    .filter(item => {
      const itemDate = new Date(item.date);
      if (isNaN(itemDate.getTime())) return false;

      if (start && itemDate < start) return false;
      if (end && itemDate > end) return false;

      return true;
    })
    .map(item => ({ ...item, name: canonicalName(item.name) }));

  // Aggregate for Summary Table
  const summary = {};
  filteredData.forEach(item => {
    if (!summary[item.name]) {
      summary[item.name] = { total: 0, count: 0 };
    }
    summary[item.name].total += item.hours;
    summary[item.name].count += 1;
  });
  summaryData = Object.entries(summary).map(([name, data]) => ({
    name,
    total: data.total,
    count: data.count
  }));

  renderTables();
}

function renderTables() {
  // Render Details Table (sorted)
  elements.detailsTableBody.innerHTML = '';
  applySort(filteredData, 'details').forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.date}</td>
      <td><strong>${item.name}</strong></td>
      <td><span class="badge">${item.hours}h</span></td>
      <td><a href="${item.sourceUrl}" target="_blank" class="link-icon"><i data-lucide="external-link"></i></a></td>
    `;
    elements.detailsTableBody.appendChild(row);
  });

  // Render Summary Table (sorted)
  elements.summaryTableBody.innerHTML = '';
  applySort(summaryData, 'summary').forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${item.name}</strong></td>
      <td><span class="hours-val">${item.total.toFixed(1)}</span></td>
      <td>${item.count}</td>
    `;
    elements.summaryTableBody.appendChild(row);
  });

  // Re-initialize icons in new rows
  lucide.createIcons();
  updateSortIndicators();
}

/* --- UI Utilities --- */

function showStatus(text, type) {
  elements.statusContainer.classList.remove('hidden');
  elements.statusText.textContent = text;
  elements.statusContainer.className = `status-${type}`;
}

function setLoadingStatus(isLoading) {
  if (isLoading) {
    elements.scrapeBtn.classList.add('loading');
    elements.scrapeBtn.disabled = true;
  } else {
    elements.scrapeBtn.classList.remove('loading');
    elements.scrapeBtn.disabled = false;
  }
}

/* --- Event Handlers --- */

elements.scrapeBtn.addEventListener('click', startScrape);

// Re-filter when dates change
function handleDateChange() {
  if (isScraping) return; // don't re-enable the Go button mid-request
  const rangeError = dateRangeError();
  if (rangeError) {
    showStatus(rangeError, 'error');
    elements.scrapeBtn.disabled = true;
    return;
  }
  elements.scrapeBtn.disabled = false;
  processAndDisplayData();
}
elements.startDate.addEventListener('change', handleDateChange);
elements.endDate.addEventListener('change', handleDateChange);

// Sortable table headers
document.querySelectorAll('#summary-table th[data-sort], #details-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const table = th.closest('table').id === 'summary-table' ? 'summary' : 'details';
    const key = th.getAttribute('data-sort');
    const state = sortState[table];
    if (state.col === key) {
      state.dir *= -1;
    } else {
      state.col = key;
      state.dir = 1;
    }
    renderTables();
  });
});

// Tab switching
elements.tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.getAttribute('data-tab');

    elements.tabBtns.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    elements.tabContents.forEach(content => {
      content.classList.add('hidden');
      if (content.id === `${tabName}-tab`) {
        content.classList.remove('hidden');
      }
    });
  });
});
