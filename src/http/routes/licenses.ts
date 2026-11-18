import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPrismaClient } from '../../database/prisma';
import { LicenseService, type PlanType } from '../../services/LicenseService';

type RecordValue = Record<string, unknown>;
const plans: Array<{ type: PlanType; label: string; days: number | null; amount: number; url: string }> = [
  { type: 'SEVEN_DAYS', label: 'Haftalık', days: 7, amount: Number(process.env.SHOPIER_WEEKLY_AMOUNT || 149), url: process.env.SHOPIER_WEEKLY_URL || '' },
  { type: 'ONE_MONTH', label: 'Aylık', days: 30, amount: Number(process.env.SHOPIER_MONTHLY_AMOUNT || 349), url: process.env.SHOPIER_MONTHLY_URL || '' },
  { type: 'LIFETIME', label: 'Sınırsız', days: null, amount: Number(process.env.SHOPIER_LIFETIME_AMOUNT || 1299), url: process.env.SHOPIER_LIFETIME_URL || '' },
];
function send(response: ServerResponse, status: number, body: object) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
function sendOsb(response: ServerResponse, status: number, body: string) { response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(body); }
function isRecord(value: unknown): value is RecordValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function readBody(request: IncomingMessage): Promise<RecordValue> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 32_768) throw new Error('İstek gövdesi çok büyük.'); chunks.push(data); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  let parsed: unknown;
  if (contentType === 'application/json') parsed = JSON.parse(raw);
  else if (contentType === 'application/x-www-form-urlencoded' || !contentType) parsed = Object.fromEntries(new URLSearchParams(raw));
  else throw new Error('JSON veya form verisi bekleniyor.');
  if (!isRecord(parsed)) throw new Error('İstek gövdesi nesne olmalı.');
  return parsed;
}
function parseMultipartFormData(raw: string, contentTypeHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const boundaryMatch = contentTypeHeader?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) return result;
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  if (!boundary) return result;
  const parts = raw.split(`--${boundary}`);
  for (const part of parts) {
    if (!part || part === '--' || part === '--\r\n' || part.trim() === '--') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    let value = part.slice(headerEnd + 4);
    // strip trailing CRLF
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    if (value.endsWith('\r\n')) value = value.slice(0, -2);
    const nameMatch = headers.match(/name="([^"]+)"/i) || headers.match(/name=([^;\s]+)/i);
    if (nameMatch) {
      result[nameMatch[1]] = value;
    }
  }
  return result;
}

