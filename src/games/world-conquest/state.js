'use strict';

function createState() {
  return {
    version: 1,
    round: 1,
    phase: 'intermission', // intermission | opening | battle | sprint | chaos
    timing: { roundStartedAt: null, intermissionEndsAt: null },
    players: {},
    joinCounter: 0,
    teamColors: {},
    owners: {},          // countryId -> playerId
    defense: {},         // countryId -> sayı
    protectedUntil: {},  // countryId -> ms
    gold: [],
    goldSet: false,
    attacks: {},
    attackSeq: 0,
    peaceUntil: 0,
    history: [],         // geçmiş tur kazananları
    stats: { attacksStarted: 0, attacksWon: 0, attacksFailed: 0 },
  };
}

function resetRoundState(state) {
  state.owners = {}; state.defense = {}; state.protectedUntil = {};
  state.gold = []; state.goldSet = false; state.attacks = {}; state.peaceUntil = 0;
  for (const p of Object.values(state.players)) { p.soldiers = 0; p.likeBuffer = 0; p.roundCoins = 0; }
}

module.exports = { createState, resetRoundState };
