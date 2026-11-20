'use strict';
// [id, Türkçe ad, kıta, sınıf, boylam, enlem, ek yazımlar]
const RAW = [
  ['almanya','Almanya','europe','capital',10,51,['deutschland']],
  ['fransa','Fransa','europe','large',2,46.5,[]],
  ['ingiltere','İngiltere','europe','large',-2,53,['birlesik krallik','uk','britanya']],
  ['ispanya','İspanya','europe','medium',-4,40,[]],
  ['italya','İtalya','europe','medium',12.5,42.5,[]],
  ['polonya','Polonya','europe','medium',19,52,[]],
  ['ukrayna','Ukrayna','europe','medium',31,49,[]],
  ['rusya','Rusya','europe','large',60,60,[]],
  ['yunanistan','Yunanistan','europe','small',22,39,[]],
  ['romanya','Romanya','europe','medium',25,46,[]],
  ['hollanda','Hollanda','europe','small',5.5,52,[]],
  ['isvec','İsveç','europe','medium',16,62,[]],
  ['norvec','Norveç','europe','medium',9,61,[]],
  ['malta','Malta','europe','small',14.4,35.9,[]],
  ['luksemburg','Lüksemburg','europe','small',6.1,49.8,[]],
  ['portekiz','Portekiz','europe','small',-8,39.5,[]],
  ['isvicre','İsviçre','europe','small',8.2,46.8,[]],
  ['cin','Çin','asia','capital',103,35,[]],
  ['hindistan','Hindistan','asia','large',79,22,[]],
  ['turkiye','Türkiye','asia','medium',35,39,['turkey','tr']],
  ['iran','İran','asia','medium',53,32,[]],
  ['irak','Irak','asia','medium',44,33,[]],
  ['suudi','Suudi Arabistan','asia','medium',45,24,['suudi']],
  ['pakistan','Pakistan','asia','medium',69,30,[]],
  ['japonya','Japonya','asia','medium',138,36,[]],
  ['guneykore','Güney Kore','asia','small',128,36.5,[]],
  ['kazakistan','Kazakistan','asia','large',67,48,[]],
  ['endonezya','Endonezya','asia','large',113,-2,[]],
  ['tayland','Tayland','asia','small',101,15,[]],
  ['vietnam','Vietnam','asia','small',108,14,[]],
  ['israil','İsrail','asia','small',35,31,[]],
  ['afganistan','Afganistan','asia','medium',66,34,[]],
  ['singapur','Singapur','asia','small',103.8,1.3,[]],
  ['misir','Mısır','africa','capital',30,26,[]],
  ['nijerya','Nijerya','africa','medium',8,9,[]],
  ['guneyafrika','Güney Afrika','africa','medium',24,-29,[]],
  ['cezayir','Cezayir','africa','large',3,28,[]],
  ['libya','Libya','africa','medium',17,27,[]],
  ['etiyopya','Etiyopya','africa','medium',40,9,[]],
  ['kenya','Kenya','africa','small',38,0,[]],
  ['fas','Fas','africa','small',-6,32,[]],
  ['sudan','Sudan','africa','large',30,15,[]],
  ['kongo','Kongo','africa','large',23,-2,[]],
  ['abd','ABD','namerica','capital',-98,39,['amerika','birlesik devletler','usa']],
  ['kanada','Kanada','namerica','large',-100,58,[]],
  ['meksika','Meksika','namerica','large',-102,23,[]],
  ['kuba','Küba','namerica','small',-79,22,[]],
  ['guatemala','Guatemala','namerica','small',-90.5,15.5,[]],
  ['panama','Panama','namerica','small',-80,8.5,[]],
  ['jamaika','Jamaika','namerica','small',-77,18,[]],
  ['brezilya','Brezilya','samerica','capital',-52,-10,[]],
  ['arjantin','Arjantin','samerica','large',-64,-35,[]],
  ['sili','Şili','samerica','medium',-71,-33,[]],
  ['kolombiya','Kolombiya','samerica','medium',-74,4,[]],
  ['peru','Peru','samerica','medium',-75,-10,[]],
  ['venezuela','Venezuela','samerica','medium',-66,7,[]],
  ['avustralya','Avustralya','oceania','capital',134,-25,[]],
  ['yenizelanda','Yeni Zelanda','oceania','small',174,-41,[]],
  ['papua','Papua Yeni Gine','oceania','small',144,-6,['papua yeni gine']],
  ['fiji','Fiji','oceania','small',178,-18,[]],
];

// Komşuluklar çift yönlü otomatik üretilir.
const EDGES = `
almanya-fransa almanya-polonya almanya-hollanda almanya-luksemburg almanya-isvicre fransa-ispanya fransa-italya
fransa-isvicre fransa-luksemburg fransa-ingiltere ispanya-portekiz italya-isvicre italya-malta polonya-ukrayna
polonya-rusya ukrayna-rusya ukrayna-romanya romanya-yunanistan yunanistan-turkiye isvec-norvec isvec-polonya
norvec-rusya ingiltere-hollanda ingiltere-norvec italya-yunanistan
turkiye-iran turkiye-irak turkiye-rusya iran-irak iran-afganistan iran-pakistan irak-suudi suudi-israil israil-misir
afganistan-pakistan pakistan-hindistan hindistan-cin cin-rusya cin-kazakistan cin-vietnam cin-guneykore guneykore-japonya
kazakistan-rusya kazakistan-iran vietnam-tayland tayland-singapur singapur-endonezya endonezya-papua suudi-misir
misir-libya misir-sudan libya-cezayir cezayir-fas libya-sudan sudan-etiyopya etiyopya-kenya kenya-kongo kongo-nijerya
kongo-guneyafrika nijerya-cezayir fas-ispanya
abd-kanada abd-meksika abd-kuba meksika-guatemala guatemala-panama kuba-jamaika panama-kolombiya
kolombiya-venezuela kolombiya-peru kolombiya-brezilya brezilya-peru brezilya-arjantin arjantin-sili peru-sili venezuela-brezilya
avustralya-yenizelanda avustralya-papua avustralya-fiji endonezya-avustralya
`.trim().split(/\s+/).map(e => e.split('-'));

const TR_MAP = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'â': 'a', 'î': 'i', 'û': 'u' };

// Türkçe-güvenli normalize: İ/I doğru küçülür, aksanlar kalkar, noktalama ve emoji atılır.
function normalize(text) {
  return String(text ?? '')
    .replace(/İ/g, 'i').replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, ch => TR_MAP[ch])
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COUNTRIES = RAW.map(([id, name, continent, cls, lon, lat, extra]) => ({
  id, name, continent, class: cls, lon, lat, neighbors: [],
  aliases: [...new Set([normalize(name), id, ...extra.map(normalize)])],
}));
const BY_ID = new Map(COUNTRIES.map(c => [c.id, c]));
for (const [a, b] of EDGES) {
  if (!BY_ID.has(a) || !BY_ID.has(b)) throw new Error(`Bilinmeyen komşuluk: ${a}-${b}`);
  BY_ID.get(a).neighbors.push(b);
  BY_ID.get(b).neighbors.push(a);
}
const ALIAS_MAP = new Map();
for (const c of COUNTRIES) for (const al of c.aliases) ALIAS_MAP.set(al, c);

function findCountryByText(text) { return ALIAS_MAP.get(normalize(text)) || null; }
function getByContinent(continent) { return COUNTRIES.filter(c => c.continent === continent); }

module.exports = { COUNTRIES, BY_ID, normalize, findCountryByText, getByContinent };
