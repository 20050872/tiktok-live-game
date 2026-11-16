import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPrismaClient } from '../../database/prisma';
import { GameEventType } from '../../types/events';
import type { GameEngineUpdate, GameState } from '../../services/GameEngine';
import { LicenseService } from '../../services/LicenseService';

const MAX_BODY_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type UnknownRecord = Record<string, unknown>;

export interface SimulatedEventDependencies {
  processEvent(publisherId: string, eventType: string, payload: unknown): GameEngineUpdate;
  broadcastGameState(publisherId: string, gameState: GameState): void;
  simulateArmyGift?(publisherId: string, username: string, coins: number): GameState;
  addArmyBots?(publisherId: string, count: number): GameState;
}

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new RequestError(415, 'Content-Type application/json bekleniyor.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) tooLarge = true;
    else if (!tooLarge) chunks.push(buffer);
  }

  if (tooLarge) throw new RequestError(413, 'İstek gövdesi çok büyük.');
  if (size === 0) throw new RequestError(400, 'JSON istek gövdesi gerekli.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'Geçerli bir JSON gövdesi gönderin.');
  }
}

function readPositiveInteger(value: unknown, field: string, fallback?: number): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0 || number > 1_000_000_000) {
    throw new RequestError(400, `${field} pozitif bir tam sayı olmalı.`);
  }
  return number;
}

function readNonNegativeInteger(value: unknown, field: string): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0 || number > 1_000_000_000) throw new RequestError(400, `${field} sıfır veya pozitif bir tam sayı olmalı.`);
  return number;
}

function makeEventPayload(type: GameEventType, payload: UnknownRecord): UnknownRecord {
  switch (type) {
    case GameEventType.CHAT: {
      const message = typeof payload.message === 'string' ? payload.message.trim() : '';
      if (!message || message.length > 500) {
        throw new RequestError(400, 'CHAT payload.message 1-500 karakter olmalı.');
      }
      return { message };
    }
    case GameEventType.GIFT: {
      const giftName = typeof payload.giftName === 'string' ? payload.giftName.trim() : '';
      if (!giftName || giftName.length > 100) {
        throw new RequestError(400, 'GIFT payload.giftName 1-100 karakter olmalı.');
      }
      const repeatCount = readPositiveInteger(payload.repeatCount, 'payload.repeatCount', 1);
      const diamondCount = payload.diamondCount === undefined
        ? undefined
        : readPositiveInteger(payload.diamondCount, 'payload.diamondCount');
      return { giftName, repeatCount, ...(diamondCount === undefined ? {} : { diamondCount }) };
    }
    case GameEventType.LIKE:
      return { count: readPositiveInteger(payload.count, 'payload.count', 1) };
    case GameEventType.FOLLOW:
    case GameEventType.JOIN:
      return {};
  }
}

export async function simulateGameEvent(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: SimulatedEventDependencies,
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    if (!isRecord(body)) throw new RequestError(400, 'JSON gövdesi bir nesne olmalı.');

    const overlayToken = typeof body.overlayToken === 'string' ? body.overlayToken.trim() : '';
    const requestedPublisherId = typeof body.publisherId === 'string' ? body.publisherId.trim() : '';
    if (!overlayToken && !requestedPublisherId) {
      throw new RequestError(400, 'overlayToken veya publisherId gönderilmelidir.');
    }
    if (overlayToken && !UUID_PATTERN.test(overlayToken)) {
      throw new RequestError(400, 'overlayToken UUID biçiminde olmalı.');
    }
    if (requestedPublisherId && !UUID_PATTERN.test(requestedPublisherId)) {
      throw new RequestError(400, 'publisherId UUID biçiminde olmalı.');
    }

    const rawType = typeof body.eventType === 'string' ? body.eventType.trim().toUpperCase() : '';
    if (!Object.values(GameEventType).includes(rawType as GameEventType) && !['ARMY_GIFT', 'BOT_ARMY'].includes(rawType)) {
      throw new RequestError(400, 'Desteklenen eventType: CHAT, GIFT, LIKE, FOLLOW, JOIN, ARMY_GIFT, BOT_ARMY.');
    }
    const type = (Object.values(GameEventType).includes(rawType as GameEventType) ? rawType : 'JOIN') as GameEventType;
    const user = isRecord(body.user) ? body.user : body;
    const username = typeof user.username === 'string' ? user.username.trim() : '';
    const userIdValue = user.userId ?? user.id;
    const userId = typeof userIdValue === 'string' ? userIdValue.trim() : username;
    const displayName = typeof user.displayName === 'string' ? user.displayName.trim() : undefined;
    if (!username || username.length > 64 || !userId || userId.length > 128) {
      throw new RequestError(400, 'user.username ve geçerli bir userId (veya username) gerekli.');
    }
    const rawPayload = body.payload === undefined ? {} : body.payload;
    if (!isRecord(rawPayload)) throw new RequestError(400, 'payload bir nesne olmalı.');
    const payload = rawType === 'ARMY_GIFT' || rawType === 'BOT_ARMY' ? {} : makeEventPayload(type, rawPayload);

    let publisherId: string;
    if (overlayToken) {
      const license = await LicenseService.validateToken(overlayToken);
      if (!license) throw new RequestError(403, 'Lisans süresi dolmuş veya geçersiz.');
      publisherId = license.id;
    } else {
      const legacy = await getPrismaClient().user.findUnique({ where: { id: requestedPublisherId }, include: { subscription: true } });
      if (!legacy || legacy.id !== requestedPublisherId || !legacy.subscription || legacy.subscription.expiresAt.getTime() <= Date.now() || !['trial', 'active'].includes(legacy.subscription.status)) {
        throw new RequestError(403, 'Lisans süresi dolmuş veya geçersiz.');
      }
      publisherId = legacy.id;
    }

    if (rawType === 'ARMY_GIFT') {
      if (!dependencies.simulateArmyGift) throw new RequestError(501, 'Ordu hediye simülasyonu kullanılamıyor.');
      const coins = readNonNegativeInteger(rawPayload.coins, 'payload.coins');
      const state = dependencies.simulateArmyGift(publisherId, username, coins);
      dependencies.broadcastGameState(publisherId, state);
      sendJson(response, 200, { status: 'ok', gameState: state });
      return;
    }
    if (rawType === 'BOT_ARMY') {
      if (!dependencies.addArmyBots) throw new RequestError(501, 'Bot ordusu simülasyonu kullanılamıyor.');
      const count = readPositiveInteger(rawPayload.count, 'payload.count', 30);
      const state = dependencies.addArmyBots(publisherId, count);
      dependencies.broadcastGameState(publisherId, state);
      sendJson(response, 200, { status: 'ok', gameState: state });
      return;
    }
    const update = dependencies.processEvent(publisherId, type, {
      user: { userId, uniqueId: username, nickname: displayName },
      ...payload,
    });
    dependencies.broadcastGameState(publisherId, update.gameState);
    sendJson(response, 200, { status: 'ok', event: update.event, gameState: update.gameState });
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.statusCode, { status: 'error', message: error.message });
      return;
    }

    console.error('[Test] Event simülasyonu başarısız.');
    sendJson(response, 503, { status: 'error', message: 'Simüle event şu anda işlenemiyor.' });
  }
}
