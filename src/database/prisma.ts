import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

let prismaClient: PrismaClient | undefined;

/** Prisma Client'ı ilk ihtiyaçta hazırlar; çağrılmadıkça DB bağlantısı açılmaz. */
export function getPrismaClient(): PrismaClient {
  if (prismaClient) return prismaClient;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL boş. .env dosyasına PostgreSQL bağlantı bilgilerini ekleyin.');
  }

  const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 3000 });
  prismaClient = new PrismaClient({ adapter });
  return prismaClient;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prismaClient) return;

  const client = prismaClient;
  prismaClient = undefined;
  await client.$disconnect();
}