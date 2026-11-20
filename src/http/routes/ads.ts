import { createHash, randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPrismaClient } from '../../database/prisma';

type Body = Record<string, unknown>;
const DAY_MS = 86_400_000;
const placements = ['HOME_TOP', 'HOME_MIDDLE', 'GAME_PAGE', 'SPONSOR_GRID'] as const;
const billingModels = ['MONTHLY', 'CPM'] as const;

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}
function clean(value: unknown, max = 200): string { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function isRecord(value: unknown): value is Body { return typeof value === 'object' && value !== null && !Array.isArray(value); }
async function readBody(req: IncomingMessage): Promise<Body> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += b.length; if (size > 32_768) throw new Error('İstek gövdesi çok büyük.'); chunks.push(b); }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') throw new Error('Content-Type application/json olmalı.');
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('JSON gövdesi nesne olmalı.');
  return value;
}
function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function passwordHash(password: string, salt = randomBytes(16).toString('hex')): string { return salt + ':' + scryptSync(password, salt, 64).toString('hex'); }
function verifyPassword(password: string, stored: string): boolean {
  const [salt, digest] = stored.split(':'); if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex'); const actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  return typeof value === 'string' ? value.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '' : '';
}
function admin(req: IncomingMessage): boolean {
  const secret = process.env.ADMIN_SECRET?.trim() ?? '';
  const provided = clean(req.headers['x-admin-secret'], 512) || bearer(req);
  if (!secret || !provided) return false;
  const a = Buffer.from(secret), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function advertiser(req: IncomingMessage) {
  const token = bearer(req);
  if (!token) return null;
  const prisma = getPrismaClient();
  const session = await prisma.advertiserSession.findUnique({ where: { tokenHash: hash(token) }, include: { advertiser: true } });
  if (!session || session.expiresAt <= new Date() || session.advertiser.status !== 'ACTIVE') return null;
  return session.advertiser;
}
function validUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}
function visitorHash(req: IncomingMessage): string {
  const ip = (req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown');
  const agent = clean(req.headers['user-agent'], 300);
  const salt = process.env.AD_TRACKING_SALT?.trim() || process.env.ADMIN_SECRET?.trim() || 'tiktok-live-game-ad-tracking';
  return hash(salt + ':' + ip + ':' + agent);
}
function pricing(model: 'MONTHLY' | 'CPM', budget: number): number {
  const monthly = Number(process.env.AD_MONTHLY_PRICE_TRY || 2500);
  const cpm = Number(process.env.AD_CPM_PRICE_TRY || 100);
  return model === 'MONTHLY' ? monthly : Math.ceil(budget / 1000) * cpm;
}

export async function advertiserRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);
    const email = clean(body.email, 254).toLowerCase();
    const companyName = clean(body.companyName, 120);
    const contactName = clean(body.contactName, 120);
    const password = clean(body.password, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !companyName || !contactName || password.length < 10) {
      send(res, 400, { status: 'error', message: 'Geçerli e-posta, şirket/kişi adı ve en az 10 karakterli şifre gerekli.' }); return;
    }
    const created = await getPrismaClient().advertiser.create({ data: { email, companyName, contactName, passwordHash: passwordHash(password), status: 'PENDING' }, select: { id: true, email: true, companyName: true, contactName: true, status: true, createdAt: true } });
    send(res, 201, { status: 'ok', message: 'Başvurunuz alındı. Yönetici onayından sonra giriş yapabilirsiniz.', advertiser: created });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') { send(res, 409, { status: 'error', message: 'Bu e-posta adresi zaten kayıtlı.' }); return; }
    send(res, 400, { status: 'error', message: error instanceof Error ? error.message : 'Kayıt tamamlanamadı.' });
  }
}

export async function advertiserLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req), email = clean(body.email, 254).toLowerCase(), password = clean(body.password, 200);
    const account = await getPrismaClient().advertiser.findUnique({ where: { email } });
    if (!account || !verifyPassword(password, account.passwordHash)) { send(res, 401, { status: 'error', message: 'E-posta veya şifre hatalı.' }); return; }
    if (account.status !== 'ACTIVE') { send(res, 403, { status: 'error', message: account.status === 'PENDING' ? 'Hesabınız yönetici onayı bekliyor.' : 'Reklam veren hesabınız aktif değil.' }); return; }
    const token = randomBytes(32).toString('base64url');
    await getPrismaClient().advertiserSession.create({ data: { advertiserId: account.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + 30 * DAY_MS) } });
    send(res, 200, { status: 'ok', token, expiresIn: 30 * 24 * 60 * 60, advertiser: { id: account.id, email: account.email, companyName: account.companyName, contactName: account.contactName } });
  } catch (error) { send(res, 400, { status: 'error', message: error instanceof Error ? error.message : 'Giriş yapılamadı.' }); }
}

