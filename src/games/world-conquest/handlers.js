'use strict';
const defaultConfig = require('./config');
const { findCountryByText, normalize } = require('./countries');

// Ağ/TikTok kütüphanesinden bağımsız: olayları basit nesne olarak alır.
//   onGift({ eventId, userId, name, coins })   coins = bu olay için TOPLAM coin (adet x birim)
//   onChat({ userId, name, text })
//   onLike({ userId, name, count })
function createHandlers({ engine, config = defaultConfig, now = Date.now, onEvents = () => {}, logger = console, dedupeLimit = 5000 }) {
  const seen = new Set();
  const seenQueue = [];
  const lastCmd = new Map();
  const intents = new Map(); // userId -> { type, countryId, at }

  function emit(result) { if (result?.events?.length) { try { onEvents(result.events); } catch (e) { logger.error('[wc] onEvents hata:', e); } } return result; }
  function safe(fn, label) {
    return (...a) => { try { return fn(...a); } catch (e) { logger.error(`[wc] ${label} hata:`, e); return { handled: false, reason: 'error' }; } };
  }
  function remember(key) {
    seen.add(key); seenQueue.push(key);
    if (seenQueue.length > dedupeLimit) seen.delete(seenQueue.shift());
  }
  function liveIntent(userId, type) {
    const it = intents.get(userId);
    return it && it.type === type && now() - it.at <= config.intentTtlMs ? it.countryId : undefined;
  }

  function parseCommand(text) {
    const n = normalize(text);
    const sp = n.indexOf(' ');
    if (sp < 0) return null;
    const cmd = n.slice(0, sp), rest = n.slice(sp + 1);
    if (cmd === 'saldir' || cmd === 'savun') {
      const c = findCountryByText(rest);
      return c ? { cmd, countryId: c.id } : null;
    }
    if (cmd === 'ittifak' || cmd === 'takim') return rest ? { cmd, arg: rest } : null;
    return null;
  }

  const onChat = safe(({ userId, name, text }) => {
    const c = parseCommand(text);
    if (!c) return { handled: false, reason: 'not_a_command' };
    const t = now();
    if (t - (lastCmd.get(userId) ?? -Infinity) < config.commandCooldownMs) return { handled: false, reason: 'rate_limited' };
    lastCmd.set(userId, t);
    engine.ensurePlayer({ id: userId, name });
    if (c.cmd === 'saldir') intents.set(userId, { type: 'attack', countryId: c.countryId, at: t });
    else if (c.cmd === 'savun') intents.set(userId, { type: 'defend', countryId: c.countryId, at: t });
    else if (c.cmd === 'ittifak') return { handled: true, ...emit(engine.allyWith(userId, c.arg)) };
    else if (c.cmd === 'takim') return { handled: true, ...emit(engine.setTeam(userId, c.arg)) };
    return { handled: true, ok: true, intent: c.cmd, countryId: c.countryId };
  }, 'onChat');

  const onGift = safe(({ eventId, userId, name, coins }) => {
    if (eventId != null) {
      if (seen.has(eventId)) return { handled: false, reason: 'duplicate' };
      remember(eventId);
    }
    engine.ensurePlayer({ id: userId, name });
    const ctx = {
      attackCountryId: liveIntent(userId, 'attack'),
      defendCountryId: liveIntent(userId, 'defend'),
    };
    return { handled: true, ...emit(engine.applyGift(userId, coins, ctx)) };
  }, 'onGift');

  const onLike = safe(({ userId, name, count }) => {
    engine.ensurePlayer({ id: userId, name });
    return { handled: true, ...emit(engine.applyLikes(userId, count)) };
  }, 'onLike');

  return { onChat, onGift, onLike, parseCommand };
}

module.exports = { createHandlers };
