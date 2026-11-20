'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('parseCommand: komutlar ve geçersizler', () => {
  const { handlers } = setup();
  assert.deepEqual(handlers.parseCommand('saldır Almanya'), { cmd: 'saldir', countryId: 'almanya' });
  assert.deepEqual(handlers.parseCommand('SALDIR ALMANYA!'), { cmd: 'saldir', countryId: 'almanya' });
  assert.deepEqual(handlers.parseCommand('savun Türkiye'), { cmd: 'savun', countryId: 'turkiye' });
  assert.equal(handlers.parseCommand('saldır'), null);
  assert.equal(handlers.parseCommand('saldır marsgezegeni'), null);
  assert.equal(handlers.parseCommand('merhaba herkese'), null);
  assert.deepEqual(handlers.parseCommand('ittifak ali'), { cmd: 'ittifak', arg: 'ali' });
});

test('geçersiz komut sessizce yok sayılır', () => {
  const { handlers } = setup();
  assert.equal(handlers.onChat({ userId: 'p1', name: 'P1', text: 'selam' }).handled, false);
});

test('komut oran sınırı: kullanıcı başına 3 sn', () => {
  const { handlers, clock } = setup();
  assert.equal(handlers.onChat({ userId: 'p1', name: 'P1', text: 'saldır almanya' }).handled, true);
  assert.equal(handlers.onChat({ userId: 'p1', name: 'P1', text: 'saldır fransa' }).reason, 'rate_limited');
  assert.equal(handlers.onChat({ userId: 'p2', name: 'P2', text: 'saldır fransa' }).handled, true); // başka kullanıcı serbest
  clock.advance(3001);
  assert.equal(handlers.onChat({ userId: 'p1', name: 'P1', text: 'saldır fransa' }).handled, true);
});

test('hediye dedupe: aynı eventId iki kez işlenmez', () => {
  const { handlers, engine } = setup();
  assert.equal(handlers.onGift({ eventId: 'g1', userId: 'p1', name: 'P1', coins: 5 }).handled, true);
  assert.equal(handlers.onGift({ eventId: 'g1', userId: 'p1', name: 'P1', coins: 5 }).reason, 'duplicate');
  assert.equal(engine.ownedBy('p1').length, 1);
});

test('"saldır X" sonrası büyük hediye saldırı olur, 30 sn sonra geçersiz', () => {
  const { handlers, engine, clock } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000);
  handlers.onChat({ userId: 'p2', name: 'P2', text: 'saldır türkiye' });
  const r = handlers.onGift({ eventId: 'g1', userId: 'p2', name: 'P2', coins: 100 });
  assert.equal(r.events[0].type, 'attack_started');
  // süresi geçmiş niyet: normal claim olur
  const { handlers: h2, engine: e2, clock: c2 } = setup();
  e2.claimCountry('p1', 'turkiye'); c2.advance(16000);
  h2.onChat({ userId: 'p2', name: 'P2', text: 'saldır türkiye' });
  c2.advance(31000);
  assert.equal(h2.onGift({ eventId: 'g2', userId: 'p2', name: 'P2', coins: 100 }).events[0].type, 'claim');
});

test('"savun X" + hediye savunma ekler', () => {
  const { handlers, engine, state } = setup();
  engine.claimCountry('p1', 'turkiye');
  handlers.onChat({ userId: 'p1', name: 'P1', text: 'savun türkiye' });
  handlers.onGift({ eventId: 'g1', userId: 'p1', name: 'P1', coins: 3 });
  assert.equal(state.defense.turkiye, 4);
});

test('beğeni ve takım komutu', () => {
  const { handlers, state } = setup();
  handlers.onLike({ userId: 'p1', name: 'P1', count: 40 });
  assert.equal(state.players.p1.soldiers, 2);
  handlers.onChat({ userId: 'p1', name: 'P1', text: 'takım mavi' });
  assert.equal(state.players.p1.team, 'c_mavi');
});

test('hata durumunda çökmez', () => {
  const { handlers } = setup();
  const r = handlers.onGift({ eventId: 'x', userId: 'p1', name: 'P1', coins: 'abc' });
  assert.ok(r); // exception fırlatmadı
});