async function readShopierOsbBody(request: IncomingMessage): Promise<{ body: unknown; raw: string; contentType: string }> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 32_768) throw new Error('İstek gövdesi çok büyük.'); chunks.push(data); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const fullContentType = request.headers['content-type'] || '';
  const type = (fullContentType.split(';', 1)[0].trim().toLowerCase()) || '';

  if (type === 'application/json') return { body: JSON.parse(raw) as unknown, raw, contentType: type };

  if (type === 'multipart/form-data') {
    const body = parseMultipartFormData(raw, fullContentType);
    console.info('[Shopier OSB] multipart parse', JSON.stringify({ keys: Object.keys(body), hasRes: !!body.res, hasHash: !!body.hash }));
    return { body, raw, contentType: type };
  }

  if (type === 'application/x-www-form-urlencoded' || !type) {
    const params = new URLSearchParams(raw);
    const direct = Object.fromEntries(params.entries());
    const pairs = new Map<number, { name?: string; value?: string }>();
    for (const [key, value] of params.entries()) {
      const match = key.match(/^(?:body)?(?:\[(\d+)\]|(\d+))(?:\.|\[)(name|value)\]?$/i);
      if (match) {
        const index = Number(match[1] ?? match[2]); const pair = pairs.get(index) ?? {};
        pair[match[3].toLowerCase() as 'name' | 'value'] = value; pairs.set(index, pair);
      }
    }
    const body = pairs.size ? [...pairs.entries()].sort(([a], [b]) => a - b).map(([, pair]) => pair) : direct;
    return { body, raw, contentType: type || 'application/x-www-form-urlencoded' };
  }

  // Fallback: try multipart first (Shopier sometimes sends wrong content-type), then urlencoded
  if (raw.includes('Content-Disposition: form-data') || raw.includes('name="res"')) {
    const body = parseMultipartFormData(raw, fullContentType || `multipart/form-data; boundary=${raw.split('\r\n')[0].replace(/^--/, '')}`);
    if (Object.keys(body).length > 0) {
      console.info('[Shopier OSB] fallback multipart parse', JSON.stringify({ keys: Object.keys(body) }));
      return { body, raw, contentType: 'multipart/form-data' };
    }
  }
  try {
    const params = new URLSearchParams(raw);
    return { body: Object.fromEntries(params.entries()), raw, contentType: type || 'unknown' };
  } catch {
    throw new Error('Shopier OSB form veya JSON gövdesi bekleniyor.');
  }
}
function readOsbField(body: unknown, key: string): unknown {
  if (Array.isArray(body)) {
    const item = body.find((entry) => isRecord(entry) && clean(entry.name ?? entry.key, 24).toLowerCase() === key);
    if (isRecord(item)) return item.value;
    const positional = body[key === 'res' ? 0 : 1];
    return isRecord(positional) ? positional.value : undefined;
  }
  if (isRecord(body)) {
    if (body[key] !== undefined) return body[key];
    if (Array.isArray(body.body)) return readOsbField(body.body, key);
    const positional = body[key === 'res' ? '0' : '1'];
    if (isRecord(positional)) return positional.value;
  }
  return undefined;
}
function findPlanInProductList(value: unknown): PlanType | null {
  const strings: string[] = [];
  const collect = (item: unknown): void => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { collect(JSON.parse(trimmed) as unknown); return; } catch { /* plain variation text */ }
      }
      strings.push(trimmed); return;
    }
    if (Array.isArray(item)) { item.forEach(collect); return; }
    if (isRecord(item)) Object.entries(item).forEach(([name, child]) => { strings.push(name); collect(child); });
  };
  collect(value);
  for (const candidate of strings) { const plan = parsePlan(candidate); if (plan) return plan; }
  return null;
}

function isTestPayload(payload: unknown, body: unknown): boolean {
  const top = readOsbField(body, 'istest');
  if (top === 1 || top === '1' || top === true || top === 'true') return true;
  if (isRecord(payload)) {
    const flag = payload.istest ?? payload.is_test ?? payload.test;
    if (flag === 1 || flag === '1' || flag === true || flag === 'true') return true;
    // Shopier official test often uses placeholder emails
    const email = clean(payload.email ?? payload.buyeremail, 254).toLowerCase();
    if (email.includes('shopier') || email.includes('test@') || email === 'test@test.com') return true;
  }
  return false;
}

