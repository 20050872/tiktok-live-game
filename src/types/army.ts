import type { StandardGameEvent } from './events';

export type TeamId = 'red' | 'blue';
export interface ArmyUnit {
  userId: string; username: string; displayName?: string; team: TeamId; level: number;
  coins: number; joinedAt: string;
}
export interface ArmyState {
  mode: 'preparation' | 'battle'; round: number; phaseEndsAt: string; remainingMs: number;
  winner: TeamId | null; units: ArmyUnit[];
  effects: string[];
  leaderboard: Array<{ userId: string; username: string; coins: number; highestLevel: number }>;
  teams: Record<TeamId, { members: number; power: number }>;
  updatedAt: string;
}

export const LEVELS = [
  { level: 1, min: 0, name: 'Taş atan piyade', icon: '🪨' },
  { level: 2, min: 1, name: 'Sopalı savaşçı', icon: '🪵' },
  { level: 3, min: 10, name: 'Mızraklı savaşçı', icon: '🔱' },
  { level: 4, min: 50, name: 'Kılıçlı şövalye', icon: '🛡️' },
  { level: 5, min: 200, name: 'Modern asker', icon: '🔫' },
  { level: 6, min: 1000, name: 'Zırhlı tank', icon: '🚜' },
  { level: 7, min: 5000, name: 'Savaş uçağı', icon: '✈️' },
  { level: 8, min: 15000, name: 'Atom bombası', icon: '☢️' },
] as const;

export function levelForCoins(coins: number): number {
  return [...LEVELS].reverse().find((item) => coins >= item.min)?.level ?? 1;
}

export type ArmyEvent = StandardGameEvent;
