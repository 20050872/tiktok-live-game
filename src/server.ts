import 'dotenv/config';
import { createHttpServer, logRegisteredHttpRoutes } from './http/app';
import { attachSocketServer } from './realtime/socket';
import { PublisherGameSessionRegistry } from './services/PublisherGameSessionRegistry';
import type { GameState } from './services/GameEngine';

export function createBackendServer() {
  let io: ReturnType<typeof attachSocketServer> | undefined;
  const gameSessions = new PublisherGameSessionRegistry((publisherId, gameState) => {
    if (!io) throw new Error('Socket.IO henüz başlatılmadı.');
    io.to(publisherId).emit('game:state', gameState);
  });
  const httpServer = createHttpServer({
    publisherSessions: gameSessions,
    processEvent: (publisherId, eventType, payload) => gameSessions.processEvent(publisherId, eventType, payload),
    broadcastGameState: (publisherId: string, gameState: GameState) => {
      if (!io) throw new Error('Socket.IO henüz başlatılmadı.');
      io.to(publisherId).emit('game:state', gameState);
    },
    simulateArmyGift: (publisherId: string, username: string, coins: number) => gameSessions.simulateArmyGift(publisherId, username, coins),
    addArmyBots: (publisherId: string, count: number) => gameSessions.addArmyBots(publisherId, count),
  });
  io = attachSocketServer(httpServer);
  return { httpServer, io };
}

export function startBackendServer(port: string | number = process.env.PORT || 10000) {
  const PORT = Number(port);
  const { httpServer, io } = createBackendServer();

  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    console.error('HTTP sunucusu başlatılamadı:', error.message);
    process.exitCode = 1;
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TikTokLiveGame backend çalışıyor: http://localhost:${PORT}`);
    logRegisteredHttpRoutes();
  });

  return { httpServer, io };
}

if (require.main === module) {
  startBackendServer();
}
