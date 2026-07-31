require('dotenv').config();

const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files built from ./dist (copied during build)
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

/**
 * Fetch HTML using axios with browser-like headers.
 * Retries on failure to handle WAF blocks.
 */
async function fetchHtml(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[fetch] Attempt ${attempt}/${retries}: ${url}`);
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Encoding': 'identity',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
        timeout: 30000,
        validateStatus: () => true, // Don't throw on 4xx/5xx
      });

      if (response.status === 200 && response.data && response.data.length > 100) {
        console.log(`[fetch] Success: ${response.status}, ${response.data.length} bytes`);
        return response.data;
      }

      console.log(`[fetch] Unexpected response: ${response.status}`);
      if (attempt < retries) continue;
      throw new Error(`Unexpected response status: ${response.status}`);
    } catch (error) {
      console.log(`[fetch] Error: ${error.message}`);
      if (attempt < retries) continue;
      throw error;
    }
  }
}

/**
 * Cheerio: extract ALL links from the #content div only.
 * Then Gemini parses the text to find dates and activity URLs.
 */
function extractAllLinks(bodyHtml) {
  const $ = cheerio.load(bodyHtml);
  const results = [];

  // Remove scripts and styles inside #content
  $('#content script').remove();
  $('#content style').remove();

  // Only extract links from within the #content div
  $('#content a').each((i, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (href && text) {
      results.push({ url: href, text });
    }
  });

  console.log(`[links] Extracted ${results.length} links from #content div via Cheerio`);
  return results;
}

/**
 * Gemini call: parse activity links with dates from the list of all links.
 * Returns [{ url, date }] for each activity found.
 * Uses retry logic to handle rate limits (15 RPM).
 */
async function extractActivitiesWithGemini(allLinks, pageUrl) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || allLinks.length === 0) {
    console.log('[gemini-act] No links to parse, returning empty');
    return [];
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  // Build structured prompt with all links
  let prompt = `Given the following list of links, identify which are activity/event links and extract their dates.
Return ONLY a JSON array in this exact format: [{"url": "https://...", "date": "YYYY-MM-DD"}].
If there are no activity links, return an empty array [].
Focus on links that contain dates in their URL or text.

Base URL: ${pageUrl}

Links:
`;
  allLinks.forEach((link, i) => {
    prompt += `${i + 1}. URL: ${link.url} | Text: ${link.text}\n`;
  });

  console.log('[gemini-act] === Extract activity links ===');
  console.log(`[gemini-act] Model: ${model}`);
  console.log(`[gemini-act] Total links to parse: ${allLinks.length}`);

  try {
    const raw = await geminiCallWithRetry(prompt, pageUrl);
    console.log(`[gemini-act] Raw response: ${raw}`);
    const cleanedResp = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const result = JSON.parse(cleanedResp);
    console.log(`[gemini-act] Extracted ${result.length} activity links:`);
    result.forEach(item => {
      console.log(`[gemini-act]   - url: ${item.url}, date: ${item.date}`);
    });
    return result.map(item => ({
      url: item.url.startsWith('http') ? item.url : new URL(item.url, pageUrl).href,
      date: item.date
    }));
  } catch (error) {
    console.error(`[gemini-act] Failed: ${error.message}`);
    if (error.message.includes('Rate limit') || error.message.includes('429') || error.message.includes('503')) {
      throw new Error('Server busy, please wait a few minutes');
    }
    return [];
  }
}

/**
 * Cheerio fallback: find "Activities:" label, walk DOM to find links.
 */
function extractActivitiesFallback(bodyHtml, pageUrl) {
  const $ = cheerio.load(bodyHtml);
  const results = [];

  const labelElement = $('p, strong, b, h1, h2, h3, h4, h5, li, td, span')
    .filter(function () {
      const text = $(this).text();
      return (
        text.includes('Branch Activities:') ||
        text.includes('Branch Activities：') ||
        text.includes('Activities:') ||
        text.includes('Activities：')
      );
    })
    .last();

  if (labelElement.length) {
    const parentP = labelElement.closest('p');
    parentP.nextAll('ul').each((i, ulEl) => {
      $(ulEl).find('li a').each((j, aEl) => {
        const linkText = $(aEl).text().trim();
        const linkHref = $(aEl).attr('href');
        if (linkText && linkHref) {
          results.push({ url: linkHref, text: linkText });
        }
      });
    });
  }

  console.log(`[fallback] Found ${results.length} activity links via Cheerio:`);
  results.forEach(item => {
    console.log(`[fallback]   - url: ${item.url}`);
  });
  return results;
}

