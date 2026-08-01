require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');

// Reuse TCP/TLS connections across the many page fetches
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });
axios.defaults.httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
axios.defaults.httpsAgent = keepAliveAgent;

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files built from ./dist (copied during build)
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

// Simple in-memory cache with TTL (60s) to avoid re-fetching pages
const pageCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

/**
 * Run async fn over items with limited concurrency.
 * Failed items are skipped (logged) instead of rejecting the batch.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error(`[scrape] Error: ${err.message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results.filter(r => r !== undefined);
}

/**
 * Fetch HTML using axios with browser-like headers.
 * Retries on failure to handle WAF blocks. Caches results for 60s.
 */
async function fetchHtml(url, retries = 2) {
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) {
    return cached.html;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 20000,
        validateStatus: () => true, // Don't throw on 4xx/5xx
      });

      if (response.status === 200 && response.data && response.data.length > 100) {
        pageCache.set(url, { html: response.data, time: Date.now() });
        return response.data;
      }

      console.log(`[fetch] Unexpected response: ${response.status} for ${url}`);
      if (attempt < retries) continue;
      return null;
    } catch (error) {
      console.log(`[fetch] Error: ${error.message} for ${url}`);
      if (attempt < retries) continue;
      return null;
    }
  }
}

// Trim cache to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pageCache) {
    if (now - value.time > CACHE_TTL_MS) pageCache.delete(key);
  }
}, CACHE_TTL_MS);

/**
 * Cheerio: extract ALL links from the div.entry-content container.
 */
function extractAllLinks($) {
  const results = [];
  const seen = new Set();

  // Remove scripts and styles inside the entry-content div
  $('div.entry-content script').remove();
  $('div.entry-content style').remove();

  // Extract all links from within div.entry-content (deduped)
  $('div.entry-content a').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().replace(/\s+/g, ' ').trim();
    if (href && text && !seen.has(href)) {
      seen.add(href);
      results.push({ url: href, text });
    }
  });

  console.log(`[links] Extracted ${results.length} links from div.entry-content`);
  return results;
}

/**
 * Extract the readable text of an activity page.
 * Prefers #content to exclude nav/footer/sidebar noise (smaller, faster Gemini prompts).
 */
