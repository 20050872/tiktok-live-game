import type { StandardGameEvent } from './events';
import type { ArmyState } from './army';

export type PlayerClass = 'warrior' | 'archer' | 'mage';
export type CharacterClass = PlayerClass | 'adventurer';
export type GuildId = 'kraliyet' | 'golge';

export interface GameGuild {
  id: GuildId;
  name: string;
  score: number;
  members: number;
}

export interface GamePlayer {
  userId: string;
  username: string;
  displayName?: string;
  classId: CharacterClass;
  className: string;
  avatar: string;
  guildId: GuildId | null;
  health: number;
  maxHealth: number;
  isTargeted: boolean;
  totalMessages: number;
  totalGiftRepeats: number;
  totalLikes: number;
  followCount: number;
  joinCount: number;
  damageDealt: number;
  supportPoints: number;
  giftValue: number;
  minionsSummoned: number;
  escapes: number;
  buffExpiresAt: string | null;
  joinedAt: string;
  lastActiveAt: string;
}

export interface GameEffect {
  id: string;
  type: 'class-assigned' | 'guild-joined' | 'chat-attack' | 'mana-blast' | 'speed-buff' | 'minion-summoned' | 'meteor' | 'mvp' | 'follow' | 'boss-target' | 'boss-hit' | 'escape' | 'boss-defeated';
  message: string;
  createdAt: string;
  userId?: string;
  value?: number;
  giftName?: string;
}

export interface GameState {
  army?: ArmyState;
  players: GamePlayer[];
  bossHealth: number;
  maxBossHealth: number;
  bossDefeated: boolean;
  mana: number;
  maxMana: number;
  manaBlasts: number;
  bossTargetUserId: string | null;
  bossAttackEndsAt: string | null;
  mvpUserId: string | null;
  guilds: GameGuild[];
  effects: GameEffect[];
  updatedAt: string;
}

export interface GameEngineUpdate {
  event: StandardGameEvent;
  player: GamePlayer;
  damage: number;
  gameState: GameState;
  effect?: GameEffect;
}
