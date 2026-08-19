#!/usr/bin/env node

/**
 * Disboard Auto-Bumper — Status ao Vivo em Tempo Real
 */

const fs = require('fs');
const path = require('path');

const statusFile = path.join(__dirname, 'status.json');
if (!fs.existsSync(statusFile)) {
  console.log('Nenhuma checagem foi realizada ainda. Rode `node bump.js` primeiro.');
  process.exit(0);
}

const data = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
const lastCheck = new Date(data.lastCheck);
const now = new Date();
const elapsedSeconds = Math.floor((now - lastCheck) / 1000);

console.log('═══════════════════════════════════════════════════════════');
console.log('         🤖 DISBOARD AUTO-BUMPER — STATUS AO VIVO         ');
console.log('═══════════════════════════════════════════════════════════');
console.log(`📡 Última verificação no Disboard: ${lastCheck.toLocaleTimeString('pt-BR')} (há ${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s atrás)`);
console.log('───────────────────────────────────────────────────────────');

function parseCooldown(str) {
  if (!str) return 0;
  const match = str.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  if (!match) return 0;
  return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
}

function formatSeconds(totalSecs) {
  if (totalSecs <= 0) {
    return '🟢 COOLDOWN DE 2H ZERADO! (Na fila para bump com atraso humano de 8-12m)';
  }
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `⏱️  ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} restantes`;
}

if (data.servers && Array.isArray(data.servers)) {
  data.servers.forEach(s => {
    const initialCooldown = parseCooldown(s.cooldown);
    const remainingSeconds = Math.max(0, initialCooldown - elapsedSeconds);
    console.log(`\n📌 Servidor: ${s.name}`);
    console.log(`   Status: ${formatSeconds(remainingSeconds)}`);
  });
}

console.log('\n───────────────────────────────────────────────────────────');
console.log('🔄 O timer do sistema acorda a cada 5 minutos.');
console.log('🕒 Regra de atraso: Aguarda 8 a 12 min após zerar antes do bump.');
console.log('═══════════════════════════════════════════════════════════\n');
