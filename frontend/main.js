/* --- State Management --- */
let rawData = [];
let filteredData = [];
let summaryData = [];

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
  tabContents: document.querySelectorAll('.tab-content')
};

// Load saved URL from localStorage
const savedUrl = localStorage.getItem('aylus_branch_url');
if (savedUrl) {
  elements.urlInput.value = savedUrl;
}

// Set default dates (past month)
const today = new Date();
const lastMonth = new Date(today);
lastMonth.setMonth(today.getMonth() - 1);

elements.endDate.valueAsDate = today;
elements.startDate.valueAsDate = lastMonth;

// Enforce the max range in the native date pickers
const minStartDate = new Date(today);
minStartDate.setDate(today.getDate() - MAX_RANGE_DAYS);
elements.startDate.min = toISODate(minStartDate);
elements.endDate.min = toISODate(minStartDate);
elements.startDate.max = toISODate(today);
elements.endDate.max = toISODate(today);

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

const MAX_RANGE_DAYS = 365;

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function dateRangeError() {
  const startVal = elements.startDate.value;
  const endVal = elements.endDate.value;
  if (!startVal || !endVal) return null;
  const diffDays = (new Date(endVal) - new Date(startVal)) / (1000 * 60 * 60 * 24);
  if (diffDays > MAX_RANGE_DAYS) {
    return `Date range cannot exceed ${MAX_RANGE_DAYS} days. Please narrow your start and end dates.`;
  }
  return null;
}

async function startScrape() {
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

  setLoadingStatus(true);
  showStatus('It may take a few minutes. Please wait...', 'info');

  try {
    const response = await axios.post('/api/scrape', {
      url,
      startDate: elements.startDate.value || null,
      endDate: elements.endDate.value || null,
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

  // Filter by date range
  filteredData = rawData.filter(item => {
    const itemDate = new Date(item.date);
    if (isNaN(itemDate.getTime())) return false;

    if (start && itemDate < start) return false;
    if (end && itemDate > end) return false;

    return true;
  });

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
