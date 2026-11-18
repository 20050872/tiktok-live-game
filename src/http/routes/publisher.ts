import type { ServerResponse } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { getPrismaClient } from '../../database/prisma';
import type { PublisherGameSessionRegistry } from '../../services/PublisherGameSessionRegistry';
import { LicenseService, type ValidLicense } from '../../services/LicenseService';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

const MAX_BODY_BYTES = 8 * 1024;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readPublisherBody(request: IncomingMessage): Promise<JsonRecord> {
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error('Content-Type application/json bekleniyor.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_BODY_BYTES) throw new Error('İstek gövdesi çok büyük.');
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!isRecord(value)) throw new Error('JSON gövdesi bir nesne olmalı.');
  return value;
}

function normalizeTikTokUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const username = value.trim().replace(/^@/, '');
  return /^[A-Za-z0-9._]{2,64}$/.test(username) ? username : undefined;
}

async function findPublisherForStream(token: unknown) {
  if (typeof token !== 'string' || !UUID_PATTERN.test(token)) return null;
  return LicenseService.validateToken(token);
}

function invalidLicense(response: ServerResponse): void { sendJson(response, 403, { status: 'error', message: 'Lisans süresi dolmuş veya geçersiz.' }); }

export async function startPublisherStream(
  request: IncomingMessage,
  response: ServerResponse,
  registry: PublisherGameSessionRegistry,
): Promise<void> {
  let body: JsonRecord;
  try {
    body = await readPublisherBody(request);
  } catch (error) {
    sendJson(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Geçersiz istek.' });
    return;
  }
  const username = normalizeTikTokUsername(body.tiktokUsername);
  if (!username || typeof body.token !== 'string' || !UUID_PATTERN.test(body.token)) {
    sendJson(response, 400, { status: 'error', message: 'Geçerli token ve tiktokUsername gerekli.' });
    return;
  }
  try {
    const publisher = await findPublisherForStream(body.token);
    if (!publisher) { invalidLicense(response); return; }
    const result = await registry.startLicensedStream(body.token, username);
    sendJson(response, 200, { status: 'ok', stream: result });
  } catch (error) {
    if (error instanceof Error && error.message.includes('Lisans')) { invalidLicense(response); return; }
    console.error('[Publisher] TikTok yayını başlatılamadı:', error instanceof Error ? error.message : 'bilinmeyen hata');
    sendJson(response, 502, { status: 'error', message: 'TikTok yayınına bağlanılamadı. Kullanıcı adını ve yayının canlı olduğunu kontrol edin.' });
  }
}

export async function stopPublisherStream(
  request: IncomingMessage,
  response: ServerResponse,
  registry: PublisherGameSessionRegistry,
): Promise<void> {
  let body: JsonRecord;
  try {
    body = await readPublisherBody(request);
  } catch (error) {
    sendJson(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Geçersiz istek.' });
    return;
  }
  try {
    const publisher = await findPublisherForStream(body.token);
    if (!publisher) { invalidLicense(response); return; }
    const stopped = await registry.stopStream(publisher.id);
    sendJson(response, 200, { status: 'ok', stream: 'stopped', wasConnected: stopped });
  } catch (error) {
    console.error('[Publisher] TikTok yayını durdurulamadı:', error instanceof Error ? error.message : 'bilinmeyen hata');
    sendJson(response, 503, { status: 'error', message: 'TikTok yayını şu anda durdurulamıyor.' });
  }
}

export async function getPublisherInfo(token: string, response: ServerResponse): Promise<void> {
  if (!UUID_PATTERN.test(token)) {
    sendJson(response, 404, { status: 'error', message: 'Yayıncı bulunamadı.' });
    return;
  }

  try {
    const license = await LicenseService.validateToken(token);
    if (!license) { invalidLicense(response); return; }
    const remainingMs = license.expiresAt === null ? null : Math.max(0, license.expiresAt.getTime() - Date.now());

    sendJson(response, 200, {
      status: 'ok',
      publisher: {
        id: license.id,
        tiktokUsername: license.customerName,
        customerEmail: license.customerEmail,
        createdAt: license.createdAt,
      },
      subscription: {
            status: remainingMs === 0 ? 'expired' : 'active',
            expiresAt: license.expiresAt,
            remainingMs,
            remainingSeconds: remainingMs === null ? null : Math.ceil(remainingMs / 1000),
            isActive: license.isActive && (remainingMs === null || remainingMs > 0),
            planType: license.planType,
          },
    });
  } catch {
    console.error('[Publisher] Bilgi sorgusu başarısız.');
    sendJson(response, 503, { status: 'error', message: 'Yayıncı bilgisi şu anda alınamıyor.' });
  }
}

async function findActivePublisher(token: unknown) {
  return findPublisherForStream(token);
}

export async function getPublisherGameState(token: string, response: ServerResponse, registry: PublisherGameSessionRegistry): Promise<void> {
  try {
    const publisher = await findActivePublisher(token);
    if (!publisher) { invalidLicense(response); return; }
    sendJson(response, 200, { status: 'ok', streamConnected: registry.getStreamStatus(publisher.id), gameState: registry.getGameState(publisher.id) });
  } catch {
    sendJson(response, 503, { status: 'error', message: 'Canlı oyun durumu alınamadı.' });
  }
}

export async function publisherGameAction(request: IncomingMessage, response: ServerResponse, registry: PublisherGameSessionRegistry): Promise<void> {
  let body: JsonRecord;
  try { body = await readPublisherBody(request); }
  catch (error) { sendJson(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Geçersiz istek.' }); return; }
  try {
    const publisher = await findActivePublisher(body.token);
    if (!publisher) { invalidLicense(response); return; }
    let gameState;
    if (body.action === 'start-round') gameState = registry.startBattleNow(publisher.id);
    else if (body.action === 'reset-round') gameState = registry.resetArmyRound(publisher.id);
    else if (body.action === 'reset-leaderboard') gameState = registry.resetArmyLeaderboard(publisher.id);
    else { sendJson(response, 400, { status: 'error', message: 'Geçersiz oyun işlemi.' }); return; }
    sendJson(response, 200, { status: 'ok', gameState });
  } catch {
    sendJson(response, 503, { status: 'error', message: 'Oyun kontrolü şu anda tamamlanamadı.' });
  }
}
