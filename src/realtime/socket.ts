import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import { LicenseService } from '../services/LicenseService';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function attachSocketServer(httpServer: HttpServer): SocketIOServer {
  const io = new SocketIOServer(httpServer);

  io.use(async (socket, next) => {
    const token = socket.handshake.query.token;
    if (typeof token !== 'string' || !UUID_PATTERN.test(token)) {
      next(new Error('unauthorized'));
      return;
    }

    try {
      const license = await LicenseService.validateToken(token);
      if (!license) {
        next(new Error('unauthorized'));
        return;
      }
      socket.data.publisherId = license.id;
      await socket.join(license.id);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const publisherId = socket.data.publisherId as string;
    console.log(`[Socket.IO] Yayıncı bağlandı: id=${socket.id}, yayıncı=${publisherId}`);

    socket.on('test:send', (input: unknown) => {
      const message = typeof input === 'string' ? input.trim() : '';
      if (message.length === 0 || message.length > 200) {
        socket.emit('test:error', { message: 'Test mesajı 1-200 karakter arasında olmalı.' });
        return;
      }

      io.to(publisherId).emit('test:message', {
        message,
        from: socket.id,
        sentAt: new Date().toISOString(),
      });
    });

    socket.on('disconnect', (reason: string) => {
      console.log(`[Socket.IO] Yayıncı bağlantısı kesildi: id=${socket.id}, yayıncı=${publisherId}, neden=${reason}`);
    });
  });

  return io;
}
