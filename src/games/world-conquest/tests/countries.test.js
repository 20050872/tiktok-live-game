'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { COUNTRIES, findCountryByText, getByContinent, BY_ID } = require('../countries');

test('60 ülke, id benzersiz', () => {
  assert.equal(COUNTRIES.length, 60);
  assert.equal(new Set(COUNTRIES.map(c => c.id)).size, 60);
});
test('komşuluklar çift yönlü ve geçerli', () => {
  for (const c of COUNTRIES) for (const n of c.neighbors) {
    assert.ok(BY_ID.has(n), `${c.id} -> ${n} yok`);
    assert.ok(BY_ID.get(n).neighbors.includes(c.id), `${n} -> ${c.id} eksik`);
    assert.notEqual(n, c.id);
  }
});
test('sınıflar geçerli, her kıtada tam 1 capital', () => {
  for (const c of COUNTRIES) assert.ok(['small', 'medium', 'large', 'capital'].includes(c.class));
  for (const k of ['europe', 'asia', 'africa', 'namerica', 'samerica', 'oceania']) {
    assert.equal(getByContinent(k).filter(c => c.class === 'capital').length, 1, k);
  }
});
test('Türkçe normalizasyon', () => {
  assert.equal(findCountryByText('almanya').id, 'almanya');
  assert.equal(findCountryByText('ALMANYA').id, 'almanya');
  assert.equal(findCountryByText('Almanya!').id, 'almanya');
  assert.equal(findCountryByText('TÜRKİYE').id, 'turkiye');
  assert.equal(findCountryByText('türkiye').id, 'turkiye');
  assert.equal(findCountryByText('Turkiye').id, 'turkiye');
  assert.equal(findCountryByText('IRAK').id, 'irak');
  assert.equal(findCountryByText('ırak').id, 'irak');
  assert.equal(findCountryByText('İSVEÇ').id, 'isvec');
  assert.equal(findCountryByText('Güney Kore').id, 'guneykore');
  assert.equal(findCountryByText('amerika').id, 'abd');
  assert.equal(findCountryByText('olmayanulke'), null);
  assert.equal(findCountryByText(''), null);
});
