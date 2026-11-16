import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPrismaClient } from '../../database/prisma';
import { LicenseService } from '../../services/LicenseService';
import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 8 * 1024;
const TRIAL_DAYS = 7;

class RequestError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
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
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
    } else if (!tooLarge) {
      chunks.push(buffer);
    }
  }

  if (tooLarge) throw new RequestError(413, 'İstek gövdesi çok büyük.');
  if (size === 0) throw new RequestError(400, 'JSON istek gövdesi gerekli.');

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestError(400, 'Geçerli bir JSON gövdesi gönderin.');
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export async function registerPublisher(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    const body = await readJsonBody(request);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RequestError(400, 'JSON gövdesi bir nesne olmalı.');
    }

    const rawUsername = (body as Record<string, unknown>).tiktokUsername;
    if (typeof rawUsername !== 'string') {
      throw new RequestError(400, 'tiktokUsername metin olarak gönderilmelidir.');
    }

    const tiktokUsername = rawUsername.trim();
    if (
      tiktokUsername.length === 0 ||
      tiktokUsername.length > 64 ||
      /[\u0000-\u001f\u007f]/.test(tiktokUsername)
    ) {
      throw new RequestError(400, 'tiktokUsername boş olamaz ve en fazla 64 karakter olmalıdır.');
    }

    const prisma = getPrismaClient();
    const existingUser = await prisma.user.findUnique({ where: { tiktokUsername } });
    if (existingUser) {
      sendJson(response, 409, { status: 'error', message: 'Bu TikTok kullanıcı adı kayıtlı.' });
      return;
    }

    const expiresAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
    const overlayToken = randomUUID();
    const user = await prisma.user.create({
      data: {
        tiktokUsername,
        overlayToken,
        subscription: {
          create: {
            status: 'trial',
            expiresAt,
          },
        },
      },
      include: { subscription: true },
    });
    await LicenseService.create({ overlayToken, customerName: tiktokUsername, customerEmail: '', orderId: `REGISTER-${user.id}`, planType: 'SEVEN_DAYS', expiresAt });

    sendJson(response, 201, {
      status: 'ok',
      user: {
        id: user.id,
        tiktokUsername: user.tiktokUsername,
        overlayToken: user.overlayToken,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      subscription: user.subscription,
    });
  } catch (error) {
    if (error instanceof RequestError) {
      sendJson(response, error.statusCode, { status: 'error', message: error.message });
      return;
    }

    if (isUniqueConstraintError(error)) {
      sendJson(response, 409, { status: 'error', message: 'Bu TikTok kullanıcı adı kayıtlı.' });
      return;
    }

    console.error('[Auth] Yayıncı kaydı başarısız.');
    sendJson(response, 500, { status: 'error', message: 'Kayıt şu anda tamamlanamadı.' });
  }
}