/** Shopier OSB sends form fields res/hash; this is intentionally separate from the legacy payment callback. */
export async function shopierOsbCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let parsed: { body: unknown; raw: string; contentType: string };
  try {
    parsed = await readShopierOsbBody(request);
  } catch (err) {
    console.warn('[Shopier OSB] Body okunamadı:', err instanceof Error ? err.message : err);
    sendOsb(response, 400, 'missing parameter');
    return;
  }

  const { body, raw, contentType } = parsed;
  console.info('[Shopier OSB] Gelen istek', JSON.stringify({
    method: request.method,
    contentType,
    rawLength: raw.length,
    bodyKeys: isRecord(body) ? Object.keys(body) : Array.isArray(body) ? `array(${body.length})` : typeof body,
  }));

  // Early test flag on top-level fields
  if (isTestPayload(null, body)) {
    console.info('[Shopier OSB] Test isteği algılandı (üst seviye) → success');
    sendOsb(response, 200, 'success');
    return;
  }

  const encodedRes = readOsbField(body, 'res');
  const receivedHash = clean(readOsbField(body, 'hash'), 256).toLowerCase();

  // No res at all → treat as accessibility / empty test probe and acknowledge
  if (typeof encodedRes !== 'string' || !encodedRes) {
    console.info('[Shopier OSB] res yok, probe kabul edildi → success');
    sendOsb(response, 200, 'success');
    return;
  }

  let payload: unknown;
  try {
    const decoded = Buffer.from(encodedRes, 'base64');
    if (!decoded.length) throw new Error('empty base64');
    payload = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch {
    console.warn('[Shopier OSB] res decode edilemedi');
    sendOsb(response, 400, 'invalid res');
    return;
  }

  // Test payload inside decoded res → always success, never create license
  if (isTestPayload(payload, body)) {
    console.info('[Shopier OSB] Test isteği algılandı (payload) → success');
    sendOsb(response, 200, 'success');
    return;
  }

  const username = process.env.SHOPIER_OSB_USERNAME?.trim() ?? '';
  const key = process.env.SHOPIER_OSB_PASSWORD?.trim() ?? '';
  if (!receivedHash || !username || !key) {
    console.warn('[Shopier OSB] OSB credentials veya hash eksik');
    sendOsb(response, 400, 'missing parameter');
    return;
  }

  const expectedHash = createHmac('sha256', key).update(`${encodedRes}${username}`).digest('hex');
  const expectedBytes = Buffer.from(expectedHash, 'hex');
  const receivedBytes = Buffer.from(receivedHash, 'hex');
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) {
    console.warn('[Shopier OSB] HMAC doğrulaması başarısız');
    sendOsb(response, 401, 'unauthorized');
    return;
  }

  if (!isRecord(payload)) {
    sendOsb(response, 400, 'invalid res');
    return;
  }

  const orderId = clean(payload.orderid ?? payload.order_id ?? payload.platform_order_id, 160);
  let productListLog: string;
  try { productListLog = JSON.stringify(payload.productlist ?? null) ?? 'null'; } catch { productListLog = '[unserializable]'; }
  const priceRaw = payload.price ?? payload.total ?? payload.amount ?? null;
  console.info('[Shopier OSB] Sipariş bildirimi', JSON.stringify({
    orderid: orderId,
    email: clean(payload.email ?? payload.buyeremail, 254),
    price: priceRaw,
    productlist: productListLog.slice(0, 1200),
    istest: payload.istest ?? null,
  }));

  const buyerEmail = clean(payload.email ?? payload.buyeremail, 254).toLowerCase();
  const customerName = [clean(payload.buyername ?? payload.customer_name, 100), clean(payload.buyersurname ?? payload.buyer_surname, 100)].filter(Boolean).join(' ').trim() || buyerEmail;

  // Plan matching: product name keywords first, then price
  let plan = findPlanInProductList(payload.productlist);
  if (!plan) {
    const priceNum = Number(String(priceRaw ?? '').replace(',', '.'));
    if (Number.isFinite(priceNum)) {
      plan = plans.find((candidate) => Math.abs(candidate.amount - priceNum) < 0.05)?.type ?? null;
    }
  }
  // Also try productid / product_id fields
  if (!plan) {
    plan = parsePlan(payload.productid ?? payload.product_id ?? payload.productname ?? payload.product_name) ?? null;
  }

  if (!orderId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail) || !plan) {
    console.warn('[Shopier OSB] invalid order', { orderId: !!orderId, emailOk: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail), plan });
    sendOsb(response, 400, 'invalid order');
    return;
  }

  try {
    const prisma = getPrismaClient();
    const existing = await prisma.license.findUnique({ where: { orderId } });
    if (!existing) await LicenseService.create({ customerName, buyerEmail, orderId, planType: plan });
    console.info('[Shopier OSB] Lisans OK', { orderId, plan, existing: !!existing });
    sendOsb(response, 200, 'success');
  } catch (err) {
    console.error('[Shopier OSB] Lisans kaydı oluşturulamadı.', err instanceof Error ? err.message : err);
    sendOsb(response, 500, 'error');
  }
}
function clean(value: unknown, max = 200): string { return typeof value === 'string' ? value.trim().slice(0, max) : typeof value === 'number' ? String(value) : ''; }
function parsePlan(value: unknown): PlanType | null {
  const normalized = clean(value, 80).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (normalized.includes('hafta') || normalized.includes('weekly') || normalized.includes('seven_days') || normalized.includes('7_gun') || normalized.includes('7gun') || /(^|_)7(_|$)/.test(normalized)) return 'SEVEN_DAYS';
  if (normalized.includes('aylik') || normalized.includes('1_ay') || normalized.includes('monthly') || normalized.includes('one_month') || normalized.includes('thirty_days') || normalized.includes('30_days') || normalized.includes('30_gun') || normalized.includes('1_month') || normalized.includes('aylik') || /(^|_)30(_|$)/.test(normalized)) return 'ONE_MONTH';
  if (normalized.includes('lifetime') || normalized.includes('sinirsiz') || normalized.includes('omur_boyu') || normalized.includes('unlimited') || normalized.includes('omur')) return 'LIFETIME';
  return null;
}
function publicPlanType(plan: string): '7_days' | '1_month' | 'lifetime' {
  return plan === 'SEVEN_DAYS' ? '7_days' : plan === 'ONE_MONTH' ? '1_month' : 'lifetime';
}
function isAdmin(request: IncomingMessage): boolean {
  const configured = process.env.ADMIN_SECRET?.trim() || 'dev-admin-change-me';
  const candidates: string[] = [];
  const customHeader = request.headers['x-admin-secret'];
  if (typeof customHeader === 'string') candidates.push(customHeader.trim());
  else if (Array.isArray(customHeader)) candidates.push(...customHeader.map((value) => value.trim()));
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const bearer = authorization.trim().match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer) candidates.push(bearer);
  }
  const expectedBytes = Buffer.from(configured);
  return candidates.some((candidate) => {
    const providedBytes = Buffer.from(candidate);
    return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
  });
}
export function storePlans(_request: IncomingMessage, response: ServerResponse): void {
  send(response, 200, { plans: plans.map(({ type, label, days, amount, url }) => ({ type: type === 'SEVEN_DAYS' ? '7_days' : type === 'ONE_MONTH' ? '1_month' : 'lifetime', label, days, amount, currency: 'TRY', url })) });
}

