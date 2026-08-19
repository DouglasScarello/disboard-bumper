#!/usr/bin/env node

/**
 * Disboard Auto-Bumper — Status Determinístico ao Vivo
 */

const fs = require('fs');
const path = require('path');

const scheduleFile = path.join(__dirname, 'schedule.json');

if (!fs.existsSync(scheduleFile)) {
  console.log('Nenhum agendamento ativo ainda. Executando primeira sincronização...');
  try {
    const { execSync } = require('child_process');
    execSync(`node "${path.join(__dirname, 'bump.js')}" --sync`, { stdio: 'inherit' });
  } catch (_) {}
}

let schedule = { servers: {} };
try {
  schedule = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
} catch (_) {}

const now = Date.now();

console.log('═══════════════════════════════════════════════════════════════════');
console.log('               🤖 DISBOARD AUTO-BUMPER — STATUS AO VIVO            ');
console.log('═══════════════════════════════════════════════════════════════════');

function formatSeconds(totalSecs) {
  if (totalSecs <= 0) return '⚡ NO HORÁRIO DO BUMP! (Disparando agora)';
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = totalSecs % 60;
  return `⏱️  ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} restantes`;
}

const servers = Object.values(schedule.servers || {});

if (servers.length === 0) {
  console.log('Nenhum servidor sincronizado. Execute: disboard-sync');
} else {
  // Ordena pelo próximo que vai dar bump
  servers.sort((a, b) => a.nextBumpTimestamp - b.nextBumpTimestamp);

  servers.forEach(s => {
    const remainingSeconds = Math.max(0, Math.floor((s.nextBumpTimestamp - now) / 1000));
    const targetDate = new Date(s.nextBumpTimestamp);
    const timeFormatted = targetDate.toLocaleTimeString('pt-BR');

    console.log(`\n📌 Servidor: ${s.name}`);
    console.log(`   Status:       ${formatSeconds(remainingSeconds)}`);
    console.log(`   Próximo Bump: Agendado para às ${timeFormatted}`);
  });
}

console.log('\n───────────────────────────────────────────────────────────────────');
console.log('⚙️  Modo Inteligente: O robô só abre o navegador no horário exato.');
console.log('═══════════════════════════════════════════════════════════════════\n');
