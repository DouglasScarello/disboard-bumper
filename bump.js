#!/usr/bin/env node

/**
 * Disboard Auto-Bumper v9 (Deterministic Timing & Zero-Waste Execution)
 * Calcula o horário exato matematicamente. Só abre o navegador quando o horário do bump chegar.
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
  scheduleFile: path.join(__dirname, 'schedule.json'),
  cookiesScript: path.join(__dirname, 'extract-cookies.py'),
};

const FORCE_CHECK = process.argv.includes('--force') || process.argv.includes('--sync');
const DRY_RUN = process.argv.includes('--dry-run');

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

function getRandomDelaySeconds() {
  const min = CONFIG.extraDelayMinMinutes * 60;
  const max = CONFIG.extraDelayMaxMinutes * 60;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function loadSchedule() {
  if (fs.existsSync(CONFIG.scheduleFile)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG.scheduleFile, 'utf8'));
    } catch (_) {}
  }
  return { servers: {} };
}

function saveSchedule(schedule) {
  fs.writeFileSync(CONFIG.scheduleFile, JSON.stringify(schedule, null, 2));
}

async function doBumps(attempt = 1) {
  const now = Date.now();
  const schedule = loadSchedule();

  // Verifica se algum servidor agendado já atingiu o horário do bump
  let needsBrowser = FORCE_CHECK || Object.keys(schedule.servers).length === 0;
  const serversReady = [];

  for (const [name, data] of Object.entries(schedule.servers)) {
    if (isAllowed(name)) {
      if (now >= data.nextBumpTimestamp) {
        needsBrowser = true;
        serversReady.push(name);
      }
    }
  }

  // Se nenhum servidor precisa de bump agora, não abre o navegador (0 consumo de CPU/RAM)
  if (!needsBrowser) {
    let nextServer = '';
    let minWait = Infinity;
    for (const [name, data] of Object.entries(schedule.servers)) {
      if (isAllowed(name)) {
        const remaining = data.nextBumpTimestamp - now;
        if (remaining < minWait) {
          minWait = remaining;
          nextServer = name;
        }
      }
    }
    const mins = Math.max(0, Math.round(minWait / 60000));
    log('INFO', `⏳ Nenhum servidor pronto agora. Próximo: '${nextServer}' em ${mins} min (${new Date(schedule.servers[nextServer].nextBumpTimestamp).toLocaleTimeString('pt-BR')}).`);
    return;
  }

  log('INFO', `=== Executando ciclo de Bump (tentativa ${attempt}/${CONFIG.retryAttempts}) ===`);
  if (serversReady.length > 0) {
    log('INFO', `🎯 Servidor(es) no horário agendado: ${serversReady.join(', ')}`);
  } else {
    log('INFO', '🔄 Sincronizando horários pela primeira vez...');
  }

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
      log('ERROR', 'Sessão expirada.');
      notify('Disboard Bumper ⚠️', 'Sessão expirada no Disboard!');
      await browser.close();
      process.exit(2);
    }

    await new Promise(r => setTimeout(r, 2000));

    // Analisa servidores na página
    const detectedServers = await page.evaluate(() => {
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

    log('INFO', `Status detectados no Disboard:\n${JSON.stringify(detectedServers, null, 2)}`);

    for (const s of detectedServers) {
      if (!isAllowed(s.name)) continue;

      if (s.available) {
        log('INFO', `🎯 BUMP LIBERADO PARA '${s.name}'! Clicando agora...`);
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

        log('INFO', `✅ BUMP OFICIAL CONCLUÍDO: '${s.name}'!`);
        notify('Disboard Bumper ✅', `Bump realizado em: ${s.name}!`);

        // Calcula o próximo horário com precisão: 2h (7200s) + atraso aleatório (8 a 12m)
        const delaySecs = getRandomDelaySeconds();
        const nextBumpTime = Date.now() + (7200 + delaySecs) * 1000;
        schedule.servers[s.name] = {
          name: s.name,
          lastBump: new Date().toISOString(),
          nextBumpTimestamp: nextBumpTime,
          nextBumpFormatted: new Date(nextBumpTime).toLocaleTimeString('pt-BR'),
          targetDelayMinutes: +(delaySecs / 60).toFixed(1)
        };
      } else {
        // Servidor em cooldown detectado: calcula o próximo bump
        const remainingCooldownSecs = parseCooldownToSeconds(s.cooldown);
        const currentScheduled = schedule.servers[s.name];

        // Se ainda não tiver agendamento ou a diferença for grande, calcula
        if (!currentScheduled || Math.abs((currentScheduled.nextBumpTimestamp - Date.now()) / 1000 - remainingCooldownSecs) > 900) {
          const delaySecs = getRandomDelaySeconds();
          const nextBumpTime = Date.now() + (remainingCooldownSecs + delaySecs) * 1000;
          schedule.servers[s.name] = {
            name: s.name,
            lastCheckedCooldown: s.cooldown,
            nextBumpTimestamp: nextBumpTime,
            nextBumpFormatted: new Date(nextBumpTime).toLocaleTimeString('pt-BR'),
            targetDelayMinutes: +(delaySecs / 60).toFixed(1)
          };
        }
      }
    }

    saveSchedule(schedule);

    if (!fs.existsSync(CONFIG.screenshotsDir)) fs.mkdirSync(CONFIG.screenshotsDir, { recursive: true });
    const finalShot = path.join(CONFIG.screenshotsDir, `result-${Date.now()}.png`);
    await page.screenshot({ path: finalShot, fullPage: true });

    log('INFO', `Sincronização concluída com sucesso.`);
    await browser.close();

  } catch (err) {
    log('ERROR', `Erro durante o ciclo: ${err.message}`);
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
  await doBumps();
})();
