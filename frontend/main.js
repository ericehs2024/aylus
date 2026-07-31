/* --- State Management --- */
let rawData = [];
let filteredData = [];

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

/* --- API Interaction --- */

function isServerBusy(error) {
  const msg = error.message || '';
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

async function startScrape() {
  const url = elements.urlInput.value.trim();
  if (!url) {
    showStatus('Please enter your branch homepage URL', 'error');
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
      showStatus(`Error: ${error.message}`, 'error');
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

  renderTables();
}

function renderTables() {
  // Render Details Table
  elements.detailsTableBody.innerHTML = '';
  filteredData.forEach(item => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${item.date}</td>
      <td><strong>${item.name}</strong></td>
      <td><span class="badge">${item.hours}h</span></td>
      <td><a href="${item.sourceUrl}" target="_blank" class="link-icon"><i data-lucide="external-link"></i></a></td>
    `;
    elements.detailsTableBody.appendChild(row);
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

  // Sort by total hours descending
  const sortedSummary = Object.entries(summary).sort((a, b) => b[1].total - a[1].total);

  elements.summaryTableBody.innerHTML = '';
  sortedSummary.forEach(([name, data]) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><strong>${name}</strong></td>
      <td><span class="hours-val">${data.total.toFixed(1)}</span></td>
      <td>${data.count}</td>
    `;
    elements.summaryTableBody.appendChild(row);
  });

  // Re-initialize icons in new rows
  lucide.createIcons();
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
elements.startDate.addEventListener('change', processAndDisplayData);
elements.endDate.addEventListener('change', processAndDisplayData);

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
