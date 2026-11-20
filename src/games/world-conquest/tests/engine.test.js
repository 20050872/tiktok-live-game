'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('./helpers');

test('claim: sahipsiz ülke alınır, ikinci kez alınamaz', () => {
  const { engine, state } = setup();
  assert.ok(engine.claimCountry('p1', 'malta').ok);
  assert.equal(state.owners.malta, 'p1');
  assert.equal(engine.claimCountry('p2', 'malta').reason, 'already_owned');
});

test('yeni alınan ülke 15 sn korumalı', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'malta');
  assert.equal(engine.startAttack('p2', 'malta', 10).reason, 'protected');
  clock.advance(15001);
  assert.ok(engine.startAttack('p2', 'malta', 10).ok);
});

test('saldırı başarılı: güç > savunma ise ülke el değiştirir', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'malta'); clock.advance(16000);
  engine.startAttack('p2', 'malta', 3);
  clock.advance(10000);
  const ev = engine.tick();
  assert.equal(state.owners.malta, 'p2');
  assert.equal(ev[0].type, 'attack_won');
});

test('saldırı başarısız: ülke kalır, savunma düşer', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'almanya'); clock.advance(16000); // savunma 8
  engine.startAttack('p2', 'almanya', 2);
  clock.advance(10000);
  const ev = engine.tick();
  assert.equal(state.owners.almanya, 'p1');
  assert.equal(state.defense.almanya, 7);
  assert.equal(ev[0].type, 'attack_failed');
});

test('eşit güç kazanmaz (güç > savunma şart)', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p3', 'cin'); // p3 lider olsun ki lider cezası devreye girmesin
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000); // savunma 3
  engine.startAttack('p2', 'turkiye', 3); clock.advance(10000); engine.tick();
  assert.equal(state.owners.turkiye, 'p1');
});

test('savunma ekleme: sadece sahibi/müttefiki, ve saldırıyı bozar', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000);
  engine.startAttack('p2', 'turkiye', 4);
  assert.equal(engine.addDefense('p3', 'turkiye', 5).reason, 'not_ally');
  assert.ok(engine.addDefense('p1', 'turkiye', 2).ok); // 3+2=5 > 4
  clock.advance(10000); engine.tick();
  assert.equal(state.owners.turkiye, 'p1');
});

test('müttefik savunma ekleyebilir', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000);
  assert.ok(engine.setTeam('p1', 'mavi').ok); assert.ok(engine.setTeam('p3', 'mavi').ok);
  assert.ok(engine.addDefense('p3', 'turkiye', 2).ok);
});

test('kendi/müttefik ülkesine saldırılamaz', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000);
  assert.equal(engine.startAttack('p1', 'turkiye', 5).reason, 'own_country');
  engine.setTeam('p1', 'mavi'); engine.setTeam('p2', 'mavi');
  assert.equal(engine.startAttack('p2', 'turkiye', 5).reason, 'own_country');
});

test('lider cezası: lidere saldırı %20 ucuz', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'almanya'); engine.claimCountry('p2', 'malta'); clock.advance(16000);
  // p1 lider (5 puan). savunma 8 x0.8 = 6.4, güç 7 yeter.
  engine.startAttack('p2', 'almanya', 7); clock.advance(10000);
  assert.equal(engine.tick()[0].leaderHit, true);
  assert.equal(state.owners.almanya, 'p2');
});

test('lider değilse aynı güç yetmez', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p3', 'cin'); engine.claimCountry('p3', 'malta'); engine.claimCountry('p1', 'almanya'); clock.advance(16000); // p3 = 6 puan lider, p1 = 5
  engine.startAttack('p2', 'almanya', 7); clock.advance(10000);
  assert.equal(engine.tick()[0].leaderHit, false);
  assert.equal(state.owners.almanya, 'p1');
});

test('geri dönüş bonusu: ülkesizin hediyesi x1.5', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'turkiye'); engine.claimCountry('p3', 'malta'); clock.advance(16000);
  const a = engine.applyGift('p2', 100, { attackCountryId: 'turkiye' }); // ülkesiz: 100*1.5/20 = 7.5
  assert.equal(a.power, 7.5);
  const b = engine.applyGift('p3', 100, { attackCountryId: 'fransa' }); // fransa sahipsiz -> claim, güç sadece bilgi
  assert.equal(b.power, 5);
});

test('son sprint: hediye etkisi x2', () => {
  const { engine, clock } = setup('sprint');
  engine.claimCountry('p1', 'turkiye'); engine.claimCountry('p3', 'malta'); engine.claimCountry('p4', 'kenya'); clock.advance(16000);
  assert.equal(engine.applyGift('p3', 100, { attackCountryId: 'turkiye' }).power, 10);
});

test('hediye seviyeleri: küçük->küçük ülke, orta->orta ülke, büyük->büyük ülke', () => {
  const { engine, state } = setup();
  const cls = pid => engine.ownedBy(pid).map(c => engine.byId.get(c).class);
  engine.applyGift('p1', 5); assert.deepEqual(cls('p1'), ['small']);
  engine.applyGift('p2', 50); assert.deepEqual(cls('p2'), ['medium']);
  engine.applyGift('p3', 200); assert.deepEqual(cls('p3'), ['large']);
});

