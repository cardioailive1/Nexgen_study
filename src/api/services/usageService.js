'use strict';

const PLAN_LIMITS = {
  TRIAL:      3,
  SCHOLAR:    999999,
  RESEARCHER: 999999,
};

async function checkDailyLimit(prisma, user) {
  const limit = PLAN_LIMITS[user.plan] || 3;
  if (limit >= 999999) return true;

  const today = new Date(); today.setHours(0,0,0,0);
  const count = await prisma.generation.count({
    where: { userId: user.id, createdAt: { gte: today }, status: 'COMPLETED' }
  });
  return count < limit;
}

async function incrementDailyUsage(prisma, user) {
  await prisma.user.update({
    where: { id: user.id },
    data: { dailyUsageCount: { increment: 1 }, totalGenerations: { increment: 1 } }
  });
}

async function resetDailyUsage(prisma, userId) {
  await prisma.user.update({ where: { id: userId }, data: { dailyUsageCount: 0, dailyUsageReset: new Date() } });
}

module.exports = { checkDailyLimit, incrementDailyUsage, resetDailyUsage };
