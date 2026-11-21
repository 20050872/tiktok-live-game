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
    this.engine.start();
    this.started = true;
  }

  stop(): void {
    this.engine.stop();
    this.started = false;
  }

  processEvent(event: StandardGameEvent): GameUpdate {
    this.engine.process(event);
    return { event, gameState: this.engine.getState() };
  }

  getState(): ArmyState {
    return this.engine.getState();
  }

  reset(): void {
    this.engine.resetRound();
  }
}

export const armyGame: GameDefinition = {
  id: 'army',
  displayName: 'Ordu Savaşı',
  description: 'Kırmızı ve mavi takımların hediyelerle asker üretip savaştığı klasik ordu oyunu.',
  createEngine: () => new ArmyGameAdapter(),
};
