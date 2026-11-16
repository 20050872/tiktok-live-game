import { randomUUID } from 'node:crypto';
import { getPrismaClient } from '../database/prisma';
import type { LicensePlanType } from '../generated/prisma/client';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type PlanType = 'SEVEN_DAYS' | 'ONE_MONTH' | 'LIFETIME';
export interface ValidLicense { id: string; licenseKey: string; overlayToken: string; customerName: string; buyerEmail: string; customerEmail: string; orderId: string; planType: string; expiresAt: Date; isActive: boolean; createdAt: Date; legacy?: boolean }

export class LicenseService {
  static planExpiry(plan: PlanType, now = new Date()): Date {
    if (plan === 'LIFETIME') return new Date('9999-12-31T23:59:59.999Z');
    const days = plan === 'SEVEN_DAYS' ? 7 : 30;
    return new Date(now.getTime() + days * 86_400_000);
  }

  static async validateToken(token: string): Promise<ValidLicense | null> {
    if (!UUID_PATTERN.test(token)) return null;
    const prisma = getPrismaClient();
    const license = await prisma.license.findFirst({ where: { OR: [{ licenseKey: token }, { overlayToken: token }] } });
    if (license) {
      if (!license.isActive || license.expiresAt.getTime() <= Date.now()) return null;
      return { ...license, customerEmail: license.buyerEmail };
    }
    // Eski kayıtlar, yeni License kayıtlarına taşınana kadar abonelik bitiş tarihleriyle doğrulanır.
    const legacy = await prisma.user.findUnique({ where: { overlayToken: token }, include: { subscription: true } });
    if (!legacy?.subscription || !['trial', 'active'].includes(legacy.subscription.status) || legacy.subscription.expiresAt.getTime() <= Date.now()) return null;
    return { id: legacy.id, licenseKey: token, overlayToken: token, customerName: legacy.tiktokUsername, buyerEmail: '', customerEmail: '', orderId: `LEGACY-${legacy.id}`, planType: 'SEVEN_DAYS', expiresAt: legacy.subscription.expiresAt, isActive: true, createdAt: legacy.createdAt, legacy: true };
  }

  static async create(input: { customerName: string; buyerEmail?: string; customerEmail?: string; orderId: string; planType: PlanType; expiresAt?: Date; licenseKey?: string; overlayToken?: string }) {
    const prisma = getPrismaClient();
    const key = input.licenseKey ?? input.overlayToken ?? randomUUID();
    return prisma.license.create({ data: { licenseKey: key, overlayToken: input.overlayToken ?? key, customerName: input.customerName, buyerEmail: input.buyerEmail ?? input.customerEmail ?? '', orderId: input.orderId, planType: input.planType as LicensePlanType, expiresAt: input.expiresAt ?? this.planExpiry(input.planType), isActive: true } });
  }

  static async extend(id: string, days: number) {
    const prisma = getPrismaClient();
    const license = await prisma.license.findUnique({ where: { id } });
    if (!license) return null;
    const from = license.expiresAt.getTime() > Date.now() ? license.expiresAt : new Date();
    return prisma.license.update({ where: { id }, data: { expiresAt: new Date(from.getTime() + days * 86_400_000), isActive: true } });
  }

  static async deactivate(id: string) {
    const prisma = getPrismaClient();
    return prisma.license.updateMany({ where: { id }, data: { isActive: false } });
  }
}
