import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Kimlik bilgileri .env dosyasına girilene kadar bağlantı kurulmaz.
    url: process.env['DATABASE_URL'] ?? '',
  },
});