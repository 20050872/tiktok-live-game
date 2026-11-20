import { gameRegistry } from './shared/registry';
import { armyGame } from './army';

/** Tüm oyunları kaydet. Yeni oyun eklerken buraya bir satır ekle. */
gameRegistry.register(armyGame);

export { gameRegistry } from './shared/registry';
export type { IGameEngine, GameUpdate, GameEffect, GameDefinition } from './shared/types';
