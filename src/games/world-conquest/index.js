'use strict';
// Oyunun giriş noktası. Registry'ye bağlama adapter'ı (adapter.js) bunu kullanır.
const config = require('./config');
const countries = require('./countries');
const { createEngine } = require('./engine');
const { createHandlers } = require('./handlers');
const { createRound } = require('./round');

function createGame(opts = {}) {
  const now = opts.now || Date.now;
  const rng = opts.rng || Math.random;
  const listeners = new Set();
  const onEvents = events => { for (const l of listeners) l(events); opts.onEvents?.(events); };
  const engine = createEngine({ config, now, rng });
  const handlers = createHandlers({ engine, config, now, onEvents, logger: opts.logger || console });
  const round = createRound({ engine, config, now, rng, onEvents, logger: opts.logger || console, statePath: opts.statePath || config.persistence.statePath, fs: opts.fs });
  return { id: 'world-conquest', engine, handlers, round, config, countries, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
}

module.exports = { createGame, id: 'world-conquest' };
