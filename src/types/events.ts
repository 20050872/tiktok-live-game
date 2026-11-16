export enum GameEventType {
  CHAT = 'CHAT',
  GIFT = 'GIFT',
  LIKE = 'LIKE',
  FOLLOW = 'FOLLOW',
  JOIN = 'JOIN',
}

export interface GameEventPayloadMap {
  [GameEventType.CHAT]: { message: string };
  [GameEventType.GIFT]: {
    giftName: string;
    repeatCount: number;
    diamondCount?: number;
  };
  [GameEventType.LIKE]: {
    count: number;
    totalLikeCount?: number;
  };
  [GameEventType.FOLLOW]: Record<string, never>;
  [GameEventType.JOIN]: Record<string, never>;
}

export interface GameEventBase<TType extends GameEventType> {
  eventId: string;
  type: TType;
  userId: string;
  username: string;
  displayName?: string;
  occurredAt: string;
}

/** Discriminated union: payload alanları event türüne göre tip güvenlidir. */
export type StandardGameEvent = {
  [TType in GameEventType]: GameEventBase<TType> & {
    payload: GameEventPayloadMap[TType];
  };
}[GameEventType];