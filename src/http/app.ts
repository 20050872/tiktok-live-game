import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { getPrismaClient } from '../database/prisma';
import { registerPublisher } from './routes/auth';
import { getPublisherGameState, getPublisherInfo, publisherGameAction, startPublisherStream, stopPublisherStream } from './routes/publisher';
import { simulateGameEvent, type SimulatedEventDependencies } from './routes/simulate-event';
import { adminLicenses, shopierOsbCallback, shopierWebhook, storePlans, validateLicense } from './routes/licenses';
import type { PublisherGameSessionRegistry } from '../services/PublisherGameSessionRegistry';

const testPagePath = join(process.cwd(), 'public', 'socket-test.html');
const overlayPagePath = join(process.cwd(), 'public', 'overlay.html');
const dashboardPagePath = join(process.cwd(), 'public', 'dashboard.html');
const promoPagePath = join(process.cwd(), 'public', 'promo.html');
const indexPagePath = join(process.cwd(), 'public', 'index.html');
const adminPagePath = join(process.cwd(), 'public', 'admin.html');
const legalDirectory = join(process.cwd(), 'public', 'legal');
const legalAssets = new Map<string, { file: string; contentType: string }>([
  ['/legal/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/index.html', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/kvkk.html', { file: 'kvkk.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/gizlilik.html', { file: 'gizlilik.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/kullanim.html', { file: 'kullanim.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/cerezler.html', { file: 'cerezler.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/mesafeli-satis.html', { file: 'mesafeli-satis.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/on-bilgilendirme.html', { file: 'on-bilgilendirme.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/iade-cayma.html', { file: 'iade-cayma.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/sirket-bilgileri.html', { file: 'sirket-bilgileri.html', contentType: 'text/html; charset=utf-8' }],
  ['/legal/legal.css', { file: 'legal.css', contentType: 'text/css; charset=utf-8' }],
  ['/legal/consent.css', { file: 'consent.css', contentType: 'text/css; charset=utf-8' }],
  ['/legal/legal-ui.js', { file: 'legal-ui.js', contentType: 'text/javascript; charset=utf-8' }],
]);
export interface HttpServerDependencies extends SimulatedEventDependencies {
  publisherSessions: PublisherGameSessionRegistry;
}

export const REGISTERED_HTTP_ROUTES = [
  'GET  /health',
  'GET  /',
  'POST /  (Shopier OSB res/hash callback)',
  'GET  /admin.html',
  'GET  /dashboard.html  (alias: /panel)',
  'GET  /overlay.html',
  'GET  /promo.html',
  'GET  /socket-test.html  (alias: /socket-test)',
  'GET  /legal/*',
  'POST /api/auth/register  (alias: /auth/register)',
  'GET  /api/publisher/info/:token  (alias: /publisher/info/:token)',
  'GET  /api/publisher/game-state/:token',
  'POST /api/publisher/game-action',
  'GET  /api/store/plans',
  'POST /api/webhooks/shopier  (legacy HMAC callback)',
  'POST /api/shopier/callback  (Shopier OSB res/hash)',
  'GET, POST, PATCH, DELETE /api/admin/licenses',
  'POST /api/licenses/validate',
  'POST /api/verify-license',
  'POST /api/publisher/start-stream  (alias: /publisher/start-stream)',
  'POST /api/publisher/stop-stream  (alias: /publisher/stop-stream)',
  'POST /api/test/simulate-event  (aliases: /api/simulate-event, /test/simulate-event, /simulate-event; trailing slash accepted)',
] as const;

export function logRegisteredHttpRoutes(): void {
  console.log('[HTTP] Kayıtlı rotalar:');
  for (const route of REGISTERED_HTTP_ROUTES) console.log(`  ${route}`);
  console.log('  Not: Simülasyon endpoint’i production ortamında ENABLE_TEST_ENDPOINTS=true olmadıkça kapalıdır.');
}

function normalizeRequestPath(requestUrl: string | undefined): string {
  let pathname = new URL(requestUrl ?? '/', 'http://localhost').pathname;
  pathname = `/${pathname.split('/').filter(Boolean).join('/')}`;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
  if (pathname.startsWith('/api/api/')) pathname = pathname.slice(4);

  if (pathname === '/auth/register') return '/api/auth/register';
  if (pathname === '/simulate-event' || pathname === '/test/simulate-event' || pathname === '/api/simulate-event') {
    return '/api/test/simulate-event';
  }
  if (pathname.startsWith('/publisher/')) return `/api${pathname}`;
  return pathname;
}

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpServerDependencies,
): Promise<void> {
  const requestedPathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const pathname = normalizeRequestPath(request.url);

  if (request.method === 'POST' && pathname === '/') {
    await shopierOsbCallback(request, response);
    return;
  }

  if (pathname === '/api/auth/register') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' });
      return;
    }
    await registerPublisher(request, response);
    return;
  }

  if (pathname === '/api/publisher/start-stream' || pathname === '/api/publisher/stop-stream') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' });
      return;
    }
    if (pathname.endsWith('/start-stream')) {
      await startPublisherStream(request, response, dependencies.publisherSessions);
    } else {
      await stopPublisherStream(request, response, dependencies.publisherSessions);
    }
    return;
  }

  if (pathname === '/api/publisher/game-action') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' }); return; }
    await publisherGameAction(request, response, dependencies.publisherSessions);
    return;
  }

  if (pathname === '/api/store/plans') {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca GET kabul eder.' }); return; }
    storePlans(request, response); return;
  }
  if (pathname === '/api/licenses/validate' || pathname === '/api/verify-license') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' }); return; }
    await validateLicense(request, response); return;
  }
  if (pathname === '/api/shopier/callback') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' }); return; }
    await shopierOsbCallback(request, response); return;
  }
  if (pathname === '/api/webhooks/shopier') {
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' }); return; }
    await shopierWebhook(request, response); return;
  }
  if (pathname === '/api/admin/licenses') { await adminLicenses(request, response); return; }

  if (pathname === '/api/test/simulate-event') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca POST kabul eder.' });
      return;
    }
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
      sendJson(response, 403, { status: 'error', message: 'Test endpoint’i production ortamında kapalı. ENABLE_TEST_ENDPOINTS=true ayarlayın.' });
      return;
    }
    await simulateGameEvent(request, response, dependencies);
    return;
  }

  const publisherInfoMatch = pathname.match(/^\/api\/publisher\/info\/([^/]+)$/);
  if (publisherInfoMatch) {
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca GET kabul eder.' });
      return;
    }
    try {
      await getPublisherInfo(decodeURIComponent(publisherInfoMatch[1]), response);
    } catch {
      sendJson(response, 400, { status: 'error', message: 'Geçersiz overlay token.' });
    }
    return;
  }

  const publisherStateMatch = pathname.match(/^\/api\/publisher\/game-state\/([^/]+)$/);
  if (publisherStateMatch) {
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); sendJson(response, 405, { status: 'error', message: 'Bu endpoint yalnızca GET kabul eder.' }); return; }
    await getPublisherGameState(decodeURIComponent(publisherStateMatch[1]), response, dependencies.publisherSessions);
    return;
  }

  if (request.method === 'GET' && pathname === '/health') {
    try {
      await getPrismaClient().$queryRaw`SELECT 1`;
      sendJson(response, 200, {
        status: 'ok',
        message: 'TikTokLiveGame backend çalışıyor',
        db: 'connected',
      });
    } catch {
      console.error('[Health] PostgreSQL bağlantı kontrolü başarısız.');
      sendJson(response, 503, {
        status: 'degraded',
        message: 'TikTokLiveGame backend çalışıyor',
        db: 'disconnected',
      });
    }
    return;
  }

  if (request.method === 'GET' && pathname === '/overlay.html') {
    try {
      const page = await readFile(overlayPagePath);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    } catch {
      sendJson(response, 500, { status: 'error', message: 'Overlay sayfası yüklenemedi.' });
    }
    return;
  }
  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/admin.html')) {
    const filePath = pathname === '/admin.html' ? adminPagePath : indexPagePath;
    try { const page = await readFile(filePath); response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(page); }
    catch { sendJson(response, 500, { status: 'error', message: pathname === '/admin.html' ? 'Yönetici sayfası yüklenemedi.' : 'Ana sayfa yüklenemedi.' }); }
    return;
  }
  if (request.method === 'GET' && pathname === '/promo.html') {
    try {
      const page = await readFile(promoPagePath);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    } catch {
      sendJson(response, 500, { status: 'error', message: 'Tanıtım sayfası yüklenemedi.' });
    }
    return;
  }
  if (request.method === 'GET' && (pathname === '/dashboard.html' || pathname === '/panel')) {
    try {
      const page = await readFile(dashboardPagePath);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    } catch {
      sendJson(response, 500, { status: 'error', message: 'Yayıncı paneli yüklenemedi.' });
    }
    return;
  }
  if (request.method === 'GET' && (pathname === '/socket-test' || pathname === '/socket-test.html')) {
    try {
      const page = await readFile(testPagePath);
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end(page);
    } catch (error) {
      console.error('Socket.IO test sayfası okunamadı:', error);
      sendJson(response, 500, { status: 'error', message: 'Test sayfası yüklenemedi' });
    }
    return;
  }

  const legalAsset = legalAssets.get(pathname);
  if (request.method === 'GET' && legalAsset) {
    try {
      const file = await readFile(join(legalDirectory, legalAsset.file));
      response.writeHead(200, { 'Content-Type': legalAsset.contentType, 'X-Content-Type-Options': 'nosniff' });
      response.end(file);
    } catch {
      sendJson(response, 500, { status: 'error', message: 'Yasal bilgilendirme dosyası yüklenemedi.' });
    }
    return;
  }

  console.warn(`[HTTP] Endpoint bulunamadı: ${request.method ?? 'UNKNOWN'} ${requestedPathname}`);
  sendJson(response, 404, { status: 'error', message: 'Endpoint bulunamadı' });
}

export function createHttpServer(dependencies: HttpServerDependencies) {
  return createServer((request, response) => {
    void handleHttpRequest(request, response, dependencies);
  });
}
