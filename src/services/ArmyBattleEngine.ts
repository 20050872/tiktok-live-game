import { randomUUID } from 'node:crypto';
import { GameEventType, type StandardGameEvent } from '../types/events';
import { levelForCoins, type ArmyState, type ArmyUnit, type TeamId } from '../types/army';

const PREP_MS = 100_000;
const BATTLE_MS = 20_000;
const powerFor = (unit: ArmyUnit): number => [1, 2, 4, 8, 18, 55, 130, 500][unit.level - 1];

/** TikTok etkileşimlerini takımlara atar ve 100+20 saniyelik savaş turunu yönetir. */
export class ArmyBattleEngine {
  private units = new Map<string, ArmyUnit>();
  private leaders = new Map<string, { userId: string; username: string; coins: number; highestLevel: number }>();
  private mode: ArmyState['mode'] = 'preparation';
  private winner: TeamId | null = null;
  private effects: string[] = [];
  private round = 1;
  private phaseStartedAt = Date.now();
  private timer?: NodeJS.Timeout;
  private readonly listeners = new Set<(state: ArmyState, effects: string[]) => void>();

  start(): void {
    if (this.timer) return;
    this.mode = 'preparation'; this.winner = null;
    this.phaseStartedAt = Date.now();
    this.timer = setInterval(() => this.tick(), 250);
    this.timer.unref?.();
  }
  startBattleNow(): void { this.mode = 'battle'; this.winner = null; this.phaseStartedAt = Date.now(); this.publish(['Yayıncı savaşı başlattı!']); }
  resetRound(): void { this.units.clear(); this.leaders.clear(); this.effects = []; this.mode = 'preparation'; this.winner = null; this.round = 1; this.phaseStartedAt = Date.now(); this.publish(['Ordu turu sıfırlandı.']); }
  resetLeaderboard(): void { this.leaders.clear(); this.publish(['Liderlik tablosu sıfırlandı.']); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  subscribe(listener: (state: ArmyState, effects: string[]) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  process(event: StandardGameEvent): void {
    let unit = this.units.get(event.userId);
    if (!unit) {
      unit = { userId: event.userId, username: event.username, ...(event.displayName ? { displayName: event.displayName } : {}), team: Math.random() < .5 ? 'red' : 'blue', level: 1, coins: 0, joinedAt: event.occurredAt };
      this.units.set(event.userId, unit);
    }
    unit.username = event.username;
    if (event.displayName) unit.displayName = event.displayName;
    if (event.type === 'GIFT') {
      const giftCoins = (event.payload.diamondCount ?? 1) * event.payload.repeatCount;
      unit.coins += giftCoins;
      const previousLevel = unit.level;
      unit.level = levelForCoins(unit.coins);
      const leader = this.leaders.get(event.userId) ?? { userId: event.userId, username: unit.displayName ?? unit.username, coins: 0, highestLevel: 1 };
      leader.username = unit.displayName ?? unit.username; leader.coins += giftCoins; leader.highestLevel = Math.max(leader.highestLevel, unit.level);
      this.leaders.set(event.userId, leader);
      if (unit.level === 8) {
        const enemyTeam: TeamId = unit.team === 'red' ? 'blue' : 'red';
        const enemies = [...this.units.values()].filter((candidate) => candidate.team === enemyTeam).sort((a, b) => powerFor(a) - powerFor(b));
        const casualties = Math.ceil(enemies.length * .4);
        for (const enemy of enemies.slice(0, casualties)) this.units.delete(enemy.userId);
      }
      this.publish(unit.level > previousLevel ? [`${unit.username} seviye ${unit.level} oldu!`, ...(unit.level === 8 ? [`${unit.username} atom bombası saldırısı ${event.eventId}!`] : [])] : unit.level === 8 ? [`${unit.username} atom bombası saldırısı ${event.eventId}!`] : []);
    } else this.publish([]);
  }
  simulate(username: string, coins: number): ArmyUnit {
    const id = `sim-${username}`;
    let unit = this.units.get(id);
    if (!unit) {
      unit = { userId: id, username, team: Math.random() < .5 ? 'red' : 'blue', level: 1, coins: 0, joinedAt: new Date().toISOString() };
      this.units.set(id, unit);
    }
    unit.coins = Math.max(unit.coins, coins);
    unit.level = levelForCoins(unit.coins);
    const leader = this.leaders.get(id) ?? { userId: id, username, coins: 0, highestLevel: 1 };
    leader.coins = Math.max(leader.coins, coins); leader.highestLevel = Math.max(leader.highestLevel, unit.level);
    this.leaders.set(id, leader);
    if (unit.level === 8) {
      const enemyTeam: TeamId = unit.team === 'red' ? 'blue' : 'red';
      const enemies = [...this.units.values()].filter((candidate) => candidate.team === enemyTeam).sort((a, b) => powerFor(a) - powerFor(b));
      for (const enemy of enemies.slice(0, Math.ceil(enemies.length * .4))) this.units.delete(enemy.userId);
    }
    this.publish([`${unit.username} seviye ${unit.level} test edildi.`, ...(unit.level === 8 ? [`${unit.username} atom bombası saldırısı ${Date.now()}!`] : [])]);
    return { ...unit };
  }
  addBots(count: number): void {
    for (let i = 1; i <= Math.min(200, Math.max(1, count)); i++) this.process({ eventId: randomUUID(), type: GameEventType.JOIN, userId: `bot-${randomUUID()}`, username: `Bot_${i}`, occurredAt: new Date().toISOString(), payload: {} });
    this.publish([`${Math.min(200, Math.max(1, count))} bot orduya katıldı.`]);
  }
  getState(): ArmyState {
    const units = [...this.units.values()].map((unit) => ({ ...unit }));
    const teams = { red: { members: 0, power: 0 }, blue: { members: 0, power: 0 } };
    for (const unit of units) { teams[unit.team].members++; teams[unit.team].power += powerFor(unit); }
    const duration = this.mode === 'preparation' ? PREP_MS : BATTLE_MS;
    const remainingMs = Math.max(0, duration - (Date.now() - this.phaseStartedAt));
    const leaderboard = [...this.leaders.values()].sort((a, b) => b.coins - a.coins || b.highestLevel - a.highestLevel || a.username.localeCompare(b.username)).slice(0, 10).map((entry) => ({ ...entry }));
    return { mode: this.mode, round: this.round, phaseEndsAt: new Date(Date.now() + remainingMs).toISOString(), remainingMs, winner: this.winner, units, teams, effects: [...this.effects], leaderboard, updatedAt: new Date().toISOString() };
  }
  private tick(): void {
    const duration = this.mode === 'preparation' ? PREP_MS : BATTLE_MS;
    if (Date.now() - this.phaseStartedAt >= duration) {
      if (this.mode === 'preparation') {
        this.mode = 'battle'; this.phaseStartedAt = Date.now(); this.publish(['Savaş başladı!']);
      } else {
        const before = this.getState();
        if (before.teams.red.power !== before.teams.blue.power) {
          const losingTeam: TeamId = before.teams.red.power > before.teams.blue.power ? 'blue' : 'red';
          const defeated = [...this.units.values()].filter((unit) => unit.team === losingTeam).sort((a, b) => powerFor(a) - powerFor(b));
          const casualties = Math.min(Math.max(0, defeated.length - 1), Math.floor(defeated.length * .45));
          for (const unit of defeated.slice(0, casualties)) this.units.delete(unit.userId);
        }
        const after = this.getState();
        this.winner = after.teams.red.power === after.teams.blue.power ? null : after.teams.red.power > after.teams.blue.power ? 'red' : 'blue';
        this.mode = 'preparation'; this.phaseStartedAt = Date.now(); this.round++;
        this.publish([this.winner ? `${this.winner === 'red' ? 'Kırmızı' : 'Mavi'} takım kazandı!` : 'Tur berabere bitti!']);
      }
    } else if (this.mode === 'battle') this.publish([]);
  }
  private publish(effects: string[]): void { this.effects = effects; const state = this.getState(); for (const listener of this.listeners) listener(state, effects); }
}