export async function advertiserMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const account = await advertiser(req);
    if (!account) { send(res, 401, { status: 'error', message: 'Reklam veren oturumu geçersiz veya süresi dolmuş.' }); return; }
    send(res, 200, { status: 'ok', advertiser: { id: account.id, email: account.email, companyName: account.companyName, contactName: account.contactName, status: account.status, firstCampaignApprovedAt: account.firstCampaignApprovedAt } });
  } catch { send(res, 500, { status: 'error', message: 'Hesap bilgisi alınamadı.' }); }
}

export async function advertiserCampaigns(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const account = await advertiser(req);
    if (!account) { send(res, 401, { status: 'error', message: 'Reklam veren oturumu gerekli.' }); return; }
    const prisma = getPrismaClient();
    if (req.method === 'GET') {
      const campaigns = await prisma.adCampaign.findMany({ where: { advertiserId: account.id }, include: { payments: { select: { id: true, orderId: true, amount: true, status: true, createdAt: true, paidAt: true } }, _count: { select: { impressions: true, clicks: true } } }, orderBy: { createdAt: 'desc' } });
      send(res, 200, { status: 'ok', campaigns }); return;
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); send(res, 405, { status: 'error', message: 'Yöntem desteklenmiyor.' }); return; }
    const body = await readBody(req);
    const name = clean(body.name, 100), headline = clean(body.headline, 100), description = clean(body.description, 300);
    const imageUrl = clean(body.imageUrl, 1000), targetUrl = clean(body.targetUrl, 1000);
    const placement = clean(body.placement, 30), model = clean(body.billingModel, 20);
    const budget = Number(body.budget);
    if (!name || !headline || !validUrl(imageUrl) || !validUrl(targetUrl) || !placements.includes(placement as typeof placements[number]) || !billingModels.includes(model as typeof billingModels[number])) {
      send(res, 400, { status: 'error', message: 'Kampanya adı, başlık, geçerli görsel/hedef URL, reklam alanı ve ücret modeli gerekli.' }); return;
    }
    if (model === 'CPM' && (!Number.isInteger(budget) || budget < 1000 || budget > 100_000_000)) { send(res, 400, { status: 'error', message: 'CPM bütçesi 1.000-100.000.000 gösterim aralığında olmalı.' }); return; }
    const amount = pricing(model as 'MONTHLY' | 'CPM', model === 'CPM' ? budget : 0);
    if (!Number.isSafeInteger(amount) || amount < 1) { send(res, 503, { status: 'error', message: 'Reklam fiyatlandırması yapılandırılamadı.' }); return; }
    const campaignCount = await prisma.adCampaign.count({ where: { advertiserId: account.id } });
    const firstNeedsReview = !account.firstCampaignApprovedAt && campaignCount === 0;
    const created = await prisma.$transaction(async tx => {
      const campaign = await tx.adCampaign.create({ data: { advertiserId: account.id, name, headline, description, imageUrl, targetUrl, placement: placement as typeof placements[number], billingModel: model as typeof billingModels[number], status: firstNeedsReview ? 'PENDING_REVIEW' : 'PAUSED', monthlyPrice: model === 'MONTHLY' ? amount : null, cpmRate: model === 'CPM' ? Number(process.env.AD_CPM_PRICE_TRY || 100) : null, budget: model === 'CPM' ? budget : null } });
      const payment = await tx.adPayment.create({ data: { advertiserId: account.id, campaignId: campaign.id, orderId: 'AD-' + randomUUID(), amount } });
      return { campaign, payment };
    });
    send(res, 201, { status: 'ok', message: firstNeedsReview ? 'İlk kampanyanız yönetici incelemesine gönderildi. Ödeme adımı ayrıca tamamlanmalıdır.' : 'Kampanya oluşturuldu. Ödeme tamamlandıktan sonra otomatik yayın akışına alınacaktır.', ...created, paymentRequired: true });
  } catch (error) { send(res, 400, { status: 'error', message: error instanceof Error ? error.message : 'Kampanya oluşturulamadı.' }); }
  }

export async function serveAd(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const placement = clean(url.searchParams.get('placement'), 30);
    if (!placements.includes(placement as typeof placements[number])) { send(res, 400, { status: 'error', message: 'Geçersiz reklam alanı.' }); return; }
    const now = new Date();
    const candidates = await getPrismaClient().adCampaign.findMany({ where: { placement: placement as typeof placements[number], status: 'ACTIVE', OR: [{ startsAt: null }, { startsAt: { lte: now } }], AND: [{ OR: [{ endsAt: null }, { endsAt: { gt: now } }] }] }, orderBy: { createdAt: 'asc' }, take: 25, select: { id: true, headline: true, description: true, imageUrl: true, targetUrl: true, placement: true, budget: true, spent: true } });
    const campaign = candidates.find(item => item.budget === null || item.spent < item.budget) ?? null;
    send(res, 200, { status: 'ok', ad: campaign ? { id: campaign.id, headline: campaign.headline, description: campaign.description, imageUrl: campaign.imageUrl, targetUrl: campaign.targetUrl, placement: campaign.placement } : null });
  } catch { send(res, 500, { status: 'error', message: 'Reklam yüklenemedi.' }); }
}

