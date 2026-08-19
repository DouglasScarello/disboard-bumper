#!/usr/bin/env node

/**
 * Disboard Auto-Bumper
 * Intelligent, fully automated Disboard bumper with Cloudflare Turnstile bypass & Yii2 native form dispatch.
 */

const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Configuration Loader ────────────────────────────────────────────────────
let userConfig = { serverWhitelist: [] };
const configPath = path.join(__dirname, 'config.json');
const exampleConfigPath = path.join(__dirname, 'config.example.json');

if (fs.existsSync(configPath)) {
  try {
    userConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`[WARN] Failed to parse config.json: ${e.message}`);
  }
} else if (fs.existsSync(exampleConfigPath)) {
  try {
    userConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf8'));
  } catch (_) {}
}

const CONFIG = {
  dashboardUrl: 'https://disboard.org/dashboard/servers',
  serverWhitelist: userConfig.serverWhitelist || [],
  clickDelayMin: userConfig.clickDelayMin || 2000,
  clickDelayMax: userConfig.clickDelayMax || 5000,
  retryAttempts: userConfig.retryAttempts || 3,
  retryDelay: (userConfig.retryDelayMinutes || 3) * 60 * 1000,
  pageTimeout: 60000,
  logsDir: path.join(__dirname, 'logs'),
  screenshotsDir: path.join(__dirname, 'screenshots'),
  statusFile: path.join(__dirname, 'status.json'),
  cookiesScript: path.join(__dirname, 'extract-cookies.py'),
};

