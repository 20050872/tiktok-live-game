import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPrismaClient } from '../../database/prisma';
import { SHOPIER_PRODUCTS } from '../../config/shopierProducts';
import { LicenseService, type PlanType } from '../../services/LicenseService';

type RecordValue = Record<string, unknown>;
const plans: Array<{ type: PlanType; label: string; days: number | null; amount: number; url: string }> = [
  { type: 'SEVEN_DAYS', label: 'Haftalık', days: 7, amount: Number(process.env.SHOPIER_WEEKLY_AMOUNT || 500), url: SHOPIER_PRODUCTS.weekly.url },
  { type: 'ONE_MONTH', label: 'Aylık', days: 30, amount: Number(process.env.SHOPIER_MONTHLY_AMOUNT || 1000), url: SHOPIER_PRODUCTS.monthly.url },
  { type: 'LIFETIME', label: 'Sınırsız', days: null, amount: Number(process.env.SHOPIER_LIFETIME_AMOUNT || 2500), url: SHOPIER_PRODUCTS.lifetime.url },
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
function inspectProductList(value: unknown): { ids: string[]; names: string[]; amounts: number[] } {
  const ids = new Set<string>(); const names = new Set<string>(); const amounts = new Set<number>();
  const visit = (item: unknown, field = ''): void => {
    if (typeof item === 'string') {
      const trimmed = item.trim();
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) { try { visit(JSON.parse(trimmed) as unknown, field); return; } catch { /* plain product or variation label */ } }
      if (/^(?:product_?id|productid|item_?id|itemid|id)$/i.test(field) && trimmed) ids.add(trimmed);
      if (/(?:name|title|variation|variant|option|product|item)/i.test(field) && trimmed) names.add(trimmed);
      if (/(?:amount|price|total|value)/i.test(field)) { const amount = Number(trimmed.replace(',', '.')); if (Number.isFinite(amount)) amounts.add(amount); }
      if (!field && trimmed) names.add(trimmed);
      return;
    }
    if (typeof item === 'number') {
      if (/^(?:product_?id|productid|item_?id|itemid|id)$/i.test(field)) ids.add(String(item));
      if (/(?:amount|price|total|value)/i.test(field) && Number.isFinite(item)) amounts.add(item);
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry) => visit(entry)); return; }
    if (isRecord(item)) for (const [key, child] of Object.entries(item)) visit(child, key);
  };
  visit(value);
  return { ids: [...ids], names: [...names], amounts: [...amounts] };
}
function resolveOsbPlan(payload: RecordValue): { plan: PlanType | null; reason: string; productIds: string[]; amounts: number[] } {
  const product = inspectProductList(payload.productlist);
  const configuredIds: Array<{ env: string; type: PlanType }> = [
    { env: SHOPIER_PRODUCTS.testProductId ?? '', type: 'TEST' },
    { env: SHOPIER_PRODUCTS.weekly.productId, type: 'SEVEN_DAYS' },
    { env: SHOPIER_PRODUCTS.monthly.productId, type: 'ONE_MONTH' },
    { env: SHOPIER_PRODUCTS.lifetime.productId, type: 'LIFETIME' },
  ];
  for (const id of product.ids) {
    const match = configuredIds.find((configured) => configured.env && configured.env === id);
    if (match) return { plan: match.type, reason: `ürün ID eşleşmesi (${match.type})`, productIds: product.ids, amounts: product.amounts };
  }

  const payloadAmount = Number(String(payload.price ?? payload.total_order_value ?? payload.amount ?? '').replace(',', '.'));
  const amounts = [...new Set([...product.amounts, ...(Number.isFinite(payloadAmount) && payloadAmount > 0 ? [payloadAmount] : [])])];
  for (const amount of amounts) {
    for (const candidate of plans) {
      // %5 tolerans (en az 25 TL), küçük indirim/kargo/komisyon farklarını karşılar ve paket aralıklarını çakıştırmaz.
      const tolerance = Math.max(25, candidate.amount * 0.05);
      if (Math.abs(candidate.amount - amount) <= tolerance) return { plan: candidate.type, reason: `tutar eşleşmesi (${amount} TL)`, productIds: product.ids, amounts };
    }
  }

  const labels = [...product.names, clean(payload.product_name ?? payload.productName ?? payload.variation ?? payload.product_variation, 200)].filter(Boolean);
  for (const label of labels) {
    const match = parsePlan(label);
    if (match) return { plan: match, reason: `ürün adı/varyasyon eşleşmesi (${label})`, productIds: product.ids, amounts };
  }
  return { plan: null, reason: product.ids.length ? 'ürün ID eşleşmedi; tutar ve isim fallback eşleşmesi de bulunamadı' : 'productlist içinde ürün ID bulunamadı; tutar ve isim fallback eşleşmesi de bulunamadı', productIds: product.ids, amounts };
}

