'use strict';
const defaultConfig = require('./config');
const { COUNTRIES, normalize } = require('./countries');
const { createState, resetRoundState } = require('./state');

const TIER_CLASSES = {
  small: ['small'],
  medium: ['medium', 'small'],
  large: ['large', 'medium', 'small'],
  mega: ['capital', 'large', 'medium', 'small'],
};
const TIER_RANK = { small: 0, medium: 1, large: 2, mega: 3 };

function createEngine(opts = {}) {
  const config = opts.config || defaultConfig;
  const countries = opts.countries || COUNTRIES;
  const byId = new Map(countries.map(c => [c.id, c]));
  const now = opts.now || Date.now;
  const rng = opts.rng || Math.random;
  const state = opts.state || createState(config);

  const ev = (type, data = {}) => ({ type, at: now(), ...data });
  const r2 = n => Math.round(n * 100) / 100;
  const ok = (events = [], extra = {}) => ({ ok: true, reason: null, events, ...extra });
  const fail = reason => ({ ok: false, reason, events: [] });
  const pick = arr => arr[Math.floor(rng() * arr.length)];
  const shuffle = arr => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const nameOf = pid => (pid === 'CHAOS' ? 'Kaos İmparatoru' : state.players[pid]?.name ?? '?');
  const cName = cid => byId.get(cid)?.name ?? cid;
  const cValue = cid => config.classPoints[byId.get(cid).class] * (state.gold.includes(cid) ? config.goldMultiplier : 1);
  const ownedBy = pid => Object.keys(state.owners).filter(c => state.owners[c] === pid);
  const room = pid => Math.max(0, config.maxCountriesPerPlayer - ownedBy(pid).length);
  const allied = (a, b) => a === b || (!!state.players[a]?.team && state.players[a].team === state.players[b]?.team);

  // ---------- oyuncular ----------
  function ensurePlayer({ id, name }) {
    if (id == null) return null;
    let p = state.players[id];
    if (!p) {
      const n = state.joinCounter++;
      const palette = config.colors[n % config.colors.length];
      const color = n < config.colors.length ? palette.hex : `hsl(${Math.round((n * 137.5) % 360)} 70% 55%)`;
      p = state.players[id] = { id, name: name || String(id), color, team: null, soldiers: 0, likeBuffer: 0, coins: 0, roundCoins: 0, joinOrder: n };
    } else if (name) p.name = name;
    return p;
  }

  function setTeam(pid, colorText) {
    const p = state.players[pid]; if (!p) return fail('unknown_player');
    const c = config.colors.find(x => x.name === normalize(colorText));
    if (!c) return fail('unknown_color');
    const team = `c_${c.name}`;
    state.teamColors[team] = c.hex; p.team = team; p.color = c.hex;
    return ok([ev('team_joined', { playerId: pid, playerName: p.name, team: c.name })]);
  }

  function allyWith(pid, text) {
    const p = state.players[pid]; if (!p) return fail('unknown_player');
    const t = normalize(text);
    if (!t) return fail('empty');
    const target = Object.values(state.players).find(x => x.id !== pid && normalize(x.name) === t);
    if (!target) return setTeam(pid, text);
    const team = target.team || `t_${target.id}`;
    state.teamColors[team] = state.teamColors[team] || target.color;
    target.team = team; p.team = team; p.color = state.teamColors[team];
    return ok([ev('team_joined', { playerId: pid, playerName: p.name, team: target.name })]);
  }

  // ---------- puan ----------
  function getRanking() {
    const agg = {};
    for (const [cid, pid] of Object.entries(state.owners)) {
      const a = (agg[pid] = agg[pid] || { points: 0, countries: 0 });
      a.points += cValue(cid); a.countries++;
    }
    return Object.values(state.players).map(p => ({
      playerId: p.id, name: p.name, color: p.color, team: p.team,
      points: agg[p.id]?.points || 0, countries: agg[p.id]?.countries || 0,
      soldiers: p.soldiers, coins: p.roundCoins, order: p.joinOrder,
    })).sort((a, b) => b.points - a.points || b.countries - a.countries || a.order - b.order);
  }
  const getScores = () => getRanking().slice(0, 5);
  function leaderId() { const r = getRanking()[0]; return r && r.points > 0 ? r.playerId : null; }
  function isComeback(pid) {
    if (ownedBy(pid).length === 0) return true;
    const r = getRanking();
    return r.length >= 3 && r[r.length - 1].playerId === pid && r[0].points > r[r.length - 1].points;
  }
  function multiplier(pid) {
    return (state.phase === 'sprint' ? config.sprintMultiplier : 1) * (isComeback(pid) ? config.comebackMultiplier : 1);
  }

  // ---------- faz ----------
  function setPhase(phase) { state.phase = phase; return ok([ev('phase', { phase })]); }

  // ---------- sahiplik ----------
  function doClaim(pid, cid) {
    const cls = byId.get(cid).class;
    state.owners[cid] = pid;
    state.defense[cid] = config.startDefense[cls];
    state.protectedUntil[cid] = now() + config.protectMs;
    return [ev('claim', { playerId: pid, playerName: nameOf(pid), countryId: cid, countryName: cName(cid), class: cls })];
  }

  function claimCountry(pid, cid) {
    if (!state.players[pid]) return fail('unknown_player');
    if (!byId.has(cid)) return fail('unknown_country');
    if (!config.phaseRules.claimPhases.includes(state.phase)) return fail('claims_closed');
    if (state.owners[cid]) return fail('already_owned');
    if (room(pid) < 1) return fail('country_limit');
    return ok(doClaim(pid, cid));
  }

  // ---------- saldırı / savunma ----------
  function startAttack(attackerId, cid, power) {
    const chaos = attackerId === 'CHAOS';
    if (!chaos && !state.players[attackerId]) return fail('unknown_player');
    if (!byId.has(cid)) return fail('unknown_country');
    if (!chaos) {
      if (!config.phaseRules.attackPhases.includes(state.phase)) return fail('attacks_closed');
      if (now() < state.peaceUntil) return fail('peace');
    }
    const owner = state.owners[cid];
    if (!owner) return fail('no_owner');
    if (!chaos && allied(attackerId, owner)) return fail('own_country');
    if ((state.protectedUntil[cid] || 0) > now()) return fail('protected');
    if (!(power >= config.minAttackPower)) return fail('too_weak');
    const existing = Object.values(state.attacks).find(a => a.countryId === cid);
    if (existing) {
      if (chaos || existing.attackerId === 'CHAOS') return fail('already_under_attack');
      existing.power = r2(existing.power + power);
      existing.contributors[attackerId] = r2((existing.contributors[attackerId] || 0) + power);
      return ok([ev('attack_reinforced', { attackId: existing.id, attackerName: nameOf(attackerId), countryId: cid, countryName: cName(cid), power: existing.power })], { attackId: existing.id });
    }
    const id = `a${++state.attackSeq}`;
    state.attacks[id] = { id, attackerId, countryId: cid, power, contributors: { [attackerId]: power }, addedDefense: 0, startedAt: now(), resolveAt: now() + config.battleWindowMs };
    state.stats.attacksStarted++;
    return ok([ev('attack_started', { attackId: id, attackerId, attackerName: nameOf(attackerId), countryId: cid, countryName: cName(cid), ownerName: nameOf(owner), power, resolveAt: state.attacks[id].resolveAt })], { attackId: id });
  }

  function addDefense(pid, cid, power) {
    if (!state.players[pid]) return fail('unknown_player');
    const owner = state.owners[cid];
    if (!owner) return fail('no_owner');
    if (!allied(pid, owner)) return fail('not_ally');
    if (!(power > 0)) return fail('too_weak');
    const atk = Object.values(state.attacks).find(a => a.countryId === cid);
    if (atk) atk.addedDefense += power; else state.defense[cid] = (state.defense[cid] || 0) + power;
    return ok([ev('defense_added', { playerId: pid, playerName: nameOf(pid), countryId: cid, countryName: cName(cid), power })]);
  }

  function resolveAttack(attackId) {
    const a = state.attacks[attackId];
    if (!a) return fail('no_such_attack');
    delete state.attacks[attackId];
    const cid = a.countryId, owner = state.owners[cid];
    if (!owner) return fail('no_owner');
    let power = a.power;
    for (const pid of Object.keys(a.contributors)) {
      const c = state.players[pid];
      if (c && c.soldiers > 0) { power += c.soldiers; a.contributors[pid] += c.soldiers; c.soldiers = 0; }
    }
    const lead = Object.entries(a.contributors).sort((x, y) => y[1] - x[1])[0][0];
    let defense = (state.defense[cid] || 0) + a.addedDefense;
    const ow = state.players[owner];
    if (ow && ow.soldiers > 0) { defense += ow.soldiers; ow.soldiers = 0; }
    const leaderHit = leaderId() === owner;
    if (leaderHit) defense *= 1 - config.leaderAttackDiscount;
    const base = { attackId, attackerId: lead, attackerName: nameOf(lead), contributors: Object.keys(a.contributors).length, previousOwnerName: nameOf(owner), countryId: cid, countryName: cName(cid), power: r2(power), defense: r2(defense), leaderHit };
    if (power > defense) {
      if (lead === 'CHAOS') delete state.owners[cid]; else state.owners[cid] = lead;
      state.defense[cid] = config.startDefense[byId.get(cid).class];
      state.protectedUntil[cid] = now() + config.protectMs;
      state.stats.attacksWon++;
      return ok([ev('attack_won', base)], { won: true });
    }
    state.defense[cid] = Math.max(1, (state.defense[cid] || 1) - Math.floor(power / 2));
    state.stats.attacksFailed++;
    return ok([ev('attack_failed', base)], { won: false });
  }

  function tick() {
    const events = [];
    for (const a of Object.values(state.attacks)) if (a.resolveAt <= now()) events.push(...resolveAttack(a.id).events);
    return events;
  }

  // ---------- hediye ----------
  function tierOf(coin) {
    return config.giftTiers.find(t => coin >= t.min && (t.max == null || coin <= t.max))?.name || null;
  }
  function freeOfClasses(classes) {
    for (const cls of classes) {
      const l = countries.filter(c => c.class === cls && !state.owners[c.id]);
      if (l.length) return l;
    }
    return [];
  }
  function claimFree(pid, tier, preferId) {
    if (room(pid) < 1) return null;
    const allowed = TIER_CLASSES[tier];
    let cid = null;
    if (preferId && byId.has(preferId) && !state.owners[preferId] && allowed.includes(byId.get(preferId).class)) cid = preferId;
    else { const l = freeOfClasses(allowed); if (l.length) cid = pick(l).id; }
    return cid ? doClaim(pid, cid) : null;
  }
  function claimContinent(pid, preferId) {
    const free = countries.filter(c => !state.owners[c.id]);
    const want = Math.min(config.megaCount, room(pid));
    if (!free.length || want < 1) return null;
    const byCont = {};
    for (const c of free) (byCont[c.continent] = byCont[c.continent] || []).push(c);
    let cont = preferId && byId.has(preferId) && byCont[byId.get(preferId).continent] ? byId.get(preferId).continent : null;
    if (!cont) cont = Object.keys(byCont).sort((a, b) => byCont[b].length - byCont[a].length)[0];
    const byValue = list => shuffle(list).sort((a, b) => cValue(b.id) - cValue(a.id));
    const chosen = byValue(byCont[cont]).slice(0, want);
    if (chosen.length < want) {
      const rest = byValue(free.filter(c => !chosen.includes(c)));
      chosen.push(...rest.slice(0, want - chosen.length));
    }
    return chosen.flatMap(c => doClaim(pid, c.id));
  }
  function weakestOwn(pid) { return ownedBy(pid).sort((a, b) => (state.defense[a] || 0) - (state.defense[b] || 0))[0]; }
  function bestOwn(pid) { return ownedBy(pid).sort((a, b) => cValue(b) - cValue(a))[0]; }

  // ctx: { attackCountryId, defendCountryId, claimCountryId }
  function applyGift(pid, coin, ctx = {}) {
    const p = state.players[pid];
    if (!p) return fail('unknown_player');
    if (!config.phaseRules.claimPhases.includes(state.phase)) return fail('round_not_active');
    const tier = tierOf(coin);
    if (!tier) return fail('invalid_gift');
    p.coins += coin; p.roundCoins += coin;
    const mult = multiplier(pid);
    const power = r2(Math.min(config.maxGiftPower, (coin * mult) / config.coinsPerPower));
    const done = (events, extra = {}) => ok(events, { tier, power, ...extra });

    if (ctx.defendCountryId && state.owners[ctx.defendCountryId] && allied(pid, state.owners[ctx.defendCountryId])) {
      const r = addDefense(pid, ctx.defendCountryId, tier === 'small' ? Math.max(1, Math.round(config.smallDefenseBonus * mult)) : Math.max(1, power));
      if (r.ok) return done(r.events);
    }
    if (ctx.attackCountryId) {
      const r = startAttack(pid, ctx.attackCountryId, power);
      if (r.ok) return done(r.events, { attackId: r.attackId });
    }
    if (tier === 'mega') {
      const events = claimContinent(pid, ctx.claimCountryId);
      if (events) return done(events);
    } else {
      const events = claimFree(pid, tier, ctx.claimCountryId);
      if (events) return done(events);
    }
    // boş ülke kalmadıysa: kendini güçlendir
    if (tier === 'medium' || TIER_RANK[tier] >= TIER_RANK.large) {
      const cid = bestOwn(pid);
      if (cid) {
        state.protectedUntil[cid] = Math.max(state.protectedUntil[cid] || 0, now() + config.shieldMs);
        return done([ev('shield', { playerId: pid, playerName: p.name, countryId: cid, countryName: cName(cid) })]);
      }
    }
    const cid = weakestOwn(pid);
    if (cid) { const r = addDefense(pid, cid, Math.max(1, Math.round(config.smallDefenseBonus * mult))); return done(r.events); }
    return fail('no_target');
  }

  function applyLikes(pid, count) {
    const p = state.players[pid];
    if (!p) return fail('unknown_player');
    if (!(count > 0)) return fail('invalid_count');
    p.likeBuffer += count;
    const gained = Math.floor(p.likeBuffer / config.likesPerSoldier);
    p.likeBuffer -= gained * config.likesPerSoldier;
    p.soldiers += gained;
    return ok(gained ? [ev('soldiers', { playerId: pid, playerName: p.name, gained, total: p.soldiers })] : [], { gained });
  }

  // ---------- kaos olayları ----------
  function chaosEmperor() {
    const events = [ev('chaos_emperor', {})];
    const owners = [...new Set(Object.values(state.owners))];
    for (const o of owners) {
      const cands = ownedBy(o).filter(c => (state.protectedUntil[c] || 0) <= now() && !Object.values(state.attacks).some(a => a.countryId === c));
      if (cands.length) events.push(...startAttack('CHAOS', pick(cands), config.chaos.emperorPower).events);
    }
    return ok(events);
  }
  function earthquake() {
    const lid = leaderId();
    if (!lid) return ok([ev('earthquake', { playerName: null, lost: [] })]);
    const lost = shuffle(ownedBy(lid)).slice(0, config.chaos.quakeLoss);
    for (const c of lost) { delete state.owners[c]; delete state.defense[c]; }
    return ok([ev('earthquake', { playerName: nameOf(lid), lost: lost.map(cName) })]);
  }
  function peace() { state.peaceUntil = now() + config.chaos.peaceMs; return ok([ev('peace', { until: state.peaceUntil })]); }
  function pickGold() {
    state.gold = shuffle(countries).slice(0, config.goldCount).map(c => c.id);
    state.goldSet = true;
    return ok([ev('gold', { countries: state.gold.map(cName), ids: [...state.gold] })]);
  }

  // ---------- tur ----------
  function resolveAll() { const e = []; for (const id of Object.keys(state.attacks)) e.push(...resolveAttack(id).events); return e; }

  function endRound() {
    const events = resolveAll();
    const ranking = getRanking();
    const top = ranking[0];
    const winner = top && top.points > 0 ? top : null;
    const record = { round: state.round, winnerId: winner?.playerId ?? null, winnerName: winner?.name ?? null, points: winner?.points ?? 0, ranking: ranking.slice(0, 5) };
    state.history.push(record);
    events.push(ev('round_end', { round: state.round, winnerId: record.winnerId, winnerName: record.winnerName, points: record.points, ranking: record.ranking }));
    resetRoundState(state);
    state.phase = 'intermission';
    return ok(events, { winner: record, ranking });
  }

  function startRound() {
    state.round = state.history.length + 1;
    resetRoundState(state);
    state.phase = 'opening';
    state.timing.roundStartedAt = now();
    state.timing.intermissionEndsAt = null;
    return ok([ev('round_start', { round: state.round })]);
  }

  function snapshot() {
    const t = now();
    const r = config.round;
    let remainingSec = 0;
    if (state.phase === 'intermission') remainingSec = Math.max(0, Math.ceil(((state.timing.intermissionEndsAt || t) - t) / 1000));
    else remainingSec = Math.max(0, Math.ceil(r.durationSec - (t - state.timing.roundStartedAt) / 1000));
    return {
      now: t, round: state.round, phase: state.phase, remainingSec,
      peaceUntil: state.peaceUntil, gold: state.gold,
      owners: state.owners, defense: state.defense,
      protectedUntil: state.protectedUntil,
      players: Object.fromEntries(Object.values(state.players).map(p => [p.id, { id: p.id, name: p.name, color: p.color, team: p.team }])),
      attacks: Object.values(state.attacks).map(a => ({ id: a.id, countryId: a.countryId, attackerId: a.attackerId, attackerName: nameOf(a.attackerId), power: a.power, resolveAt: a.resolveAt })),
      top5: getScores(),
      lastWinner: state.history[state.history.length - 1] || null,
    };
  }

  return {
    config, state, countries, byId, now, rng,
    ensurePlayer, setTeam, allyWith,
    claimCountry, startAttack, addDefense, resolveAttack, tick,
    applyGift, applyLikes, getScores, getRanking, isComeback, tierOf,
    setPhase, startRound, endRound, resolveAll,
    chaosEmperor, earthquake, peace, pickGold,
    snapshot, ownedBy, allied,
    loadState(s) { for (const k of Object.keys(state)) delete state[k]; Object.assign(state, s); },
  };
}

module.exports = { createEngine };