const DRY_RUN = process.argv.includes('--dry-run');
const serverArg = process.argv.find(a => a.startsWith('--server='));
const SERVER_OVERRIDE = serverArg ? [serverArg.split('=')[1].replace(/"/g, '')] : null;
const ACTIVE_WHITELIST = SERVER_OVERRIDE || CONFIG.serverWhitelist;

// ─── Logging & Notifications ────────────────────────────────────────────────
function log(level, msg) {
  const now = new Date().toISOString();
  const line = `[${now}] [${level}] ${msg}`;
  console.log(line);
  if (!fs.existsSync(CONFIG.logsDir)) fs.mkdirSync(CONFIG.logsDir, { recursive: true });
  const logFile = path.join(CONFIG.logsDir, `bump-${new Date().toISOString().slice(0, 10)}.log`);
  fs.appendFileSync(logFile, line + '\n');
}

function notify(title, body) {
  try {
    execSync(`notify-send "${title}" "${body}" 2>/dev/null || true`);
  } catch (_) {}
  log('NOTIFY', `${title}: ${body}`);
}

function isAllowed(serverName) {
  if (!ACTIVE_WHITELIST || ACTIVE_WHITELIST.length === 0) return true;
  return ACTIVE_WHITELIST.some(a =>
    serverName.toLowerCase().includes(a.toLowerCase()) ||
    a.toLowerCase().includes(serverName.toLowerCase())
  );
}

function getCookies() {
  try {
    const out = execSync(`python3 "${CONFIG.cookiesScript}"`, { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (err) {
    log('ERROR', `Failed to extract session cookies: ${err.message}`);
    return [];
  }
}

function parseCooldownToSeconds(str) {
  if (!str) return 0;
  const match = str.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
}

// ─── Main Bump Routine ───────────────────────────────────────────────────────
async function doBumps(attempt = 1) {
  log('INFO', `=== Starting Bump Cycle (attempt ${attempt}/${CONFIG.retryAttempts}) ===`);
  log('INFO', `Monitored Servers: ${ACTIVE_WHITELIST.length > 0 ? ACTIVE_WHITELIST.join(', ') : 'ALL (No Whitelist)'}`);

  const cookies = getCookies();
  if (!cookies || cookies.length === 0) {
    log('ERROR', 'No Disboard session cookies found. Please log in to Disboard in your browser first.');
    notify('Disboard Bumper ❌', 'Please log in to Disboard in your browser!');
    process.exit(1);
  }

  let browser;
  let page;
  try {
    log('INFO', 'Launching Real Browser with Cloudflare Turnstile handler...');
    const conn = await connect({
      headless: false,
      turnstile: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      connectOption: { defaultViewport: null }
    });
    browser = conn.browser;
    page = conn.page;

    for (const c of cookies) {
      try { await page.setCookie(c); } catch (_) {}
    }

    log('INFO', `Navigating to ${CONFIG.dashboardUrl}...`);
    await page.goto(CONFIG.dashboardUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });

    if (page.url().includes('/login')) {
      log('ERROR', 'Session expired. Please log in to Disboard again in your browser.');
      notify('Disboard Bumper ⚠️', 'Disboard session expired!');
      await browser.close();
      process.exit(2);
    }

    await new Promise(r => setTimeout(r, 2000));

    // Extract real-time status of all servers on dashboard
    const serverStatuses = await page.evaluate(() => {
      const list = [];
      const cards = document.querySelectorAll('.server, .server-card, .column, [class*="server-item"], article, .card');

      cards.forEach(card => {
        const heading = card.querySelector('h1, h2, h3, h4, h5, .server-name, .title, strong');
        if (!heading) return;
        const name = heading.textContent.trim();

        // Check for countdown timer (e.g. 01:45:20)
        const allText = card.innerText;
        const match = allText.match(/(\d{1,2}:\d{2}:\d{2})/);
        const cooldownText = match ? match[1] : null;

        const bumpBtn = card.querySelector('a.button-bump, a[href*="/server/bump/"]');
        const isAvailable = !!bumpBtn && !cooldownText;

        list.push({
          name,
          available: isAvailable,
          cooldown: cooldownText
        });
      });
      return list;
    });

    log('INFO', `Detected Servers Status:\n${JSON.stringify(serverStatuses, null, 2)}`);

    let bumpedCount = 0;
    let minWaitSeconds = 7200;

    for (const s of serverStatuses) {
      if (!isAllowed(s.name)) {
        log('INFO', `⏭️ Skipping '${s.name}' (not in whitelist)`);
        continue;
      }

      if (s.available) {
        log('INFO', `🎯 BUMP READY FOR '${s.name}'! Triggering...`);
        const delay = Math.floor(Math.random() * (CONFIG.clickDelayMax - CONFIG.clickDelayMin + 1)) + CONFIG.clickDelayMin;
        await new Promise(r => setTimeout(r, delay));

        if (!DRY_RUN) {
          // Native Yii2 jQuery dispatch for complete CSRF POST integration
          await page.evaluate((sName) => {
            document.querySelectorAll('a.button-bump').forEach(el => {
              const card = el.closest('.server, .server-card, .column, [class*="server-item"], article, .card') || el.parentElement;
              if (card && card.innerText.toLowerCase().includes(sName.toLowerCase())) {
                if (window.jQuery && window.yii && window.yii.handleAction) {
                  window.yii.handleAction(window.jQuery(el));
                } else {
                  el.click();
                }
              }
            });
          }, s.name);

          log('INFO', 'Waiting for Turnstile & Disboard confirmation...');
          await new Promise(r => setTimeout(r, 12000));
        }

        bumpedCount++;
        log('INFO', `✅ BUMP COMPLETED FOR '${s.name}'!`);
        notify('Disboard Bumper ✅', `Bump executed for: ${s.name}!`);
      } else {
        const secs = parseCooldownToSeconds(s.cooldown);
        log('INFO', `⏳ '${s.name}': remaining cooldown ${s.cooldown || 'calculating'} (~${Math.round(secs / 60)} min)`);
        if (secs > 0 && secs < minWaitSeconds) {
          minWaitSeconds = secs;
        }
      }
    }

    // Save status to local JSON
    fs.writeFileSync(CONFIG.statusFile, JSON.stringify({
      lastCheck: new Date().toISOString(),
      bumpedCount,
      servers: serverStatuses,
      nextCooldownSeconds: minWaitSeconds
    }, null, 2));

    if (!fs.existsSync(CONFIG.screenshotsDir)) fs.mkdirSync(CONFIG.screenshotsDir, { recursive: true });
    const finalShot = path.join(CONFIG.screenshotsDir, `result-${Date.now()}.png`);
    await page.screenshot({ path: finalShot, fullPage: true });

    log('INFO', `Cycle completed. Next suggested check in approx ${Math.round(minWaitSeconds / 60)} minutes.`);
    await browser.close();

    return { bumpedCount, minWaitSeconds };

  } catch (err) {
    log('ERROR', `Error during bump cycle: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    if (attempt < CONFIG.retryAttempts) {
      log('WARN', `Retrying in ${CONFIG.retryDelay / 60000} minutes...`);
      await new Promise(r => setTimeout(r, CONFIG.retryDelay));
      return doBumps(attempt + 1);
    }
  }
}

(async () => {
  [CONFIG.logsDir, CONFIG.screenshotsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
  log('INFO', 'Disboard Auto-Bumper started...');
  await doBumps();
})();
