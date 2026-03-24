const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');

async function test() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  
  const url = 'https://aylus.org/lake-washington-wa/';
  console.log(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000); 
  
  const html = await page.content();
  fs.writeFileSync('C:/Users/hdyho/AppData/Local/Temp/aylus.html', html);
  console.log('HTML saved to C:/Users/hdyho/AppData/Local/Temp/aylus.html');
  
  await browser.close();
}

test().catch(console.error);