export async function trackAd(req: IncomingMessage, res: ServerResponse, action: 'impression' | 'click'): Promise<void> {
  try {
    const body = await readBody(req), campaignId = clean(body.campaignId, 64), placement = clean(body.placement, 30);
    if (!campaignId || !placements.includes(placement as typeof placements[number])) { send(res, 400, { status: 'error', message: 'Kampanya ve reklam alanı gerekli.' }); return; }
    const prisma = getPrismaClient();
    const campaign = await prisma.adCampaign.findUnique({ where: { id: campaignId }, select: { id: true, status: true, placement: true, targetUrl: true, budget: true, spent: true } });
    if (!campaign || campaign.status !== 'ACTIVE' || campaign.placement !== placement) { send(res, 404, { status: 'error', message: 'Aktif reklam bulunamadı.' }); return; }
    const vHash = visitorHash(req);
    if (action === 'impression') {
      const day = new Date().toISOString().slice(0, 10);
      const result = await prisma.adImpression.createMany({ data: [{ campaignId, visitorHash: vHash, day, placement: placement as typeof placements[number] }], skipDuplicates: true });
      if (result.count) {
        if (campaign.budget !== null) await prisma.adCampaign.update({ where: { id: campaignId }, data: { spent: { increment: 1 } } });
      }
      send(res, 200, { status: 'ok', counted: result.count === 1 }); return;
    }
    await prisma.adClick.create({ data: { campaignId, visitorHash: vHash, placement: placement as typeof placements[number] } });
    send(res, 200, { status: 'ok', targetUrl: campaign.targetUrl });
  } catch (error) { send(res, 400, { status: 'error', message: error instanceof Error ? error.message : 'Reklam metriği kaydedilemedi.' }); }
}

export async function adminAds(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!admin(req)) { send(res, 401, { status: 'error', message: 'Yönetici doğrulaması başarısız.' }); return; }
  try {
    const prisma = getPrismaClient(), url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/advertisers')) {
      const advertisers = await prisma.advertiser.findMany({ select: { id: true, email: true, companyName: true, contactName: true, status: true, firstCampaignApprovedAt: true, createdAt: true, _count: { select: { campaigns: true } } }, orderBy: { createdAt: 'desc' }, take: 300 });
      send(res, 200, { status: 'ok', advertisers }); return;
    }
    if (req.method === 'GET') {
      const campaigns = await prisma.adCampaign.findMany({ include: { advertiser: { select: { id: true, email: true, companyName: true } }, payments: true, _count: { select: { impressions: true, clicks: true } } }, orderBy: { createdAt: 'desc' }, take: 300 });
      send(res, 200, { status: 'ok', campaigns }); return;
    }
    if (req.method !== 'PATCH') { res.setHeader('Allow', 'GET, PATCH'); send(res, 405, { status: 'error', message: 'Yöntem desteklenmiyor.' }); return; }
    const body = await readBody(req), id = clean(body.id, 64), action = clean(body.action, 20);
    if (!id) { send(res, 400, { status: 'error', message: 'Kayıt ID gerekli.' }); return; }
    if (url.pathname.endsWith('/advertisers')) {
      if (!['approve', 'reject'].includes(action)) { send(res, 400, { status: 'error', message: 'İşlem approve veya reject olmalı.' }); return; }
      const updated = await prisma.advertiser.update({ where: { id }, data: { status: action === 'approve' ? 'ACTIVE' : 'REJECTED' }, select: { id: true, email: true, status: true } });
      send(res, 200, { status: 'ok', advertiser: updated }); return;
    }
    if (!['approve', 'reject', 'pause', 'activate'].includes(action)) { send(res, 400, { status: 'error', message: 'Geçersiz kampanya işlemi.' }); return; }
    const current = await prisma.adCampaign.findUnique({ where: { id }, include: { payments: true } });
    if (!current) { send(res, 404, { status: 'error', message: 'Kampanya bulunamadı.' }); return; }
    if (action === 'approve') {
      const paid = current.payments.some(p => p.status === 'PAID');
      const updated = await prisma.$transaction(async tx => {
        const campaign = await tx.adCampaign.update({ where: { id }, data: { status: paid ? 'ACTIVE' : 'PAUSED', approvedAt: new Date() } });
        await tx.advertiser.update({ where: { id: current.advertiserId }, data: { firstCampaignApprovedAt: new Date() } });
        return campaign;
      });
      send(res, 200, { status: 'ok', campaign: updated, paymentRequired: !paid }); return;
    }
    const updated = await prisma.adCampaign.update({ where: { id }, data: { status: action === 'reject' ? 'REJECTED' : action === 'pause' ? 'PAUSED' : (current.payments.some(p => p.status === 'PAID') ? 'ACTIVE' : 'PAUSED') } });
    send(res, 200, { status: 'ok', campaign: updated }); return;
  } catch (error) { send(res, 400, { status: 'error', message: error instanceof Error ? error.message : 'Yönetici reklam işlemi başarısız.' }); }
}
