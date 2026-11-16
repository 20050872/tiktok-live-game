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
async function readShopierOsbBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += data.length; if (size > 32_768) throw new Error('İstek gövdesi çok büyük.'); chunks.push(data); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type === 'application/json') return JSON.parse(raw) as unknown;
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
    return pairs.size ? [...pairs.entries()].sort(([a], [b]) => a - b).map(([, pair]) => pair) : direct;
  }
  throw new Error('Shopier OSB form veya JSON gövdesi bekleniyor.');
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

/** Shopier OSB sends form fields res/hash; this is intentionally separate from the legacy payment callback. */
export async function shopierOsbCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let body: unknown;
  try { body = await readShopierOsbBody(request); }
  catch { sendOsb(response, 400, 'missing parameter'); return; }
  const encodedRes = readOsbField(body, 'res');
  const receivedHash = clean(readOsbField(body, 'hash'), 256).toLowerCase();
  const username = process.env.SHOPIER_OSB_USERNAME?.trim() ?? '';
  const key = process.env.SHOPIER_OSB_PASSWORD?.trim() ?? '';
  if (typeof encodedRes !== 'string' || !encodedRes || !receivedHash || !username || !key) { sendOsb(response, 400, 'missing parameter'); return; }

  const expectedHash = createHmac('sha256', key).update(`${encodedRes}${username}`).digest('hex');
  const expectedBytes = Buffer.from(expectedHash, 'hex'); const receivedBytes = Buffer.from(receivedHash, 'hex');
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) { sendOsb(response, 401, 'unauthorized'); return; }

  let payload: unknown;
  try {
    const decoded = Buffer.from(encodedRes, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== encodedRes.replace(/\s/g, '').replace(/=+$/, '')) throw new Error('bad base64');
    payload = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch { sendOsb(response, 400, 'invalid res'); return; }
  if (!isRecord(payload)) { sendOsb(response, 400, 'invalid res'); return; }

  const orderId = clean(payload.orderid ?? payload.order_id ?? payload.platform_order_id, 160);
  const buyerEmail = clean(payload.email ?? payload.buyeremail, 254).toLowerCase();
  const customerName = [clean(payload.buyername ?? payload.customer_name, 100), clean(payload.buyersurname ?? payload.buyer_surname, 100)].filter(Boolean).join(' ').trim() || buyerEmail;
  const plan = findPlanInProductList(payload.productlist) ?? plans.find((candidate) => Math.abs(candidate.amount - Number(String(payload.price ?? '').replace(',', '.'))) < 0.005)?.type ?? null;
  if (!orderId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail) || !plan) { sendOsb(response, 400, 'invalid order'); return; }

  try {
    const prisma = getPrismaClient();
    const existing = await prisma.license.findUnique({ where: { orderId } });
    if (!existing) await LicenseService.create({ customerName, buyerEmail, orderId, planType: plan });
    sendOsb(response, 200, 'success');
  } catch {
    console.error('[Shopier OSB] Lisans kaydı oluşturulamadı.');
    sendOsb(response, 500, 'error');
  }
}
function clean(value: unknown, max = 200): string { return typeof value === 'string' ? value.trim().slice(0, max) : typeof value === 'number' ? String(value) : ''; }
function parsePlan(value: unknown): PlanType | null {
  const normalized = clean(value, 80).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized.includes('hafta') || normalized.includes('weekly') || normalized.includes('seven_days') || /(^|_)7(_|$)/.test(normalized)) return 'SEVEN_DAYS';
  if (normalized.includes('aylik') || normalized.includes('1_ay') || normalized.includes('monthly') || normalized.includes('one_month') || normalized.includes('thirty_days') || normalized.includes('30_days') || normalized.includes('30_gun') || normalized.includes('1_month') || /(^|_)30(_|$)/.test(normalized)) return 'ONE_MONTH';
  return normalized.includes('lifetime') || normalized.includes('sinirsiz') || normalized.includes('omur_boyu') ? 'LIFETIME' : null;
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
    if (!license) { send(response, 403, { status: 'error', message: 'Lisans süresi dolmuş veya geçersiz.' }); return; }
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
    const body = await readBody(request); const action = request.method === 'DELETE' ? 'deactivate' : clean(body.action, 32);
    if (action === 'create') {
      const name = clean(body.customerName, 120); const email = clean(body.buyerEmail ?? body.customerEmail, 254).toLowerCase(); const planType = parsePlan(body.planType);
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !planType) { send(response, 400, { status: 'error', message: 'Ad, geçerli e-posta ve geçerli paket zorunlu.' }); return; }
      const orderId = clean(body.orderId, 160) || `ADMIN-${randomUUID()}`;
      const license = await LicenseService.create({ customerName: name, buyerEmail: email, orderId, planType }); send(response, 201, { status: 'ok', licenseKey: license.licenseKey, license }); return;
    }
    const id = clean(body.id ?? new URL(request.url ?? '/', 'http://localhost').searchParams.get('id'), 64);
    if (!id) { send(response, 400, { status: 'error', message: 'Lisans ID gerekli.' }); return; }
    if (action === 'extend') {
      const days = Number(body.days); if (!Number.isInteger(days) || days < 1 || days > 3650) { send(response, 400, { status: 'error', message: 'Uzatma 1-3650 gün aralığında olmalı.' }); return; }
      const license = await LicenseService.extend(id, days); if (!license) { send(response, 404, { status: 'error', message: 'Lisans bulunamadı.' }); return; }
      send(response, 200, { status: 'ok', license }); return;
    }
    if (action === 'deactivate') { const result = await LicenseService.deactivate(id); if (!result.count) { send(response, 404, { status: 'error', message: 'Lisans bulunamadı.' }); return; } send(response, 200, { status: 'ok' }); return; }
    send(response, 400, { status: 'error', message: 'Geçersiz admin işlemi.' });
  } catch (error) { send(response, 400, { status: 'error', message: error instanceof Error ? error.message : 'Admin işlemi başarısız.' }); }
}
