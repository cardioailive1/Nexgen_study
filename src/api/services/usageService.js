'use strict';

async function checkDailyLimit(prisma, user) {
  // Paid plans have no daily limit
  if (user.plan === 'SCHOLAR' || user.plan === 'RESEARCHER') return true;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const count = await prisma.generation.count({
    where: { userId: user.id, createdAt: { gte: today } }
  });

  const limits = { TRIAL: 3 };
  const limit  = limits[user.plan] || 3;
  return count < limit;
}

async function incrementDailyUsage(prisma, userId) {
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        totalGenerations: { increment: 1 },
        dailyUsageCount:  { increment: 1 },
        updatedAt:        new Date(),
      }
    });
  } catch (err) {
    // Non-fatal — use raw SQL fallback
    try {
      await prisma.$queryRawUnsafe(
        `UPDATE "User" SET "totalGenerations"="totalGenerations"+1, "dailyUsageCount"="dailyUsageCount"+1, "updatedAt"=$1 WHERE id=$2`,
        new Date(), userId
      );
    } catch (e) {
      console.warn('[usageService] Failed to increment usage:', e.message);
    }
  }
}

module.exports = { checkDailyLimit, incrementDailyUsage };
