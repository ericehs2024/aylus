const express = require('express');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve frontend static files built from ../frontend/dist
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));

/**
 * Helper to fetch a URL's fully rendered HTML using Playwright headless browser.
 * This waits for network idle and WAF (like Imperva Incapsula) verifications.
 * Reuses existing browser/page if passed, or launches a new one.
 */
async function scrapeWithPlaywright(url, existingPage = null) {
  let browser = null;
  let page = existingPage;

  if (!page) {
    const launchOptions = {
      headless: true,
      // Allow overriding the browser path via env var on servers
      // where Playwright can't auto-detect the binary location
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH && {
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH,
      }),
    };

    try {
      browser = await chromium.launch(launchOptions);
    } catch (launchErr) {
      throw new Error(
        'Chromium browser could not be launched. ' +
        'Run "npx playwright install chromium" on the server, ' +
        'or set PLAYWRIGHT_CHROMIUM_PATH to the browser executable. ' +
        'Detail: ' + launchErr.message
      );
    }

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    page = await context.newPage();
  }

  try {
    // Navigate and wait for network idle to ensure JS bundle is loaded
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    // Additional wait for Imperva WAF validation and custom page rendering
    await page.waitForTimeout(5000);

    // Extract fully rendered HTML
    return await page.content();
  } catch (error) {
    console.error(`Playwright error scraping ${url}:`, error.message);
    throw error;
  } finally {
    if (browser) {
      // Clean up browser instance if we created it inside this helper
      await browser.close();
    }
  }

}

app.use(cors());
app.use(express.json());

/**
 * Parses date from string like "March 15, 2026"
 */
function parseDate(text) {
  // const dateRegex = /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i;
  // const dateRegex = /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/i;
  // Matches formats like "Feb.25th,2026", "Feb 25, 2026", "February 25th, 2026"
  const dateRegex = /([A-Z][a-z]{2,8})\.?\s*(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})/i;
  const match = text.match(dateRegex);
  return match ? match[1] + " " + match[2] + ", " + match[3] : null;
}

/**
 * Extracts volunteer names and hours from text
 * Format: "Name: 2.5 hours" or "Name (4 hours)" etc.
 */
function extractVolunteers(text) {
  const results = [];
  // Matches patterns like:
  // "Name: 2.5 hours", "Name (2 hrs)", "Name: 3 Hours.", etc.
  // Group 1: Name
  // Group 2: Hours (number)
  const volunteerRegex = /([A-Z][a-zA-Z\s]+?)\s*(?:\(|:)?\s*([\d.]+)\s*(?:hours?|hrs?)\.?/gi;

  let match;
  while ((match = volunteerRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const hours = parseFloat(match[2]);
    if (name && !isNaN(hours)) {
      results.push({ name, hours });
    }
  }
  return results;
}

app.post('/api/scrape', async (req, res) => {
  const { url, startDate, endDate } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Parse optional date range bounds (inclusive on both ends)
  const rangeStart = startDate ? new Date(startDate) : null;
  const rangeEnd = endDate ? new Date(endDate) : null;

  let browser = null;

  try {
    // Launch a single shared browser context for this request to speed up
    // scraping the list page and its detail pages.
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const mainHtml = await scrapeWithPlaywright(url, page);
    const $ = cheerio.load(mainHtml);

    // Look for all urls after an "Activities" label.
    // NOTE: the live aylus.org site uses a full-width colon "：" (U+FF1A),
    // not a regular colon ":", so we must handle both variants.
    let activitiesLinks = [];

    // Match any element whose OWN text contains an Activities label
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
      // Walk up to the parent <p> tag that wraps the label (e.g. <p><span><strong>Branch Activities：</strong></span></p>)
      const parentP = labelElement.closest('p');

      // Then find the <ul> elements that are siblings AFTER that <p>,
      // and collect all <li><a> links inside them.
      parentP.nextAll('ul').each((i, ulEl) => {
        $(ulEl).find('li a').each((j, aEl) => {
          const linkText = $(aEl).text().trim();
          const linkHref = $(aEl).attr('href');
          const dateStr = parseDate(linkText);

          if (dateStr && linkHref) {
            // Apply date range filter when the caller supplies startDate / endDate
            const linkDate = new Date(dateStr);
            const inRange =
              (!rangeStart || linkDate >= rangeStart) &&
              (!rangeEnd || linkDate <= rangeEnd);

            if (inRange) {
              activitiesLinks.push({
                url: linkHref.startsWith('http') ? linkHref : new URL(linkHref, url).href,
                date: dateStr,
                text: linkText
              });
            }
          }
        });
      });
    }

    // Process each link to get volunteer hours
    const allRecords = [];

    for (const link of activitiesLinks) {
      try {
        console.log(`Scraping detail link: ${link.url}`);
        const detailHtml = await scrapeWithPlaywright(link.url, page);
        const $detail = cheerio.load(detailHtml);

        // Extract text from the page. Often volunteer info is in paragraph or list
        const bodyText = $detail('body').text();
        const volunteers = extractVolunteers(bodyText);

        volunteers.forEach(v => {
          allRecords.push({
            name: v.name,
            hours: v.hours,
            date: link.date,
            sourceUrl: link.url
          });
        });
      } catch (err) {
        console.error(`Error fetching ${link.url}:`, err.message);
      }
    }

    res.json({
      success: true,
      data: allRecords
    });

  } catch (error) {
    console.error('Scraping error:', error.message);
    res.status(500).json({ error: 'Failed to scrape the website: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