test('küçük hediye: ülkesi varsa ve boş küçük yoksa +1 savunma', () => {
  const { engine, state } = setup();
  engine.countries.filter(c => c.class === 'small').forEach((c, i) => engine.claimCountry(['p2', 'p3', 'p4'][i % 3], c.id));
  engine.claimCountry('p1', 'turkiye');
  const before = state.defense.turkiye;
  engine.applyGift('p1', 3);
  assert.ok(state.defense.turkiye > before); // p1 sonuncu: geri dönüş bonusuyla +2 de olabilir
});

test('mega hediye aynı kıtada 3 ülke alır', () => {
  const { engine } = setup();
  const r = engine.applyGift('p1', 500, { claimCountryId: 'brezilya' });
  assert.ok(r.ok);
  const owned = engine.ownedBy('p1');
  assert.equal(owned.length, 3);
  assert.ok(owned.every(c => engine.byId.get(c).continent === 'samerica'));
});

test('beğeni: 20 beğeni = 1 asker puanı, kalan birikir', () => {
  const { engine, state } = setup();
  assert.equal(engine.applyLikes('p1', 19).gained, 0);
  assert.equal(engine.applyLikes('p1', 26).gained, 2);
  assert.equal(state.players.p1.soldiers, 2);
  assert.equal(state.players.p1.likeBuffer, 5);
});

test('asker puanı saldırıya +1 güç olarak harcanır', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000); // savunma 3
  engine.applyLikes('p2', 40); // 2 asker
  engine.startAttack('p2', 'turkiye', 2); // 2+2=4 > 3
  clock.advance(10000); engine.tick();
  assert.equal(state.owners.turkiye, 'p2');
  assert.equal(state.players.p2.soldiers, 0);
});

test('puan: ülke SAYISI değil puan toplamı, altın x3', () => {
  const { engine, state } = setup();
  for (const c of ['malta', 'kenya', 'fiji']) engine.claimCountry('p1', c); // 3 ülke = 3 puan
  engine.claimCountry('p2', 'almanya'); // 1 ülke = 5 puan
  assert.equal(engine.getScores()[0].playerId, 'p2');
  state.gold = ['malta'];
  assert.equal(engine.getScores().find(s => s.playerId === 'p1').points, 5); // 3+2
  assert.equal(engine.getScores().length <= 5, true);
});

test('endRound: kazanan belirlenir, state sıfırlanır', () => {
  const { engine, state } = setup();
  engine.claimCountry('p1', 'almanya'); engine.claimCountry('p2', 'malta');
  const r = engine.endRound();
  assert.equal(r.winner.winnerId, 'p1');
  assert.deepEqual(state.owners, {});
  assert.equal(state.phase, 'intermission');
  assert.equal(state.history.length, 1);
  assert.equal(r.events.at(-1).type, 'round_end');
});

test('barış: saldırı kapalı', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'turkiye'); clock.advance(16000);
  engine.peace();
  assert.equal(engine.startAttack('p2', 'turkiye', 9).reason, 'peace');
  clock.advance(30001);
  assert.ok(engine.startAttack('p2', 'turkiye', 9).ok);
});

test('açılış fazında saldırı kapalı, claim açık', () => {
  const { engine } = setup('opening');
  assert.ok(engine.claimCountry('p1', 'malta').ok);
  assert.equal(engine.startAttack('p2', 'malta', 9).reason, 'attacks_closed');
});

test('kaos imparatoru ve deprem', () => {
  const { engine, clock, state } = setup('chaos');
  engine.claimCountry('p1', 'almanya'); engine.claimCountry('p2', 'malta'); clock.advance(16000);
  engine.chaosEmperor();
  assert.equal(Object.keys(state.attacks).length, 2);
  clock.advance(10000); engine.tick();
  assert.equal(state.owners.malta, undefined); // 4 > 1 -> sahipsiz
  assert.equal(state.owners.almanya, 'p1'); // 4 < 8
  engine.claimCountry('p1', 'kenya'); engine.claimCountry('p1', 'fiji');
  const q = engine.earthquake();
  assert.equal(q.events[0].lost.length, 2);
});

test('kalabalık saldırısı: küçük hediyeler güç toplar, en çok katkı yapan ülkeyi alır', () => {
  const { engine, clock, state } = setup();
  engine.claimCountry('p1', 'almanya'); clock.advance(16000); // savunma 8
  for (let i = 0; i < 3; i++) engine.applyGift('p2', 40, { attackCountryId: 'almanya' }); // 3 x 2.0 = 6
  engine.applyGift('p3', 40, { attackCountryId: 'almanya' }); engine.applyGift('p3', 40, { attackCountryId: 'almanya' }); // 4 -> toplam 10
  assert.equal(Object.keys(state.attacks).length, 1);
  clock.advance(10000);
  const ev = engine.tick();
  assert.equal(ev[0].type, 'attack_won'); assert.equal(ev[0].contributors, 2);
  assert.equal(state.owners.almanya, 'p2'); // p2 daha çok katkı yaptı
});

test('tek hediyenin gücü tavanlı', () => {
  const { engine, clock } = setup();
  engine.claimCountry('p1', 'almanya'); clock.advance(16000);
  engine.claimCountry('p3', 'malta'); engine.claimCountry('p4', 'kenya'); // p2 sonuncu olmasın diye
  const r = engine.applyGift('p3', 5000, { attackCountryId: 'almanya' });
  assert.equal(r.power, 12 * 1); // tavan 12 (comeback bonusu tavandan sonra uygulanmaz)
});
