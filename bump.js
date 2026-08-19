#!/usr/bin/env node

/**
 * Disboard Auto-Bumper v8 (Human-Like Cooldown Delay + Smart Scheduling)
 * Quando o cooldown de 2 horas termina, aguarda um atraso humano aleatório entre 8 e 12 minutos antes do bump.
 */

const { connect } = require('puppeteer-real-browser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let userConfig = {
  serverWhitelist: ["Macaquitos Brasilenõs", "Bryan Productions"],
  extraDelayMinMinutes: 8,
  extraDelayMaxMinutes: 12,
  clickDelayMin: 2000,
  clickDelayMax: 5000,
  retryAttempts: 3,
  retryDelayMinutes: 3
};

const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    userConfig = Object.assign({}, userConfig, JSON.parse(fs.readFileSync(configPath, 'utf8')));
  } catch (_) {}
}

const CONFIG = {
  dashboardUrl: 'https://disboard.org/pt-br/dashboard/servers',
  serverWhitelist: userConfig.serverWhitelist || ["Macaquitos Brasilenõs", "Bryan Productions"],
  extraDelayMinMinutes: userConfig.extraDelayMinMinutes ?? 8,
  extraDelayMaxMinutes: userConfig.extraDelayMaxMinutes ?? 12,
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
const NO_WAIT = process.argv.includes('--no-wait'); // Permite pular o atraso de 8-12m em testes manuais se desejar

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
    execSync(`DISPLAY=:0 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus notify-send "${title}" "${body}" 2>/dev/null || true`);
  } catch (_) {}
  log('NOTIFY', `${title}: ${body}`);
}

function isAllowed(serverName) {
  if (!CONFIG.serverWhitelist || CONFIG.serverWhitelist.length === 0) return true;
  return CONFIG.serverWhitelist.some(a =>
    serverName.toLowerCase().includes(a.toLowerCase()) ||
    a.toLowerCase().includes(serverName.toLowerCase())
  );
}

function getCookies() {
  try {
    const out = execSync(`python3 "${CONFIG.cookiesScript}"`, { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (err) {
    log('ERROR', `Falha ao extrair cookies: ${err.message}`);
    return [];
  }
}

function parseCooldownToSeconds(str) {
  if (!str) return 0;
  const match = str.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
}

async function doBumps(attempt = 1) {
  log('INFO', `=== Verificação de Servidores (tentativa ${attempt}/${CONFIG.retryAttempts}) ===`);
  log('INFO', `Servidores monitorados: ${CONFIG.serverWhitelist.join(', ')}`);
  log('INFO', `Atraso humano configurado pós-cooldown: ${CONFIG.extraDelayMinMinutes} a ${CONFIG.extraDelayMaxMinutes} minutos.`);

  const cookies = getCookies();
  if (!cookies || cookies.length === 0) {
    log('ERROR', 'Cookies não encontrados.');
    notify('Disboard Bumper ❌', 'Faça login no Disboard pelo navegador!');
    process.exit(1);
  }

  let browser;
  let page;
  try {
    log('INFO', 'Iniciando navegador com proteção Cloudflare...');
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

    await page.goto(CONFIG.dashboardUrl, { waitUntil: 'networkidle2', timeout: CONFIG.pageTimeout });

    if (page.url().includes('/login')) {
      log('ERROR', 'Sessão expirada. Faça login novamente no navegador.');
      notify('Disboard Bumper ⚠️', 'Sessão expirada no Disboard!');
      await browser.close();
      process.exit(2);
    }

    await new Promise(r => setTimeout(r, 2000));

    // Analisa servidores
    const serverStatuses = await page.evaluate(() => {
      const list = [];
      const cards = document.querySelectorAll('.server, .server-card, .column, [class*="server-item"], article, .card');

      cards.forEach(card => {
        const heading = card.querySelector('h1, h2, h3, h4, h5, .server-name, .title, strong');
        if (!heading) return;
        const name = heading.textContent.trim();

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

    log('INFO', `Status em tempo real:\n${JSON.stringify(serverStatuses, null, 2)}`);

    let bumpedCount = 0;
    let minWaitSeconds = 7200;

    for (const s of serverStatuses) {
      if (!isAllowed(s.name)) {
        log('INFO', `⏭️ Ignorando '${s.name}' (fora da lista)`);
        continue;
      }

      if (s.available) {
        // Gera o atraso humano aleatório entre 8 e 12 minutos
        const minMs = CONFIG.extraDelayMinMinutes * 60 * 1000;
        const maxMs = CONFIG.extraDelayMaxMinutes * 60 * 1000;
        const extraDelayMs = NO_WAIT ? 0 : Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
        const extraMinutes = (extraDelayMs / 60000).toFixed(1);

        if (extraDelayMs > 0) {
          log('INFO', `⏳ Cooldown de 2h finalizado para '${s.name}'!`);
          log('INFO', `🕒 Aguardando atraso humano aleatório de ${extraMinutes} minutos (entre ${CONFIG.extraDelayMinMinutes} e ${CONFIG.extraDelayMaxMinutes} min) para simular clique natural...`);
          await new Promise(r => setTimeout(r, extraDelayMs));
        }

        log('INFO', `🎯 Executando bump oficial em '${s.name}'...`);
        const microDelay = Math.floor(Math.random() * (CONFIG.clickDelayMax - CONFIG.clickDelayMin + 1)) + CONFIG.clickDelayMin;
        await new Promise(r => setTimeout(r, microDelay));

        if (!DRY_RUN) {
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

          log('INFO', `Aguardando processamento e confirmação...`);
          await new Promise(r => setTimeout(r, 12000));
        }

        bumpedCount++;
        log('INFO', `✅ BUMP OFICIAL CONCLUÍDO: '${s.name}'!`);
        notify('Disboard Bumper ✅', `Bump realizado em: ${s.name}!`);
      } else {
        const secs = parseCooldownToSeconds(s.cooldown);
        log('INFO', `⏳ '${s.name}': restam ${s.cooldown || 'calculando'} (~${Math.round(secs / 60)} min de cooldown)`);
        if (secs > 0 && secs < minWaitSeconds) {
          minWaitSeconds = secs;
        }
      }
    }

    fs.writeFileSync(CONFIG.statusFile, JSON.stringify({
      lastCheck: new Date().toISOString(),
      bumpedCount,
      servers: serverStatuses,
      nextCooldownSeconds: minWaitSeconds,
      extraDelayConfig: `${CONFIG.extraDelayMinMinutes}-${CONFIG.extraDelayMaxMinutes}min`
    }, null, 2));

    if (!fs.existsSync(CONFIG.screenshotsDir)) fs.mkdirSync(CONFIG.screenshotsDir, { recursive: true });
    const finalShot = path.join(CONFIG.screenshotsDir, `result-${Date.now()}.png`);
    await page.screenshot({ path: finalShot, fullPage: true });

    log('INFO', `Verificação concluída.`);
    await browser.close();

    return { bumpedCount, minWaitSeconds };

  } catch (err) {
    log('ERROR', `Erro: ${err.message}`);
    if (browser) await browser.close().catch(() => {});
    if (attempt < CONFIG.retryAttempts) {
      log('WARN', `Tentando novamente em ${CONFIG.retryDelay / 60000} minutos...`);
      await new Promise(r => setTimeout(r, CONFIG.retryDelay));
      return doBumps(attempt + 1);
    }
  }
}

(async () => {
  [CONFIG.logsDir, CONFIG.screenshotsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
  log('INFO', 'Iniciando Disboard Auto-Bumper Inteligente com Atraso Humano...');
  await doBumps();
})();