/** Shopier OSB sends form fields res/hash; this is intentionally separate from the legacy payment callback. */
export async function shopierOsbCallback(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let parsedBody: Awaited<ReturnType<typeof readShopierOsbBody>>;
  try { parsedBody = await readShopierOsbBody(request); }
  catch (err) { console.warn('[Shopier OSB] Body okunamadı:', err instanceof Error ? err.message : err); sendOsb(response, 400, 'missing parameter'); return; }
  const body = parsedBody.body;
  console.info('[Shopier OSB] Gelen istek', JSON.stringify({ method: request.method, contentType: parsedBody.contentType, rawLength: parsedBody.raw.length }));
  const encodedRes = readOsbField(body, 'res');
  const receivedHash = clean(readOsbField(body, 'hash'), 256).toLowerCase();
  if (typeof encodedRes !== 'string' || !encodedRes) { sendOsb(response, 400, 'missing parameter'); return; }

  // Decode before signature verification so the exact signed `res` value can be checked.
  let payload: unknown;
  try {
    const decoded = Buffer.from(encodedRes, 'base64');
    if (!decoded.length || decoded.toString('base64').replace(/=+$/, '') !== encodedRes.replace(/\s/g, '').replace(/=+$/, '')) throw new Error('bad base64');
    payload = JSON.parse(decoded.toString('utf8')) as unknown;
  } catch { sendOsb(response, 400, 'invalid res'); return; }

  const username = process.env.SHOPIER_OSB_USERNAME?.trim() ?? '';
  const key = process.env.SHOPIER_OSB_PASSWORD?.trim() ?? '';
  if (!receivedHash || !username || !key) { sendOsb(response, 400, 'missing parameter'); return; }

  const expectedHash = createHmac('sha256', key).update(`${encodedRes}${username}`).digest('hex');
  const expectedBytes = Buffer.from(expectedHash, 'hex'); const receivedBytes = Buffer.from(receivedHash, 'hex');
  if (receivedBytes.length !== expectedBytes.length || !timingSafeEqual(receivedBytes, expectedBytes)) { sendOsb(response, 401, 'unauthorized'); return; }

  if (!isRecord(payload)) { sendOsb(response, 400, 'invalid res'); return; }
  if (payload.istest === 1 || payload.istest === '1') { sendOsb(response, 200, 'success'); return; }

  const orderId = clean(payload.orderid ?? payload.order_id ?? payload.platform_order_id, 160);
  let productListLog: string;
  try { productListLog = JSON.stringify(payload.productlist ?? null) ?? 'null'; } catch { productListLog = '[unserializable]'; }
  console.info('[Shopier OSB] Sipariş bildirimi', JSON.stringify({ orderid: orderId, email: clean(payload.email ?? payload.buyeremail, 254), productlist: productListLog.slice(0, 1200), istest: payload.istest ?? null }));
  const buyerEmail = clean(payload.email ?? payload.buyeremail, 254).toLowerCase();
  const customerName = [clean(payload.buyername ?? payload.customer_name, 100), clean(payload.buyersurname ?? payload.buyer_surname, 100)].filter(Boolean).join(' ').trim() || buyerEmail;
  if (!orderId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyerEmail)) {
    console.warn('[Shopier OSB] Sipariş lisansı oluşturulamadı: sipariş numarası veya alıcı e-postası eksik/geçersiz.', JSON.stringify({ orderid: orderId || null, emailPresent: Boolean(buyerEmail) }));
    sendOsb(response, 400, 'invalid order'); return;
  }
  const resolved = resolveOsbPlan(payload);
  if (!resolved.plan) {
    console.error('[Shopier OSB] EŞLEŞME UYARISI: Gerçek sipariş lisanssız kalabilir; ürün ID/fiyat/isim yapılandırmasını kontrol edin.', JSON.stringify({ orderid: orderId, reason: resolved.reason, productIds: resolved.productIds, amounts: resolved.amounts }));
    sendOsb(response, 400, 'invalid order'); return;
  }
  const plan = resolved.plan;
  if (!resolved.reason.startsWith('ürün ID eşleşmesi')) {
    console.warn('[Shopier OSB] Plan ID ile eşleşmedi, yedekle bulundu', JSON.stringify({ orderid: orderId, plan, reason: resolved.reason, productIds: resolved.productIds }));
  }
  console.info('[Shopier OSB] Paket eşleşti.', JSON.stringify({ orderid: orderId, plan, reason: resolved.reason, productIds: resolved.productIds }));
  if (plan === 'TEST') console.info('[TEST PLAN] Shopier test ürünü için 1 günlük lisans işleniyor.', JSON.stringify({ orderid: orderId, productIds: resolved.productIds }));

  try {
    const prisma = getPrismaClient();
    await prisma.$transaction(async (tx) => {
      const priorOrder = await tx.shopierOrder.findUnique({ where: { orderId } });
      if (priorOrder) return;

      // Preserve idempotency for orders fulfilled before the ShopierOrder ledger existed.
      const priorLicense = await tx.license.findUnique({ where: { orderId } });
      if (priorLicense) {
        await tx.shopierOrder.create({ data: { orderId, licenseId: priorLicense.id, planType: priorLicense.planType } });
        return;
      }

      const existing = await tx.license.findFirst({ where: { buyerEmail }, orderBy: { createdAt: 'desc' } });
      let licenseId: string;
      if (existing) {
        const currentLifetime = existing.planType === 'LIFETIME' || existing.expiresAt === null;
        const purchasedLifetime = plan === 'LIFETIME';
        const days = plan === 'SEVEN_DAYS' ? 7 : plan === 'TEST' ? 1 : plan === 'ONE_MONTH' ? 30 : null;
        const start = existing.expiresAt && existing.expiresAt.getTime() > Date.now() ? existing.expiresAt : new Date();
        const expiresAt = currentLifetime || purchasedLifetime ? null : new Date(start.getTime() + (days ?? 0) * 86_400_000);
        const effectivePlan = currentLifetime || purchasedLifetime ? 'LIFETIME' : plan;
        const updated = await tx.license.update({ where: { id: existing.id }, data: { expiresAt, planType: effectivePlan, isActive: true } });
        licenseId = updated.id;
      } else {
        const keyValue = randomUUID();
        const days = plan === 'SEVEN_DAYS' ? 7 : plan === 'TEST' ? 1 : plan === 'ONE_MONTH' ? 30 : null;
        const expiresAt = days === null ? null : new Date(Date.now() + days * 86_400_000);
        const created = await tx.license.create({ data: { licenseKey: keyValue, overlayToken: keyValue, customerName, buyerEmail, orderId, planType: plan, expiresAt, isActive: true } });
        licenseId = created.id;
      }
      await tx.shopierOrder.create({ data: { orderId, licenseId, planType: plan } });
    });
    sendOsb(response, 200, 'success');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      try { if (await getPrismaClient().shopierOrder.findUnique({ where: { orderId } })) { sendOsb(response, 200, 'success'); return; } } catch { /* respond with retryable failure below */ }
    }
    console.error('[Shopier OSB] Lisans kaydı oluşturulamadı.');
    sendOsb(response, 500, 'error');
  }
}
function clean(value: unknown, max = 200): string { return typeof value === 'string' ? value.trim().slice(0, max) : typeof value === 'number' ? String(value) : ''; }
function parsePlan(value: unknown): PlanType | null {
  const normalized = clean(value, 80).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return null;
  if (normalized.includes('hafta') || normalized.includes('weekly') || normalized.includes('seven_days') || normalized.includes('7_gun') || normalized.includes('7gun') || /(^|_)7(_|$)/.test(normalized)) return 'SEVEN_DAYS';
  if (normalized.includes('aylik') || normalized.includes('1_ay') || normalized.includes('monthly') || normalized.includes('one_month') || normalized.includes('thirty_days') || normalized.includes('30_days') || normalized.includes('30_gun') || normalized.includes('1_month') || /(^|_)30(_|$)/.test(normalized)) return 'ONE_MONTH';
  if (normalized.includes('lifetime') || normalized.includes('sinirsiz') || normalized.includes('omur_boyu') || normalized.includes('unlimited') || normalized.includes('omur')) return 'LIFETIME';
  return null;
}
function publicPlanType(plan: string): '7_days' | '1_month' | 'lifetime' | 'test' {
  return plan === 'SEVEN_DAYS' ? '7_days' : plan === 'ONE_MONTH' ? '1_month' : plan === 'TEST' ? 'test' : 'lifetime';
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
    send(response, 200, { status: 'ok', license: { id: license.id, licenseKey: license.licenseKey, customerEmail: license.customerEmail, customerName: license.customerName, planType: publicPlanType(license.planType), startedAt: license.startedAt, expiresAt: license.expiresAt, isActive: license.isActive } });
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
