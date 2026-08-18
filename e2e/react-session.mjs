import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const screenshotsDir = path.resolve(__dirname, '../e2e-screenshots');
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

let browser, context, page;

async function getPageSummary() {
  return await page.evaluate(() => {
    const title = document.title;
    const url = window.location.href;
    
    // Find visible buttons
    const buttons = Array.from(document.querySelectorAll('button'))
      .filter(b => b.offsetParent !== null)
      .map(b => ({
        text: (b.innerText || b.getAttribute('title') || b.getAttribute('aria-label') || '').trim().slice(0, 40),
        id: b.id || undefined,
        selector: b.id ? `#${b.id}` : undefined
      })).filter(b => b.text.length > 0).slice(0, 20);

    // Find visible inputs/textareas
    const inputs = Array.from(document.querySelectorAll('input, textarea'))
      .filter(i => i.offsetParent !== null)
      .map(i => ({
        tag: i.tagName.toLowerCase(),
        type: i.getAttribute('type') || undefined,
        placeholder: i.getAttribute('placeholder') || undefined,
        value: (i.value || '').slice(0, 40),
        id: i.id || undefined,
      }));

    // Find active headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
      .filter(h => h.offsetParent !== null)
      .map(h => h.innerText.trim())
      .filter(t => t.length > 0)
      .slice(0, 10);

    return { title, url, headings, buttons, inputs };
  });
}

async function start() {
  console.log('[SESSION] Starting Playwright Headed Browser...');
  browser = await chromium.launch({
    headless: false,
    slowMo: 300,
  });

  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });

  page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[PAGE_ERROR] ${msg.text()}`);
    }
  });

  console.log('[READY] Browser ready. Awaiting commands on STDIN.');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    console.log(`[EXEC] ${trimmed}`);
    const [cmd, ...args] = trimmed.split(' ');
    const argStr = args.join(' ');

    try {
      if (cmd === 'NAVIGATE') {
        await page.goto(argStr, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        console.log(`[OK] Navigated to ${argStr}`);
      } else if (cmd === 'CLICK') {
        await page.click(argStr);
        await page.waitForTimeout(800);
        console.log(`[OK] Clicked: ${argStr}`);
      } else if (cmd === 'CLICK_TEXT') {
        await page.click(`text=${argStr}`);
        await page.waitForTimeout(800);
        console.log(`[OK] Clicked text: ${argStr}`);
      } else if (cmd === 'TYPE') {
        const firstSpace = argStr.indexOf(' ');
        const selector = argStr.slice(0, firstSpace);
        const text = argStr.slice(firstSpace + 1);
        await page.fill(selector, text);
        await page.waitForTimeout(500);
        console.log(`[OK] Typed into ${selector}: "${text}"`);
      } else if (cmd === 'PRESS') {
        await page.keyboard.press(argStr);
        await page.waitForTimeout(800);
        console.log(`[OK] Pressed key: ${argStr}`);
      } else if (cmd === 'WAIT') {
        const ms = parseInt(argStr, 10) || 1000;
        await page.waitForTimeout(ms);
        console.log(`[OK] Waited ${ms}ms`);
      } else if (cmd === 'SNAPSHOT') {
        const shotName = argStr || `snap_${Date.now()}`;
        const filePath = path.join(screenshotsDir, `${shotName}.png`);
        await page.screenshot({ path: filePath });
        const summary = await getPageSummary();
        console.log(`[SNAPSHOT_SAVED] ${filePath}`);
        console.log(`[SUMMARY] ${JSON.stringify(summary)}`);
      } else if (cmd === 'INSPECT') {
        const summary = await getPageSummary();
        console.log(`[INSPECT_RESULT] ${JSON.stringify(summary, null, 2)}`);
      } else if (cmd === 'CLOSE' || cmd === 'EXIT') {
        await browser.close();
        console.log('[CLOSED] Browser closed.');
        process.exit(0);
      } else {
        console.log(`[ERR] Unknown command: ${cmd}`);
      }
    } catch (err) {
      console.log(`[ACTION_ERROR] ${err.message}`);
      const errPath = path.join(screenshotsDir, `error_${Date.now()}.png`);
      await page.screenshot({ path: errPath }).catch(() => {});
      console.log(`[ERROR_SNAPSHOT] ${errPath}`);
    }

    console.log('[READY] Awaiting next command.');
  });
}

start().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
