import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GameEventType, type StandardGameEvent } from '../types/events';

type UnknownRecord = Record<string, unknown>;
interface TikTokConnectionLike {
  isConnected: boolean;
  isConnecting: boolean;
  on(eventName: string, listener: (...args: unknown[]) => void): unknown;
  off(eventName: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
  disconnect(): Promise<void>;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function positiveCount(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  return undefined;
}

function normalizeEventType(raw: UnknownRecord): GameEventType | undefined {
  const candidate = firstString(raw.type, raw.event, raw.eventType, raw.eventName, raw.event_name);
  if (!candidate) return undefined;

  switch (candidate.toLowerCase().replace(/[\s_-]/g, '')) {
    case 'chat':
    case 'comment':
      return GameEventType.CHAT;
    case 'gift':
      return GameEventType.GIFT;
    case 'like':
      return GameEventType.LIKE;
    case 'follow':
      return GameEventType.FOLLOW;
    case 'social': {
      const action = firstString(raw.displayType, raw.display_type, raw.label, raw.action)?.toLowerCase() ?? '';
      return raw.followCount !== undefined || raw.follow_count !== undefined || action.includes('follow')
        ? GameEventType.FOLLOW
        : undefined;
    }
    case 'join':
    case 'member':
    case 'memberjoin':
    case 'roomuser':
      return GameEventType.JOIN;
    default:
      return undefined;
  }
}

function normalizeTimestamp(...values: unknown[]): string {
  for (const value of values) {
    const milliseconds = typeof value === 'number'
      ? (value < 1_000_000_000_000 ? value * 1000 : value)
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
    if (Number.isFinite(milliseconds)) {
      const date = new Date(milliseconds);
      if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
  }
  return new Date().toISOString();
}

/** TikTok connector ham event'lerini oyunun ortak formatına dönüştürür. */
export class TikTokConnectorAdapter extends EventEmitter {
  static readonly EVENT_NAME = 'game:event';
  static readonly CONNECTION_ERROR_EVENT = 'connector:error';
  static readonly DISCONNECTED_EVENT = 'connector:disconnected';
  private connection?: TikTokConnectionLike;
  private connectionBindings: Array<{ eventName: string; listener: (payload: unknown) => void }> = [];

  get isConnected(): boolean {
    return this.connection?.isConnected ?? false;
  }

  get isRunning(): boolean {
    return Boolean(this.connection && (this.connection.isConnected || this.connection.isConnecting));
  }

  async start(tiktokUsername: string): Promise<void> {
    const username = tiktokUsername.trim().replace(/^@/, '');
    if (!username || username.length > 64) throw new Error('Geçerli bir TikTok kullanıcı adı gerekli.');
    if (this.isRunning) throw new Error('TikTok yayını zaten bağlı veya bağlanıyor.');
    if (this.connection) await this.stop();

    const { TikTokLiveConnection, WebcastEvent } = await import('tiktok-live-connector');
    const connection = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: true,
      enableExtendedGiftInfo: true,
    }) as unknown as TikTokConnectionLike;
    const bind = (eventName: string, type: string): void => {
      const listener = (payload: unknown): void => {
        try {
          if (type === 'gift' && isRecord(payload) && payload.repeatEnd === false) return;
          this.ingest(type, payload);
        } catch (error) {
          this.emit(TikTokConnectorAdapter.CONNECTION_ERROR_EVENT, error);
        }
      };
      connection.on(eventName, listener);
      this.connectionBindings.push({ eventName, listener });
    };
    this.connection = connection;
    bind(WebcastEvent.CHAT, 'chat');
    bind(WebcastEvent.MEMBER, 'member');
    bind(WebcastEvent.ROOM_USER, 'roomUser');
    bind(WebcastEvent.GIFT, 'gift');
    bind(WebcastEvent.LIKE, 'like');
    bind(WebcastEvent.SOCIAL, 'social');
    bind(WebcastEvent.FOLLOW, 'follow');
    const errorListener = (...args: unknown[]): void => {
      this.emit(TikTokConnectorAdapter.CONNECTION_ERROR_EVENT, args[0]);
    };
    connection.on('error', errorListener);
    this.connectionBindings.push({ eventName: 'error', listener: errorListener });
    const disconnectedListener = (...args: unknown[]): void => {
      this.emit(TikTokConnectorAdapter.DISCONNECTED_EVENT, args[0]);
    };
    connection.on('disconnected', disconnectedListener);
    this.connectionBindings.push({ eventName: 'disconnected', listener: disconnectedListener });

    try {
      await connection.connect();
      console.info(`[TikTok] @${username} yayınına bağlanıldı.`);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    if (!connection) return;
    for (const { eventName, listener } of this.connectionBindings) {
      connection.off(eventName, listener);
    }
    this.connectionBindings = [];
    if (connection.isConnected || connection.isConnecting) await connection.disconnect();
  }

  /** TikTok istemcisi gibi bir EventEmitter'a ham event listener'larını bağlar. */
  bind(source: EventEmitter): () => void {
    const eventNames = ['chat', 'comment', 'gift', 'like', 'follow', 'member', 'join'];
    const bindings = eventNames.map((eventName) => {
      const listener = (payload: unknown): void => {
        this.ingest(eventName, payload);
      };
      source.on(eventName, listener);
      return { eventName, listener };
    });

    return () => {
      for (const { eventName, listener } of bindings) {
        source.off(eventName, listener);
      }
    };
  }

  ingest(rawEvent: unknown): StandardGameEvent | null;
  ingest(eventName: string, rawPayload: unknown): StandardGameEvent | null;
  ingest(rawEventOrName: unknown, rawPayload?: unknown): StandardGameEvent | null {
    const input = typeof rawEventOrName === 'string'
      ? { type: rawEventOrName, data: rawPayload }
      : rawEventOrName;
    if (!isRecord(input)) return null;

    const type = normalizeEventType(input);
    if (!type) return null;

    const data = isRecord(input.data)
      ? input.data
      : isRecord(input.payload)
        ? input.payload
        : input;
    const nestedUser = isRecord(data.user) ? data.user : isRecord(input.user) ? input.user : data;
    const userId = firstString(
      nestedUser.userId,
      nestedUser.user_id,
      nestedUser.uid,
      nestedUser.id,
      nestedUser.secUid,
      nestedUser.sec_uid,
    );
    const username = firstString(
      nestedUser.uniqueId,
      nestedUser.unique_id,
      nestedUser.username,
      nestedUser.handle,
      userId,
    );

    if (!userId || !username) return null;

    const base = {
      eventId: firstString(data.eventId, data.event_id, input.eventId, input.event_id) ?? randomUUID(),
      userId,
      username,
      displayName: firstString(nestedUser.nickname, nestedUser.displayName, nestedUser.display_name),
      occurredAt: normalizeTimestamp(
        data.timestamp,
        data.createTime,
        data.create_time,
        input.timestamp,
      ),
    };

    let event: StandardGameEvent;
    switch (type) {
      case GameEventType.CHAT: {
        const message = firstString(data.comment, data.message, data.text, data.content);
        if (!message) return null;
        event = { ...base, type, payload: { message } };
        break;
      }
      case GameEventType.GIFT: {
        const gift = isRecord(data.gift) ? data.gift : {};
        const extendedGiftInfo = isRecord(data.extendedGiftInfo) ? data.extendedGiftInfo : {};
        const giftId = firstString(data.giftId, data.gift_id, gift.id);
        const giftName = firstString(data.giftName, data.gift_name, gift.name, extendedGiftInfo.name, giftId) ?? 'Bilinmeyen hediye';
        const repeatCount = positiveCount(data.repeatCount, data.repeat_count, data.comboCount, data.count) ?? 1;
        const diamondCount = positiveCount(data.diamondCount, data.diamond_count, data.diamonds);
        event = {
          ...base,
          type,
          payload: {
            giftName,
            repeatCount,
            ...(diamondCount === undefined ? {} : { diamondCount }),
          },
        };
        break;
      }
      case GameEventType.LIKE: {
        const count = positiveCount(data.likeCount, data.like_count, data.count) ?? 1;
        const totalLikeCount = positiveCount(data.totalLikeCount, data.total_like_count);
        event = {
          ...base,
          type,
          payload: {
            count,
            ...(totalLikeCount === undefined ? {} : { totalLikeCount }),
          },
        };
        break;
      }
      case GameEventType.FOLLOW:
        event = { ...base, type, payload: {} };
        break;
      case GameEventType.JOIN:
        event = { ...base, type, payload: {} };
        break;
    }

    this.emit(TikTokConnectorAdapter.EVENT_NAME, event);
    return event;
  }
}
