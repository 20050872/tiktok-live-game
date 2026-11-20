'use strict';
const { createEngine } = require('../engine');
const { createHandlers } = require('../handlers');

function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

function setup(phase = 'battle', seed = 1) {
  const clock = { t: 1_000_000, advance(ms) { this.t += ms; } };
  const engine = createEngine({ now: () => clock.t, rng: mulberry32(seed) });
  for (const id of ['p1', 'p2', 'p3', 'p4']) engine.ensurePlayer({ id, name: id.toUpperCase() });
  engine.setPhase(phase);
  const silent = { error() {} };
  const handlers = createHandlers({ engine, now: () => clock.t, logger: silent });
  return { clock, engine, handlers, state: engine.state };
}
module.exports = { setup, mulberry32 };