function extractContentText(html) {
  const $ = cheerio.load(html);
  $('#content script').remove();
  $('#content style').remove();
  let text = $('#content').text();
  if (!text.trim()) text = $('body').text();
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Regex-only activity link extraction (no LLM).
 * Matches many date formats in the link URL and/or text:
 *   - numeric:   07-02-26, 7/2/26, 7/2026, 2026-07-02, /2026/07/02/
 *   - month name: July 2026, Jul. 26, Jul. 2, 2026, june-12-2025
 * A link without any date match still qualifies (date: null) and is
 * included regardless of the requested range.
 */

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function monthToNumber(name) {
  const key = name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
  return MONTH_NAMES[key] || null;
}

function normalizeYear(y) {
  const n = parseInt(y, 10);
  return n >= 100 ? n : 2000 + n;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

const ORD = '(?:st|nd|rd|th)?';

function extractDateFromLink(link) {
  const combined = `${link.text} | ${link.url}`;

  // Compound range: "July 6 to July 10, 2026", "Oct 1 and Oct 8th, 2022" → start date
  let m = combined.match(new RegExp(`(?:from[\\s-]+)?([A-Za-z]{3,9})\\.?[\\s-]*(\\d{1,2})${ORD}[\\s-]+(?:to|through|thru|and|&)[\\s-]+[A-Za-z]{3,9}\\.?[\\s-]*(\\d{1,2})${ORD}[\\s,-]+(\\d{4})(?!\\d)`, 'i'));
  if (m) {
    const month = monthToNumber(m[1]);
    if (month) return `${normalizeYear(m[4])}-${pad2(month)}-${pad2(m[2])}`;
  }

  // Month name + day + full year: "Jul. 2, 2026", "june-12-2025", "oct-8th-2022"
  m = combined.match(new RegExp(`([A-Za-z]{3,9})\\.?[\\s-]*(\\d{1,2})${ORD}[\\s,-]*(\\d{4})(?!\\d)`));
  if (m) {
    const month = monthToNumber(m[1]);
    if (month) return `${normalizeYear(m[3])}-${pad2(month)}-${pad2(m[2])}`;
  }

  // Month name + day + 2-digit year: "jul-18-26"
  m = combined.match(new RegExp(`([A-Za-z]{3,9})\\.?[\\s-]*(\\d{1,2})${ORD}[\\s-]+(\\d{2})(?!\\d)`));
  if (m) {
    const month = monthToNumber(m[1]);
    if (month) return `${normalizeYear(m[3])}-${pad2(month)}-${pad2(m[2])}`;
  }

  // Month name + 2-digit year: "Jul. 26"
  m = combined.match(/([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?![\d,.])/);
  if (m) {
    const month = monthToNumber(m[1]);
    const num = parseInt(m[2], 10);
    if (month && num >= 18 && num <= 99) return `${normalizeYear(num)}-${pad2(month)}-01`;
  }

  // Month name + full year: "July 2026"
  m = combined.match(/([A-Za-z]{3,9})\.?[\s-]+(\d{4})(?!\d)/);
  if (m) {
    const month = monthToNumber(m[1]);
    if (month) return `${normalizeYear(m[2])}-${pad2(month)}-01`;
  }

  // Numeric M-D-YYYY or M-D-YY. Checked BEFORE the permalink pattern so an
  // event date in the slug (e.g. "63rd-7-18-26") wins over the publish date.
  // Scans all candidates and accepts the first with a valid month/day.
  const mdPattern = /(^|[^\d])(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(?!\d)/g;
  while ((m = mdPattern.exec(combined)) !== null) {
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${normalizeYear(m[4])}-${pad2(month)}-${pad2(day)}`;
    }
  }

  // ISO / WP permalink: YYYY-M-D or YYYY/M/D
  m = combined.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?!\d)/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  // Numeric M-YYYY: "7/2026"
  m = combined.match(/(^|[^\d])(\d{1,2})[/-](\d{4})(?!\d)/);
  if (m) {
    const month = parseInt(m[2], 10);
    if (month >= 1 && month <= 12) return `${m[3]}-${pad2(month)}-01`;
  }

  // Numeric YYYY-M: "2026-07", "/2026/07/"
  m = combined.match(/(\d{4})[/-](\d{1,2})(?!\d)/);
  if (m) return `${m[1]}-${pad2(m[2])}-01`;

  return null;
}

function extractActivitiesByRegex(allLinks, pageUrl) {
  const results = [];
  const seen = new Set();
  const baseHref = new URL(pageUrl).href;

  for (const link of allLinks) {
    const absUrl = new URL(link.url, pageUrl).href;
    if (absUrl === baseHref) continue; // skip the branch page itself
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);

    const date = extractDateFromLink(link);
    results.push({ url: absUrl, date, text: link.text });
  }

  const withDate = results.filter(r => r.date).length;
  console.log(`[regex-act] Found ${results.length} activity links (${withDate} with dates, ${results.length - withDate} without)`);
  return results;
}

/**
 * Cheerio fallback: take ALL <a> links inside <ul> elements within the
 * entry-content container. Used as last resort when Gemini returns
 * no activity links. Accepts an already-parsed cheerio instance.
 */
function extractActivitiesFallback($) {
  const results = [];

  $('div.entry-content.cf ul a').each((i, aEl) => {
    const linkText = $(aEl).text().trim();
    const linkHref = $(aEl).attr('href');
    if (linkText && linkHref) {
      results.push({ url: linkHref, text: linkText });
    }
  });

  console.log(`[fallback] Found ${results.length} activity links inside ul elements`);
  return results;
}

/**
 * Sleep for a given duration in milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Enforce minimum spacing between Gemini calls (15 RPM = one call per 4s).
// A promise-chain queue serializes concurrent callers so the spacing is
// guaranteed even when multiple scrape jobs overlap.
let geminiQueue = Promise.resolve();
let lastGeminiCallAt = 0;
const GEMINI_MIN_INTERVAL_MS = 7000; // RPM floor: max ~8.6 calls/min (limit 15)

// Token-aware throttling: keep estimated input tokens in any rolling 60s
// window well below the free-tier TPM cap (250K).
const GEMINI_TPM_BUDGET = 120000;
let geminiTokenWindow = [];

// Daily request guard (free tier RPD ~1000).
const GEMINI_RPD_MAX = 900;
const GEMINI_RPD_WARN = 750;
let geminiCallsToday = 0;
let geminiDayKey = new Date().toDateString();

function ensureGeminiDailyQuota() {
  const today = new Date().toDateString();
  if (today !== geminiDayKey) {
    geminiDayKey = today;
    geminiCallsToday = 0;
  }
  if (geminiCallsToday >= GEMINI_RPD_MAX) {
    throw new Error('Daily Gemini quota reached, please try again tomorrow');
  }
}

function countGeminiCall() {
  geminiCallsToday += 1;
  if (geminiCallsToday >= GEMINI_RPD_WARN) {
    console.warn(`[gemini] WARNING: ${geminiCallsToday} calls today (hard limit ${GEMINI_RPD_MAX})`);
  }
}

async function throttleGemini(promptTokens = 0) {
  const prev = geminiQueue;
  let release;
  geminiQueue = new Promise(r => { release = r; });
  await prev;
  try {
    // RPM floor: at least 7s between calls (~8.6 RPM max, limit is 15)
    const rpmWait = lastGeminiCallAt + GEMINI_MIN_INTERVAL_MS - Date.now();
    if (rpmWait > 0) {
      console.log(`[gemini] Throttling ${Math.ceil(rpmWait / 1000)}s to stay under RPM limit...`);
      await sleep(rpmWait);
    }

    // TPM rolling 60s window: wait until enough budget frees up.
    // A single oversized call is allowed when the window is otherwise empty.
    const now = Date.now();
    geminiTokenWindow = geminiTokenWindow.filter(e => e.at > now - 60000);
    const windowTokens = geminiTokenWindow.reduce((sum, e) => sum + e.tokens, 0);
    if (windowTokens > 0 && windowTokens + promptTokens > GEMINI_TPM_BUDGET) {
      const oldest = geminiTokenWindow[0];
      const wait = oldest.at + 60000 - now;
      if (wait > 0) {
        console.log(`[gemini] Throttling ${Math.ceil(wait / 1000)}s for TPM budget (${windowTokens}+${promptTokens} est. tokens in window)`);
        await sleep(wait);
      }
    }
    geminiTokenWindow.push({ tokens: promptTokens, at: Date.now() });
    lastGeminiCallAt = Date.now();
  } finally {
    release();
  }
}

/**
 * Call Gemini with strict rate-limit protection:
 * - serialized 7s spacing between calls (max ~8.6 RPM, below the 15 RPM cap)
 * - token-aware throttle keeps estimated input tokens per rolling 60s window
 *   under 120K (well below the 250K free-tier TPM cap)
 * - daily call guard at 900 (well below the ~1,000 free-tier RPD cap)
 * - on 429/503, waits 60s (full sliding window) before retrying
 * - caps output tokens at the model max so large single calls don't truncate
 * - aborts hung requests after 1 minute
 */
async function geminiCallWithRetry(prompt, pageUrl = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const maxRetries = 3;
  const GEMINI_TIMEOUT_MS = 60 * 1000;
  const GEMINI_PROMPT_MAX_CHARS = 750000;

  if (prompt.length > GEMINI_PROMPT_MAX_CHARS) {
    throw new Error(`Prompt too large (${prompt.length} chars, max ${GEMINI_PROMPT_MAX_CHARS}); narrow the date range and retry`);
  }

  ensureGeminiDailyQuota();

  const estTokens = Math.ceil(prompt.length / 3);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await throttleGemini(estTokens);
      countGeminiCall();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                maxOutputTokens: 65536,
              },
            }),
            signal: controller.signal,
          }
        );
      } finally {
        clearTimeout(timeout);
      }

      // Handle rate limit (429) or server error (503)
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          console.log(`[gemini] Rate limited on attempt ${attempt + 1}, waiting 60s for the window to reset...`);
          if (attempt < maxRetries - 1) {
            await sleep(60000);
            continue;
          }
          throw new Error(`Rate limit exceeded after ${maxRetries} attempts`);
        }
        const body = (await response.text()).slice(0, 500);
        throw new Error(`API error: ${response.status} ${body}`);
      }

      const data = await response.json();
      const candidate = data.candidates?.[0]?.content?.parts?.[0];
      return candidate?.text || '';
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Gemini request timed out after ${GEMINI_TIMEOUT_MS / 1000}s`);
      }
      console.error(`[gemini] Call failed (attempt ${attempt + 1}): ${error.message}`);
      if (attempt < maxRetries - 1) {
        const isRateLimit = error.message.includes('429') || error.message.includes('503');
        const waitTime = isRateLimit ? 60000 : 10000;
        console.log(`[gemini] Waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Gemini API exhausted all retries');
}

// Per-activity text cap for the Gemini prompt (last N chars, where volunteer
// names and hours usually appear)
const GEMINI_PER_ACTIVITY_CAP = 2000;

function buildVolunteerPrompt(activityTexts) {
  let promptText = `Extract volunteer names and hours from ALL activity reports below.
Return ONLY a JSON array in this exact format: [{"name": "Full Name", "hours": 2.5, "date": "YYYY-MM-DD", "sourceUrl": "https://..."}].
If no volunteers are mentioned, return an empty array [].

Here are the activity reports (numbered for reference):
`;
  for (let i = 0; i < activityTexts.length; i++) {
    const act = activityTexts[i];
    const truncated = act.text.slice(-GEMINI_PER_ACTIVITY_CAP);
    promptText += `\n--- Activity ${i + 1} (${act.date}, ${act.sourceUrl || act.url}) ---\n${truncated}\n`;
  }
  return promptText;
}

/**
 * Extract volunteer hours via Gemini in a single call.
 */
async function extractVolunteersBatched(activityTexts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set, cannot extract volunteers');
  }

  console.log(`[gemini-vol] Sending ${activityTexts.length} activities in a single Gemini call`);
  const promptText = buildVolunteerPrompt(activityTexts);

  try {
    const raw = await geminiCallWithRetry(promptText);
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    if (!cleaned) {
      throw new Error('Gemini returned an empty response');
    }
    const volunteers = JSON.parse(cleaned);
    if (Array.isArray(volunteers)) {
      console.log(`[gemini-vol] Extracted ${volunteers.length} records`);
      return volunteers;
    }
    return [];
  } catch (error) {
    if (error.message.includes('JSON')) {
      console.error('[gemini-vol] Gemini returned invalid JSON');
    }
    console.error(`[gemini-vol] Gemini call failed: ${error.message}`);
    if (error.message.includes('Rate limit') || error.message.includes('429') || error.message.includes('503')) {
      throw new Error('Server busy, please wait a few minutes');
    }
    throw error;
  }
}

app.post('/api/scrape', async (req, res) => {
  const { url, startDate, endDate } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const startTime = Date.now();
  console.log('=== Scrape Request ===');
  console.log(`[request] URL: ${url}`);
  console.log(`[request] startDate: ${startDate}`);
  console.log(`[request] endDate: ${endDate}`);
  console.log(`[request] Started at: ${new Date().toISOString()}`);

  // Parse optional date range bounds (inclusive on both ends)
  const rangeStart = startDate ? new Date(startDate) : null;
  const rangeEnd = endDate ? new Date(endDate) : null;
  console.log(`[date-filter] Requested range: ${startDate} → ${endDate}`);

  try {
    console.log('[timing] Fetching main page...');
    const mainHtml = await fetchHtml(url);
    if (!mainHtml) {
      return res.status(502).json({ error: 'Failed to fetch the branch page' });
    }
    const $ = cheerio.load(mainHtml);
    const allLinks = extractAllLinks($);
    console.log(`[timing] Main page fetched: ${Date.now() - startTime}ms`);

    // Step 2: Extract activity links + dates with regex only (no LLM).
    // Covers multiple date formats (numeric and month names, 2/4-digit years).
    let rawLinks = extractActivitiesByRegex(allLinks, url);

    // Last fallback: regex found nothing → Cheerio ul walk
    if (rawLinks.length === 0) {
      console.log('[fallback] Regex found no activity links, using Cheerio ul fallback');
      const fallbackLinks = extractActivitiesFallback($);
      rawLinks = fallbackLinks.map(link => ({
        url: link.url.startsWith('http') ? link.url : new URL(link.url, url).href,
        date: null, // unknown — included regardless of date range
        text: link.text
      }));
    }

    // Step 3: Filter by date range
    let activitiesLinks = [];
    for (const link of rawLinks) {
      // Fallback links have no date — include them regardless of the range
      if (!link.date) {
        console.log(`[date-filter] No date (fallback link), INCLUDING: ${link.url}`);
        activitiesLinks.push({ url: link.url, date: null, text: link.text || 'activity' });
        continue;
      }

      let dateStr = link.date;
      let parsed = new Date(dateStr);

      if (isNaN(parsed.getTime())) {
        console.log(`[date-filter] Invalid date "${dateStr}", skipping`);
        continue;
      }

      const inRange = (!rangeStart || parsed >= rangeStart) && (!rangeEnd || parsed <= rangeEnd);
      console.log(`[date-filter] ${inRange ? 'IN RANGE' : 'OUT OF RANGE'}: ${link.url} (${dateStr})`);

      if (inRange) {
        activitiesLinks.push({
          url: link.url,
          date: link.date,
          text: link.text || `${link.date} activity`
        });
      }
    }
    console.log(`[date-filter] Total links in date range: ${activitiesLinks.length}`);

    if (activitiesLinks.length === 0) {
      console.log('[scrape] No activities in date range, returning empty');
      return res.json({ success: true, data: [] });
    }

    // Step 4: Fetch activity pages with a concurrency pool (limit 6)
    // to avoid triggering WAF/rate limits while staying much faster than sequential.
    console.log(`[scrape] === Fetching ${activitiesLinks.length} activity pages (6 concurrent) ===`);
    let activityTexts = [];

    const pageResults = await mapLimit(activitiesLinks, 6, async (link) => {
      const detailHtml = await fetchHtml(link.url);
      if (!detailHtml) return null;
      const text = extractContentText(detailHtml);
      console.log(`[scrape] ${link.url}: ${text.length} chars`);
      return { url: link.url, date: link.date, text };
    });

    activityTexts = pageResults.filter(r => r && r.text.trim());

    console.log(`[timing] All pages fetched: ${Date.now() - startTime}ms`);
    console.log(`[scrape] === All pages fetched, sending to Gemini ===`);

    // Step 5: ONE Gemini call to extract volunteers from ALL activities
    console.log(`[timing] Before volunteer extraction: ${Date.now() - startTime}ms`);
    const allVolunteers = await extractVolunteersBatched(activityTexts);

    console.log(`[timing] Volunteer extraction done: ${Date.now() - startTime}ms`);
    console.log(`[scrape] === Complete ===`);
    console.log(`[scrape] Total volunteer records: ${allVolunteers.length}`);
    console.log(`[timing] Total time: ${Date.now() - startTime}ms`);

    res.json({
      success: true,
      data: allVolunteers
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    const isRateLimit = error.message.includes('Rate limit') ||
      error.message.includes('429') ||
      error.message.includes('503') ||
      error.message.includes('too many') ||
      error.message.includes('Gemini API error');

    console.log(`[timing] Error after: ${Date.now() - startTime}ms`);

    if (res.headersSent) {
      console.error('[scrape] Response already sent, cannot send error');
      return;
    }

    if (isRateLimit) {
      res.status(503).json({ error: 'Server busy, please wait a few minutes' });
    } else {
      res.status(500).json({ error: 'Failed to scrape the website: ' + error.message });
    }
  }
});

// Catch-all: serve index.html for all non-API and non-POST requests (SPA fallback)
app.use((req, res) => {
  if (req.method !== 'POST' && !req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    return;
  }
  res.sendStatus(404);
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
