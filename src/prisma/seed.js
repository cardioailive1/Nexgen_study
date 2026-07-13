'use strict';

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('Seeding NexGen Study database...');

  // Create admin user
  const passwordHash = await bcrypt.hash('Admin@NexGen2025!', 12);
  await prisma.user.upsert({
    where: { email: 'admin@corverxis.com' },
    update: {},
    create: {
      email: 'admin@corverxis.com',
      fullName: 'Corverxis Admin',
      passwordHash,
      emailVerified: true,
      emailVerifiedAt: new Date(),
      plan: 'RESEARCHER',
      subscriptionStatus: 'ACTIVE',
      termsAcceptedAt: new Date(),
      privacyAcceptedAt: new Date(),
    }
  });

  console.log('Seed complete.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
