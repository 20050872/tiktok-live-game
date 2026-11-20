import type { GameDefinition, IGameEngine } from './types';

/**
 * Tüm oyunların merkezi kayıt sistemi.
 * Yeni oyun eklemek için sadece register() çağırılır.
 */
class GameRegistry {
  private readonly games = new Map<string, GameDefinition>();
  private activeGameId: string | null = null;
  private activeEngine: IGameEngine | null = null;

  register(definition: GameDefinition): void {
    if (this.games.has(definition.id)) {
      throw new Error(`Oyun zaten kayıtlı: ${definition.id}`);
    }
    this.games.set(definition.id, definition);
  }

  list(): GameDefinition[] {
    return Array.from(this.games.values());
  }

  get(gameId: string): GameDefinition | undefined {
    return this.games.get(gameId);
  }

  getActive(): { gameId: string; engine: IGameEngine } | null {
    if (!this.activeGameId || !this.activeEngine) return null;
    return { gameId: this.activeGameId, engine: this.activeEngine };
  }

  setActive(gameId: string): IGameEngine {
    const definition = this.games.get(gameId);
    if (!definition) {
      throw new Error(`Bilinmeyen oyun: ${gameId}`);
    }
    if (this.activeEngine) {
      this.activeEngine.stop();
    }
    this.activeEngine = definition.createEngine();
    this.activeGameId = gameId;
    this.activeEngine.start();
    return this.activeEngine;
  }

  stopActive(): void {
    if (this.activeEngine) {
      this.activeEngine.stop();
      this.activeEngine = null;
      this.activeGameId = null;
    }
  }
}

export const gameRegistry = new GameRegistry();
