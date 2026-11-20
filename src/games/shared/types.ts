import type { StandardGameEvent } from '../types/events';

/**
 * Her oyunun uygulaması gereken ortak arayüz.
 * Yeni oyun eklerken sadece bu metodları dolduracaksın.
 */
export interface IGameEngine {
  readonly gameId: string;
  readonly displayName: string;

  /** Oyun oturumu başlatılır (zamanlayıcılar, başlangıç durumu). */
  start(): void;

  /** Oyun oturumu durdurulur, tüm zamanlayıcılar temizlenir. */
  stop(): void;

  /** TikTok'tan gelen standart olay işlenir. */
  processEvent(event: StandardGameEvent): GameUpdate;

  /** Güncel oyun durumu döndürülür (overlay'e gönderilir). */
  getState(): unknown;

  /** Oyunu başlangıç durumuna sıfırlar. */
  reset(): void;
}

/** Her olay sonrası dönen güncelleme paketi. */
export interface GameUpdate {
  event: StandardGameEvent;
  gameState: unknown;
  effect?: GameEffect;
}

export interface GameEffect {
  id: string;
  type: string;
  message: string;
  createdAt: string;
  userId?: string;
  value?: number;
}

/** Oyun kayıt bilgisi (registry için). */
export interface GameDefinition {
  id: string;
  displayName: string;
  description: string;
  createEngine: () => IGameEngine;
}
