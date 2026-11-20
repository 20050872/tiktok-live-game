#!/usr/bin/env node
'use strict';
// Kullanım: node scripts/simulate-world-conquest.js --players 30 --rounds 3 [--seed 1] [--serve --speed 10 --port 3000]
// Varsayılan mod: sahte saatle baştan sona hızlıca oynar, denge raporu basar.
// --serve: gerçek zamanda (speed ile hızlandırılmış) oynar ve overlay'i http://localhost:PORT/overlay adresinde gösterir.
const path = require('path');
const { createGame } = require('../src/games/world-conquest');
const { findCountryByText } = require('../src/games/world-conquest/countries');
const { mulberry32 } = require('../src/games/world-conquest/tests/helpers');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => (x.startsWith('--') ? [...a, [x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]] : a), []));
const PLAYERS = +args.players || 30, ROUNDS = +args.rounds || 3, SPEED = +args.speed || 10, SEED = +args.seed || 1, PORT = +args.port || 3000;
const rng = mulberry32(SEED);
const clock = { t: 10_000_000 };
const silent = { error: console.error, log() {} };

const stats = { rounds: [], attacksWon: 0, attacksFailed: 0 };
const game = createGame({ now: () => clock.t, rng, logger: silent, statePath: path.join(require('os').tmpdir(), `wc-sim-${process.pid}.json`) });
const { engine, handlers, round, config } = game;

// Bot profilleri: 0 = balina (büyük hediye), %20 orta, kalan küçük.
const bots = Array.from({ length: PLAYERS }, (_, i) => ({
  id: `u${i}`, name: i === 0 ? 'Balina' : `Oyuncu${i}`,
  kind: i === 0 ? 'whale' : i < PLAYERS * 0.25 ? 'mid' : 'small',
}));
const rate = { whale: 0.12, mid: 0.06, small: 0.09 }; // saniyede hediye olasılığı
const coinsOf = { whale: () => 100 + Math.floor(rng() * 400), mid: () => 10 + Math.floor(rng() * 90), small: () => 1 + Math.floor(rng() * 9) };
let giftSeq = 0;
const roundCoins = {};

game.subscribe(events => {
  for (const e of events) {
    if (e.type === 'attack_won') stats.attacksWon++;
    if (e.type === 'attack_failed') stats.attacksFailed++;
    if (e.type === 'round_end') {
      const coins = Object.values(engine.state.players).map(p => [p.id, roundCoins[p.id] || 0]).sort((a, b) => b[1] - a[1]);
      stats.rounds.push({ round: e.round, winner: e.winnerName, winnerId: e.winnerId, top: e.ranking, topGifter: coins[0]?.[0] });
      for (const k of Object.keys(roundCoins)) delete roundCoins[k];
    }
  }
});

function ownedNames(excludeId) {
  const s = engine.state; const out = [];
  for (const [cid, pid] of Object.entries(s.owners)) if (pid !== excludeId) out.push(cid);
  return out;
}

function stepBots(dtSec) {
  for (const b of bots) {
    if (rng() < 0.01 * dtSec) handlers.onLike({ userId: b.id, name: b.name, count: 20 + Math.floor(rng() * 60) });
    if (rng() > rate[b.kind] * dtSec) continue;
    if (['battle', 'sprint', 'chaos'].includes(engine.state.phase) && rng() < 0.45) {
      // izleyiciler gerçekte ağırlıklı olarak lideri hedef alır (%60), kalanı rastgele
      const lead = engine.getScores()[0];
      const leaderTargets = lead && lead.playerId !== b.id && lead.points > 0 ? engine.ownedBy(lead.playerId) : [];
      const targets = rng() < 0.6 && leaderTargets.length ? leaderTargets : rng() < 0.5 ? ownedNames(b.id) : [];
      const defendMine = !targets.length || rng() < 0.3;
      const mine = engine.ownedBy(b.id);
      if (defendMine && mine.length) handlers.onChat({ userId: b.id, name: b.name, text: `savun ${engine.byId.get(mine[0]).name}` });
      else if (targets.length) { const c = engine.byId.get(targets[Math.floor(rng() * targets.length)]); handlers.onChat({ userId: b.id, name: b.name, text: `saldır ${c.name}` }); }
    }
    const coins = coinsOf[b.kind]();
    roundCoins[b.id] = (roundCoins[b.id] || 0) + coins;
    handlers.onGift({ eventId: `g${++giftSeq}`, userId: b.id, name: b.name, coins });
  }
}

function report() {
  console.log(`\n=== Dünya İstilası simülasyon raporu (${PLAYERS} oyuncu, ${stats.rounds.length} tur, seed ${SEED}) ===`);
  for (const r of stats.rounds) {
    const dist = r.top.map(x => `${x.name}:${x.points}`).join('  ');
    console.log(`Tur ${r.round}: kazanan ${r.winner ?? '-'} | ${dist}`);
  }
  const whaleWins = stats.rounds.filter(r => r.winnerId === 'u0').length;
  const topGifterWins = stats.rounds.filter(r => r.winnerId && r.winnerId === r.topGifter).length;
  const total = stats.attacksWon + stats.attacksFailed;
  const rate1 = stats.rounds.length ? topGifterWins / stats.rounds.length : 0;
  console.log(`Saldırılar: ${stats.attacksWon} başarılı / ${stats.attacksFailed} başarısız${total ? ` (%${Math.round(100 * stats.attacksWon / total)} başarı)` : ''}`);
  console.log(`En çok hediye atanın kazanma oranı: %${Math.round(rate1 * 100)} (balina: %${Math.round(100 * whaleWins / Math.max(1, stats.rounds.length))})`);
  if (rate1 > 0.6) console.log('DENGE UYARISI: en çok hediye atan turların %60\'ından fazlasını kazanıyor.');
  else console.log('Denge: tamam (eşik %60).');
}

if (args.serve) {
  const { createOverlayServer } = require('../src/games/world-conquest/server');
  let last = Date.now();
  round.start({ resume: false, timers: false });
  createOverlayServer({ game, port: PORT });
  console.log(`Overlay: http://localhost:${PORT}/overlay  (hız x${SPEED}, durdurmak için Ctrl+C)`);
  setInterval(() => { const n = Date.now(); const dt = (n - last) * SPEED; last = n; clock.t += dt; stepBots(dt / 1000); round.tick(); }, 200);
} else {
  round.start({ resume: false, timers: false });
  while (stats.rounds.length < ROUNDS) { clock.t += 1000; stepBots(1); round.tick(); }
  report();
}