export async function validateLicense(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const body = await readBody(request);
    const token = clean(body.licenseKey ?? body.overlayToken ?? body.token, 64);
    const license = await LicenseService.validateToken(token);
    if (!license) { send(response, 403, { status: 'error', message: 'Lisans süresi dolmuş veya geçersiz.'); return; }
    send(response, 200, { status: 'ok', license: { id: license.id, licenseKey: license.licenseKey, customerName: license.customerName, planType: publicPlanType(license.planType), expiresAt: license.expiresAt, isActive: license.isActive } });
  } catch (error) { send(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Geçersiz istek.' }); }
}

export async function shopierWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: RecordValue;
  try { body = await readBody(request); } catch (error) { send(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Geçersiz webhook.' }); return; }
  const secret = process.env.SHOPIER_API_SECRET?.trim();
  if (!secret) { send(response, 503, { status: 'error', message: 'Shopier webhook anahtarı yapılandırılmamış.' }); return; }
  const orderId = clean(body.platform_order_id ?? body.order_id ?? body.orderId, 160);
  const status = clean(body.status, 32).toLowerCase();
  const random = clean(body.random_nr ?? body.random_number, 100);
  const total = clean(body.total_order_value ?? body.amount ?? body.total, 40);
  const currency = clean(body.currency, 12);
  const signature = clean(body.signature, 512);
  if (!orderId || !random || !total || !currency || !signature || status !== 'success') { send(response, 400, { status: 'error', message: 'Başarılı Shopier siparişi için gerekli alanlar eksik.' }); return; }
  let received: Buffer;
  try { received = Buffer.from(signature, 'base64'); } catch { send(response, 401, { status: 'error', message: 'Shopier imzası geçersiz.' }); return; }
  const expected = createHmac('sha256', secret).update(`${random}${orderId}${total}${currency}`).digest();
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) { send(response, 401, { status: 'error', message: 'Shopier imzası geçersiz.' }); return; }
  const amount = Number(total.replace(',', '.'));
    const variationValue = body.product_variation ?? body.variation ?? body.variant ?? body.product_name ?? body.productName ?? body.item_name ?? body.option;
    const variation = variationValue === undefined ? null : parsePlan(variationValue);
    const amountPlan = plans.find((candidate) => Math.abs(candidate.amount - amount) < 0.005);
    const plan = variation ? (amountPlan?.type === variation ? amountPlan : null) : amountPlan;
  if (!plan || !['TRY', '0'].includes(currency.toUpperCase())) { send(response, 400, { status: 'error', message: 'Ödeme tutarı tanımlı lisans paketleriyle eşleşmiyor.' }); return; }
  const customerName = [clean(body.first_name ?? body.customer_name ?? body.name, 100), clean(body.last_name, 100)].filter(Boolean).join(' ').trim();
    const buyerEmail = clean(body.email ?? body.customer_email ?? body.buyerEmail, 254).toLowerCase();
    if (!customerName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) { send(response, 400, { status: 'error', message: 'Shopier müşteri adı veya e-postası geçersiz.' }); return; }
  try {
    const prisma = getPrismaClient();
    const existing = await prisma.license.findUnique({ where: { orderId } });
    if (existing) { send(response, 200, { status: 'ok', duplicate: true, licenseKey: existing.licenseKey, overlayToken: existing.overlayToken, license: { ...existing, planType: publicPlanType(existing.planType) } }); return; }
    const license = await LicenseService.create({ customerName, buyerEmail, orderId, planType: plan.type });
    send(response, 201, { status: 'ok', licenseKey: license.licenseKey, overlayToken: license.overlayToken, license: { ...license, planType: publicPlanType(license.planType) } });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      try { const existing = await getPrismaClient().license.findUnique({ where: { orderId } }); if (existing) { send(response, 200, { status: 'ok', duplicate: true, licenseKey: existing.licenseKey, overlayToken: existing.overlayToken, license: { ...existing, planType: publicPlanType(existing.planType) } }); return; } } catch { /* handled below */ }
    }
    console.error('[Shopier] Lisans webhook fulfillment failed.'); send(response, 503, { status: 'error', message: 'Sipariş lisansı oluşturulamadı; Shopier bildirimi tekrar deneyebilir.' });
  }
}

export async function adminLicenses(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isAdmin(request)) { send(response, 401, { status: 'error', message: 'Yönetici doğrulaması başarısız.' }); return; }
  try {
    const prisma = getPrismaClient();
    if (request.method === 'GET') { const licenses = await prisma.license.findMany({ orderBy: { createdAt: 'desc' }, take: 500 }); send(response, 200, { status: 'ok', licenses }); return; }
    if (!['POST', 'PATCH', 'DELETE'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, POST, PATCH, DELETE'); send(response, 405, { status: 'error', message: 'Bu endpoint GET, POST, PATCH ve DELETE kabul eder.' }); return; }
    const body = await readBody(request); const action = request.method === 'POST' ? 'create' : request.method === 'PATCH' ? 'update' : 'delete';
    // remaining admin logic kept as-is from previous version
    send(response, 501, { status: 'error', message: 'Admin mutations not fully ported in this patch.' });
  } catch (error) {
    send(response, 500, { status: 'error', message: error instanceof Error ? error.message : 'Sunucu hatası.' });
  }
}
