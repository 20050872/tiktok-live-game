'use strict';
const nodeFs = require('fs');
const path = require('path');
const defaultConfig = require('./config');

function createRound({ engine, config = defaultConfig, now = Date.now, rng = Math.random, fs = nodeFs, statePath = config.persistence.statePath, onEvents = () => {}, logger = console }) {
  const st = engine.state;
  let tickTimer = null, saveTimer = null;

  const phaseAt = sec => (config.round.phases.find(p => sec >= p.from && sec < p.to) || config.round.phases[config.round.phases.length - 1]).name;
  const emit = events => { if (events.length) { try { onEvents(events); } catch (e) { logger.error('[wc] onEvents hata:', e); } } };

  function enterPhase(phase) {
    const events = [...engine.setPhase(phase).events];
    if (phase === 'chaos') {
      const pick = ['emperor', 'earthquake', 'peace'][Math.floor(rng() * 3)];
      events.push(...(pick === 'emperor' ? engine.chaosEmperor() : pick === 'earthquake' ? engine.earthquake() : engine.peace()).events);
    }
    return events;
  }

  function beginRound() {
    const events = engine.startRound().events;
    return events;
  }

  function tick() {
    const t = now();
    const events = [...engine.tick()];
    if (st.phase === 'intermission') {
      if (st.timing.intermissionEndsAt == null) st.timing.intermissionEndsAt = t + config.round.intermissionSec * 1000;
      if (t >= st.timing.intermissionEndsAt) events.push(...beginRound());
    } else {
      const elapsed = (t - st.timing.roundStartedAt) / 1000;
      if (elapsed >= config.round.durationSec) {
        events.push(...engine.endRound().events);
        st.timing.intermissionEndsAt = t + config.round.intermissionSec * 1000;
      } else {
        const want = phaseAt(elapsed);
        if (want !== st.phase) events.push(...enterPhase(want));
        if (!st.goldSet && elapsed >= config.round.goldStartSec) events.push(...engine.pickGold().events);
      }
    }
    emit(events);
    return events;
  }

  // Atomik kayıt: önce geçici dosya, sonra rename.
  function save() {
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      const tmp = `${statePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, statePath);
      return true;
    } catch (e) { logger.error('[wc] kayıt hatası:', e); return false; }
  }

  function load() {
    try {
      if (!fs.existsSync(statePath)) return false;
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!s || s.version !== 1 || !s.players) return false;
      engine.loadState(s);
      return true;
    } catch (e) { logger.error('[wc] kayıt okunamadı, sıfırdan başlıyorum:', e); return false; }
  }

  function start({ resume = true, timers = true } = {}) {
    const resumed = resume && load();
    if (!resumed) emit(beginRound());
    tick();
    if (timers) {
      tickTimer = setInterval(tick, config.persistence.tickMs);
      saveTimer = setInterval(save, config.persistence.saveIntervalMs);
    }
    return { resumed };
  }
  function stop() { clearInterval(tickTimer); clearInterval(saveTimer); save(); }

  return { start, stop, tick, save, load, beginRound };
}

module.exports = { createRound };
