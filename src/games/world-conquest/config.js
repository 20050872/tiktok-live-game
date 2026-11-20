'use strict';
// Tüm oyun sayıları burada. Kodda sabit sayı yok.
module.exports = Object.freeze({
  round: {
    durationSec: 300,
    intermissionSec: 20,
    phases: [
      { name: 'opening', from: 0, to: 30 },
      { name: 'battle', from: 30, to: 210 },
      { name: 'sprint', from: 210, to: 270 },
      { name: 'chaos', from: 270, to: 300 },
    ],
    goldStartSec: 240, // son dakika: altın ülkeler
  },
  phaseRules: {
    claimPhases: ['opening', 'battle', 'sprint', 'chaos'],
    attackPhases: ['battle', 'sprint', 'chaos'],
  },
  giftTiers: [
    { name: 'small', min: 1, max: 9 },
    { name: 'medium', min: 10, max: 99 },
    { name: 'large', min: 100, max: 499 },
    { name: 'mega', min: 500, max: null },
  ],
  coinsPerPower: 20, // 100 coin = 5 saldırı gücü
  maxGiftPower: 12,  // tek hediyenin gücüne tavan (büyük cüzdan tek hamlede her şeyi ezemesin)
  maxCountriesPerPlayer: 8, // boş ülke alma sınırı; dolunca hediyeler savunmaya gider
  classPoints: { small: 1, medium: 2, large: 3, capital: 5 },
  startDefense: { small: 1, medium: 3, large: 5, capital: 8 },
  battleWindowMs: 10000,
  protectMs: 15000,
  shieldMs: 20000,
  minAttackPower: 0.25, // en az ~5 coin
  leaderAttackDiscount: 0.2, // lidere saldırı %20 ucuz (savunması x0.8)
  comebackMultiplier: 1.5,
  sprintMultiplier: 2,
  smallDefenseBonus: 1,
  megaCount: 3,
  goldMultiplier: 3,
  goldCount: 3,
  likesPerSoldier: 20,
  commandCooldownMs: 3000,
  intentTtlMs: 30000,
  chaos: { emperorPower: 4, quakeLoss: 2, peaceMs: 30000 },
  persistence: { saveIntervalMs: 5000, statePath: 'data/world-conquest-state.json', tickMs: 250 },
  colors: [
    { name: 'kirmizi', hex: '#e63946' }, { name: 'mavi', hex: '#3a86ff' },
    { name: 'yesil', hex: '#43aa8b' }, { name: 'sari', hex: '#f9c74f' },
    { name: 'mor', hex: '#9b5de5' }, { name: 'turuncu', hex: '#f8961e' },
    { name: 'pembe', hex: '#f15bb5' }, { name: 'turkuaz', hex: '#00bbf9' },
    { name: 'kahverengi', hex: '#a47148' }, { name: 'beyaz', hex: '#e9ecef' },
  ],
});
