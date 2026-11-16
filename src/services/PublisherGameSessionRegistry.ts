import { GameEngine, type GameEngineUpdate, type GameState } from './GameEngine';
import { TikTokConnectorAdapter } from './TikTokConnectorAdapter';
import type { StandardGameEvent } from '../types/events';
import { GameEventType } from '../types/events';
import { ArmyBattleEngine } from './ArmyBattleEngine';
import { LicenseService } from './LicenseService';

interface PublisherGameSession {
  adapter: TikTokConnectorAdapter;
  engine: GameEngine;
  army: ArmyBattleEngine;
  lastUpdate?: GameEngineUpdate;
  broadcastListener?: (update: GameEngineUpdate) => void;
}

export interface PublisherStreamResult {
  status: 'connected' | 'already_connected';
  tiktokUsername: string;
}

/** Her yayıncı için ayrı adapter ve oyun durumu tutar. */
export class PublisherGameSessionRegistry {
  private readonly sessions = new Map<string, PublisherGameSession>();

  constructor(private readonly broadcastGameState?: (publisherId: string, state: GameEngineUpdate['gameState']) => void) {}

  private async startStreamForPublisher(publisherId: string, tiktokUsername: string): Promise<PublisherStreamResult> {
    const session = this.getSession(publisherId);
    if (session.adapter.isRunning) return { status: 'already_connected', tiktokUsername };
    if (session.broadcastListener) session.engine.off('state:updated', session.broadcastListener);
    const broadcastListener = (update: GameEngineUpdate): void => {
      this.broadcastGameState?.(publisherId, { ...update.gameState, army: session.army.getState() });
    };
    session.broadcastListener = broadcastListener;
    session.engine.on('state:updated', broadcastListener);
    try {
      await session.adapter.start(tiktokUsername);
      session.engine.startBossAttacks();
      session.army.start();
    } catch (error) {
      session.engine.off('state:updated', broadcastListener);
      session.broadcastListener = undefined;
      throw error;
    }
    return { status: 'connected', tiktokUsername: tiktokUsername.replace(/^@/, '') };
  }

  async startLicensedStream(token: string, tiktokUsername: string): Promise<PublisherStreamResult> {
    const license = await LicenseService.validateToken(token);
    if (!license) throw new Error('Lisans süresi dolmuş veya geçersiz.');
    return this.startStreamForPublisher(license.id, tiktokUsername);
  }

  async startStream(token: string, tiktokUsername: string): Promise<PublisherStreamResult> { return this.startLicensedStream(token, tiktokUsername); }

  async stopStream(publisherId: string): Promise<boolean> {
    const session = this.sessions.get(publisherId);
    if (!session) return false;
    const wasConnected = session.adapter.isRunning;
    await session.adapter.stop();
    session.engine.stopBossAttacks();
    session.army.stop();
    if (session.broadcastListener) session.engine.off('state:updated', session.broadcastListener);
    session.broadcastListener = undefined;
    return wasConnected;
  }

  processEvent(publisherId: string, eventName: string, payload: unknown): GameEngineUpdate {
    const session = this.getSession(publisherId);
    session.lastUpdate = undefined;
    const event: StandardGameEvent | null = session.adapter.ingest(eventName, payload);
    const update = session.lastUpdate as GameEngineUpdate | undefined;
    if (!event || !update) {
      throw new Error('Simüle event standart formata dönüştürülemedi.');
    }
    return { ...update, gameState: { ...update.gameState, army: session.army.getState() } };
  }

  simulateArmyGift(publisherId: string, username: string, coins: number): GameEngineUpdate['gameState'] {
    const session = this.getSession(publisherId);
    session.army.start();
    session.army.simulate(username, coins);
    const baseState = session.lastUpdate?.gameState ?? session.engine.processEvent({ eventId: `army-${Date.now()}`, type: GameEventType.JOIN, userId: `sim-${username}`, username, occurredAt: new Date().toISOString(), payload: {} }).gameState;
    return { ...baseState, army: session.army.getState() };
  }

  addArmyBots(publisherId: string, count: number): GameEngineUpdate['gameState'] {
    const session = this.getSession(publisherId);
    session.army.start();
    session.army.addBots(count);
    const state = session.lastUpdate?.gameState ?? session.engine.processEvent({ eventId: `bots-${Date.now()}`, type: GameEventType.JOIN, userId: `bot-system-${Date.now()}`, username: 'Army Bots', occurredAt: new Date().toISOString(), payload: {} }).gameState;
    return { ...state, army: session.army.getState() };
  }

  getGameState(publisherId: string): GameState {
    const session = this.getSession(publisherId);
    return { ...(session.lastUpdate?.gameState ?? session.engine.getState()), army: session.army.getState() };
  }

  getStreamStatus(publisherId: string): boolean { return this.sessions.get(publisherId)?.adapter.isRunning ?? false; }

  startBattleNow(publisherId: string): GameState {
    const session = this.getSession(publisherId); session.army.start(); session.army.startBattleNow(); return this.getGameState(publisherId);
  }

  resetArmyRound(publisherId: string): GameState {
    const session = this.getSession(publisherId); session.army.resetRound(); return this.getGameState(publisherId);
  }

  resetArmyLeaderboard(publisherId: string): GameState {
    const session = this.getSession(publisherId); session.army.resetLeaderboard(); return this.getGameState(publisherId);
  }

  private getSession(publisherId: string): PublisherGameSession {
    const current = this.sessions.get(publisherId);
    if (current) return current;

    const session: PublisherGameSession = {
      adapter: new TikTokConnectorAdapter(),
      engine: new GameEngine(),
      army: new ArmyBattleEngine(),
    };
    session.adapter.on(TikTokConnectorAdapter.CONNECTION_ERROR_EVENT, (error: unknown) => {
      console.error(`[TikTok] Yayın bağlantısı hatası (${publisherId}):`, error instanceof Error ? error.message : 'bilinmeyen hata');
    });
    session.adapter.on(TikTokConnectorAdapter.DISCONNECTED_EVENT, () => {
      session.engine.stopBossAttacks();
      session.army.stop();
      if (session.broadcastListener) session.engine.off('state:updated', session.broadcastListener);
      session.broadcastListener = undefined;
      console.info(`[TikTok] Yayın bağlantısı kapandı (${publisherId}).`);
    });
    session.engine.on('state:updated', (update: GameEngineUpdate) => {
      session.lastUpdate = update;
    });
    session.army.subscribe((army) => {
      this.broadcastGameState?.(publisherId, { ...(session.lastUpdate?.gameState ?? session.engine.getState()), army });
    });
    session.adapter.on(TikTokConnectorAdapter.EVENT_NAME, (event: StandardGameEvent) => session.army.process(event));
    session.engine.attachAdapter(session.adapter);
    this.sessions.set(publisherId, session);
    return session;
  }
}
