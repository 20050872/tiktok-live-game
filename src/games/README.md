# Çoklu Oyun Sistemi

Bu klasör, TikTok Live Game platformunun oyun motorlarını barındırır.

## Yapı

```
src/games/
├── shared/        ← Ortak arayüz ve kayıt sistemi
├── army/           ← Ordu Savaşı (mevcut oyun, adaptör ile bağlandı)
└── <yeni-oyun>/   ← Yeni oyunlar buraya eklenir
```

## Yeni oyun ekleme adımları

1. `src/games/<oyun-adi>/` klasörü aç.
2. `index.ts` içinde `IGameEngine` arayüzünü uygulayan bir sınıf yaz:
   - `gameId`, `displayName`
   - `start()`, `stop()`, `processEvent()`, `getState()`, `reset()`
3. `GameDefinition` nesnesi export et.
4. `src/games/index.ts` içine `gameRegistry.register(yeniOyun)` ekle.
5. Overlay URL'sine `?game=<oyun-adi>` parametresiyle yüklenebilir.

## Ortak arayüz (`shared/types.ts`)

Her oyun şu metodları sağlar:

| Metod | Görevi |
|------|--------|
| `start` | Oturumu başlat, zamanlayıcıları kur |
| `stop` | Zamanlayıcıları temizle |
| `processEvent` | TikTok olayını işle, güncelleme döndür |
| `getState` | Overlay'e gönderilecek anlık durum |
| `reset` | Başlangıç durumuna dön |

## Notlar

- Mevcut `ArmyBattleEngine` koduna dokunulmadı; `army/index.ts` onu saran ince bir adaptördür.
- `GameEngine.ts` (boss savaşı) henüz bu sisteme bağlanmadı — istersen aynı şekilde adaptör yazılabilir.
- Yayıncı paneli hangi oyunun aktif olduğunu `gameRegistry.setActive(gameId)` ile seçer.
