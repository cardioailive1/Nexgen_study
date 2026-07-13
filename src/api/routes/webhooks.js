'use strict';

const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { auditLog } = require('../services/auditService');

const router = express.Router();

const PLAN_FROM_PRICE = {
  [process.env.STRIPE_PRICE_SCHOLAR]:     'SCHOLAR',
  [process.env.STRIPE_PRICE_RESEARCHER]:  'RESEARCHER',
};

// ── POST /api/webhooks/stripe ─────────────────────────────────────
router.post('/stripe', async (req, res, next) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  const prisma = req.prisma;

  // Idempotency check
  const existing = await prisma.webhookEvent.findUnique({ where: { stripeEventId: event.id } });
  if (existing?.processed) {
    console.log(`Stripe event ${event.id} already processed.`);
    return res.json({ received: true });
  }

  await prisma.webhookEvent.upsert({
    where:  { stripeEventId: event.id },
    create: { stripeEventId: event.id, type: event.type, payload: event },
    update: {},
  });

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId  = session.metadata?.userId;
        const plan    = session.metadata?.plan?.toUpperCase();
        if (!userId || !plan) break;

        await prisma.user.update({
          where: { id: userId },
          data: { plan, subscriptionId: session.subscription, subscriptionStatus: 'ACTIVE' },
        });
        await auditLog(prisma, { userId, action: 'PLAN_UPGRADED', metadata: { plan, sessionId: session.id } });
        break;
      }

      case 'customer.subscription.updated': {
        const sub     = event.data.object;
        const user    = await prisma.user.findFirst({ where: { stripeCustomerId: sub.customer } });
        if (!user) break;
        const plan    = PLAN_FROM_PRICE[sub.items.data[0]?.price?.id] || user.plan;
        const status  = sub.status.toUpperCase();

        await prisma.user.update({
          where: { id: user.id },
          data: { plan, subscriptionStatus: status },
        });
        await prisma.subscription.upsert({
          where:  { stripeSubscriptionId: sub.id },
          create: {
            userId: user.id, stripeSubscriptionId: sub.id,
            stripePriceId: sub.items.data[0]?.price?.id,
            plan, status, currentPeriodStart: new Date(sub.current_period_start * 1000),
            currentPeriodEnd: new Date(sub.current_period_end * 1000),
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          },
          update: { status, currentPeriodEnd: new Date(sub.current_period_end * 1000), cancelAtPeriodEnd: sub.cancel_at_period_end },
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub  = event.data.object;
        const user = await prisma.user.findFirst({ where: { stripeCustomerId: sub.customer } });
        if (!user) break;
        await prisma.user.update({ where: { id: user.id }, data: { plan: 'TRIAL', subscriptionStatus: 'INACTIVE' } });
        await auditLog(prisma, { userId: user.id, action: 'SUBSCRIPTION_CANCELED', metadata: { subscriptionId: sub.id } });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const user = await prisma.user.findFirst({ where: { stripeCustomerId: invoice.customer } });
        if (!user) break;
        await prisma.user.update({ where: { id: user.id }, data: { subscriptionStatus: 'PAST_DUE' } });
        await auditLog(prisma, { userId: user.id, action: 'PAYMENT_FAILED', severity: 'WARN', metadata: { invoiceId: invoice.id } });
        break;
      }
    }

    await prisma.webhookEvent.update({ where: { stripeEventId: event.id }, data: { processed: true, processedAt: new Date() } });
    res.json({ received: true });
  } catch (err) {
    console.error(`Webhook handler error for ${event.type}:`, err);
    next(err);
  }
});

module.exports = router;