/**
 * Sleep for a given duration in milliseconds.
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Call Gemini with retry logic for rate limits (429/503).
 * Waits 60s between retries to respect the 15 RPM limit.
 */
async function geminiCallWithRetry(prompt, pageUrl = '') {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const waitTime = attempt === 1 ? 60000 : 120000;
      console.log(`[gemini] Rate limited, waiting ${waitTime / 1000}s before retry...`);
      await sleep(waitTime);
    }

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
      );

      // Handle rate limit (429) or server error (503)
      if (!response.ok) {
        if (response.status === 429 || response.status === 503) {
          console.log(`[gemini] Rate limited on attempt ${attempt + 1}, retrying...`);
          if (attempt < maxRetries - 1) continue;
          throw new Error(`Rate limit exceeded after ${maxRetries} attempts`);
        }
        throw new Error(`API error: ${response.status} ${await response.text()}`);
      }

      const data = await response.json();
      const candidate = data.candidates?.[0]?.content?.parts?.[0];
      return candidate?.text || '';
    } catch (error) {
      console.error(`[gemini] Call failed (attempt ${attempt + 1}): ${error.message}`);
      if (attempt < maxRetries - 1) {
        const waitTime = attempt === 1 ? 60000 : 120000;
        console.log(`[gemini] Waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
      } else {
        throw error;
      }
    }
  }

  throw new Error('Gemini API exhausted all retries');
}

/**
 * Gemini call: extract volunteer hours from ALL activity texts at once.
 * Accepts an array of { date, url, text } and returns [{ name, hours, date, sourceUrl }].
 * Uses retry logic to handle rate limits (15 RPM).
 * Falls back to regex if API key missing or fails.
 */
async function extractVolunteersBatched(activityTexts) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log('[gemini-vol] GEMINI_API_KEY not set, falling back to regex extraction');
    return extractVolunteersFallbackAll(activityTexts);
  }

  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

  // Build prompt with all activities, each numbered
  let promptParts = `Extract volunteer names and hours from ALL activity reports below.
Return ONLY a JSON array in this exact format: [{"name": "Full Name", "hours": 2.5, "date": "YYYY-MM-DD", "sourceUrl": "https://..."}].
If no volunteers are mentioned, return an empty array [].

Here are the activity reports (numbered for reference):
`;

  let totalTextLength = 0;
  let promptText = promptParts;

  for (let i = 0; i < activityTexts.length; i++) {
    const act = activityTexts[i];
    const truncated = act.text.slice(0, 5000);
    totalTextLength += truncated.length;
    promptText += `\n--- Activity ${i + 1} (${act.date}, ${act.sourceUrl}) ---\n${truncated}\n`;
  }

  console.log('[gemini-vol] === Batched volunteer extraction ===');
  console.log(`[gemini-vol] Model: ${model}`);
  console.log(`[gemini-vol] Activities to process: ${activityTexts.length}`);
  console.log(`[gemini-vol] Total text length: ${totalTextLength} chars`);

  try {
    // Wait before calling Gemini to stay within 15 RPM limit
    console.log('[gemini-vol] Waiting 5s to respect rate limit...');
    await sleep(5000);

    const raw = await geminiCallWithRetry(promptText);
    console.log(`[gemini-vol] Raw response: ${raw}`);

    const cleaned = raw.replace(/```json\n?/g, '').replace(/```/g, '').trim();
    const volunteers = JSON.parse(cleaned);
    console.log(`[gemini-vol] Extracted ${volunteers.length} volunteer records:`);
    volunteers.forEach(v => {
      console.log(`[gemini-vol]   - ${v.name}: ${v.hours} hours, date: ${v.date}`);
    });
    return Array.isArray(volunteers) ? volunteers : [];
  } catch (error) {
    console.error(`[gemini-vol] Failed: ${error.message}`);
    if (error.message.includes('Rate limit') || error.message.includes('429') || error.message.includes('503')) {
      throw new Error('Server busy, please wait a few minutes');
    }
    return extractVolunteersFallbackAll(activityTexts);
  }
}

/**
 * Regex fallback: extract volunteers from ALL activities.
 */
function extractVolunteersFallbackAll(activityTexts) {
  const results = [];
  const volunteerRegex = /([A-Z][a-zA-Z\s]+?)\s*(?:\(|:)?\s*([\d.]+)\s*(?:hours?|hrs?)\.?/gi;

  for (const act of activityTexts) {
    let match;
    while ((match = volunteerRegex.exec(act.text)) !== null) {
      const name = match[1].trim();
      const hours = parseFloat(match[2]);
      if (name && !isNaN(hours)) {
        results.push({ name, hours, date: act.date, sourceUrl: act.sourceUrl });
      }
    }
  }

  console.log(`[fallback-vol] Regex found ${results.length} volunteer records:`);
  results.forEach(r => {
    console.log(`[fallback-vol]   - ${r.name}: ${r.hours} hours, date: ${r.date}`);
  });
  return results;
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

  console.log('[date-filter] === Start ===');
  console.log(`[date-filter] Requested range: ${startDate} → ${endDate}`);
  console.log(`[date-filter] Parsed rangeStart: ${rangeStart}`);
  console.log(`[date-filter] Parsed rangeEnd: ${rangeEnd}`);
  console.log(`[date-filter] rangeStart valid: ${!!rangeStart}`);
  console.log(`[date-filter] rangeEnd valid: ${!!rangeEnd}`);
  console.log('[date-filter] === End ===');

  try {
    console.log('[timing] Fetching main page...');
    const mainHtml = await fetchHtml(url);
    const bodyHtml = cheerio.load(mainHtml)('body').html();
    let allLinks = extractAllLinks(bodyHtml);
    console.log(`[timing] Main page fetched: ${Date.now() - startTime}ms`);

    // Step 2: Gemini parses which links are activities and extracts dates
    console.log('[gemini-act] Waiting 2s before first Gemini call...');
    await sleep(2000);
    console.log(`[timing] Before Gemini activity extraction: ${Date.now() - startTime}ms`);
    let rawLinks = await extractActivitiesWithGemini(allLinks, url);

    // Step 3: Filter by date range
    let activitiesLinks = [];
    for (const link of rawLinks) {
      let dateStr = link.date;
      let parsed = new Date(dateStr);

      if (isNaN(parsed.getTime())) {
        console.log(`[date-filter] Invalid date "${dateStr}", skipping`);
        continue;
      }

      console.log(`[date-filter] Link: ${link.url}`);
      console.log(`[date-filter] Parsed date: ${dateStr}`);
      console.log(`[date-filter] linkDate valid: ${!isNaN(parsed.getTime())}`);
      if (rangeStart) {
        console.log(`[date-filter] linkDate >= rangeStart: ${parsed >= rangeStart}`);
      }
      if (rangeEnd) {
        console.log(`[date-filter] linkDate <= rangeEnd: ${parsed <= rangeEnd}`);
      }

      const inRange = (!rangeStart || parsed >= rangeStart) && (!rangeEnd || parsed <= rangeEnd);
      console.log(`[date-filter] → ${inRange ? 'IN RANGE' : 'OUT OF RANGE'}`);

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

    // Step 4: Fetch ALL activity pages and collect texts
    console.log(`[scrape] === Fetching ${activitiesLinks.length} activity pages ===`);
    console.log(`[timing] Before activity page fetching: ${Date.now() - startTime}ms`);
    let activityTexts = [];

    for (let i = 0; i < activitiesLinks.length; i++) {
      const link = activitiesLinks[i];
      try {
        console.log(`[scrape] Fetching ${i + 1}/${activitiesLinks.length}: ${link.url}`);
        console.log(`[timing] Starting fetch #${i + 1}: ${Date.now() - startTime}ms`);
        const detailHtml = await fetchHtml(link.url);
        console.log(`[timing] Fetch #${i + 1} done: ${Date.now() - startTime}ms`);
        const $detail = cheerio.load(detailHtml);
        const bodyText = $detail('body').text();
        console.log(`[scrape] ${link.url}: ${bodyText.length} chars`);

        activityTexts.push({
          url: link.url,
          date: link.date,
          text: bodyText
        });
      } catch (err) {
        console.error(`[scrape] Error fetching ${link.url}:`, err.message);
      }
    }

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
