import { ArmyBattleEngine } from '../../services/ArmyBattleEngine';
import type { StandardGameEvent } from '../../types/events';
import type { ArmyState } from '../../types/army';
import type { GameDefinition, GameUpdate, IGameEngine } from '../shared/types';

/**
 * Mevcut ArmyBattleEngine'i ortak IGameEngine arayüzüne saran adaptör.
 * Mevcut ordu oyununun koduna dokunmadan çoklu oyun sistemine dahil eder.
 */
class ArmyGameAdapter implements IGameEngine {
  readonly gameId = 'army';
  readonly displayName = 'Ordu Savaşı';
  private readonly engine = new ArmyBattleEngine();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
  }

  stop(): void {
    this.started = false;
  }

  processEvent(event: StandardGameEvent): GameUpdate {
    const gameState = this.engine.handleEvent(event) as ArmyState;
    return { event, gameState };
  }

  getState(): ArmyState {
    return this.engine.getState() as ArmyState;
  }

  reset(): void {
    this.engine.reset();
  }
}

export const armyGame: GameDefinition = {
  id: 'army',
  displayName: 'Ordu Savaşı',
  description: 'Kırmızı ve mavi takımların hediyelerle asker üretip savaştığı klasik ordu oyunu.',
  createEngine: () => new ArmyGameAdapter(),
};
