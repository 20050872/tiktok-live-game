'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createEngine } = require('../engine');
const { createRound } = require('../round');
const { mulberry32 } = require('./helpers');

function make(statePath, clock) {
  const engine = createEngine({ now: () => clock.t, rng: mulberry32(3) });
  const events = [];
  const round = createRound({ engine, now: () => clock.t, rng: mulberry32(3), statePath, onEvents: e => events.push(...e), logger: { error() {} } });
  return { engine, round, events };
}

test('faz geçişleri, altın, tur sonu ve otomatik yeni tur', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  const clock = { t: 5_000_000 };
  const { engine, round, events } = make(path.join(dir, 's.json'), clock);
  round.start({ timers: false, resume: false });
  assert.equal(engine.state.phase, 'opening');
  const at = sec => { clock.t = 5_000_000 + sec * 1000; round.tick(); };
  engine.ensurePlayer({ id: 'a', name: 'A' }); engine.claimCountry('a', 'almanya');
  at(31); assert.equal(engine.state.phase, 'battle');
  at(211); assert.equal(engine.state.phase, 'sprint');
  at(241); assert.equal(engine.state.gold.length, 3);
  at(271); assert.equal(engine.state.phase, 'chaos');
  assert.ok(events.some(e => ['chaos_emperor', 'earthquake', 'peace'].includes(e.type)));
  at(301); assert.equal(engine.state.phase, 'intermission');
  assert.equal(events.filter(e => e.type === 'round_end').length, 1);
  assert.equal(engine.state.history[0].winnerId, 'a');
  at(322); assert.equal(engine.state.phase, 'opening'); assert.equal(engine.state.round, 2);
});

test('kayıt atomik yazılır ve kaldığı yerden devam eder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  const file = path.join(dir, 'state.json');
  const clock = { t: 9_000_000 };
  const a = make(file, clock);
  a.round.start({ timers: false, resume: false });
  a.engine.ensurePlayer({ id: 'a', name: 'Ali' }); clock.t += 40_000; a.round.tick();
  a.engine.claimCountry('a', 'malta');
  assert.ok(a.round.save());
  assert.equal(fs.existsSync(file + '.tmp'), false);
  const b = make(file, clock);
  assert.equal(b.round.start({ timers: false }).resumed, true);
  assert.equal(b.engine.state.owners.malta, 'a');
  assert.equal(b.engine.state.phase, 'battle');
});

test('bozuk kayıt dosyası çökertmez', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'));
  const file = path.join(dir, 'state.json'); fs.writeFileSync(file, '{bozuk');
  const clock = { t: 1 };
  const m = make(file, clock);
  assert.equal(m.round.start({ timers: false }).resumed, false);
  assert.equal(m.engine.state.phase, 'opening');
});
