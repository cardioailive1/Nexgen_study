'use strict';

const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');

const router = express.Router();

const PRICE_MAP = {
  scholar:    process.env.STRIPE_PRICE_SCHOLAR,
  researcher: process.env.STRIPE_PRICE_RESEARCHER,
};

// ── POST /api/subscriptions/checkout ──────────────────────────────
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (!PRICE_MAP[plan]) return res.status(400).json({ error: 'Invalid plan.' });

    const user   = req.user;
    const prisma = req.prisma;

    // Get or create Stripe customer
    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email, name: user.fullName,
        metadata: { userId: user.id, platform: 'nexgen-study' },
      });
      customerId = customer.id;
      await prisma.user.update({ where: { id: user.id }, data: { stripeCustomerId: customerId } });
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: PRICE_MAP[plan], quantity: 1 }],
      success_url: `${process.env.APP_URL}/?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.APP_URL}/?subscription=cancelled`,
      metadata: { userId: user.id, plan },
      subscription_data: {
        trial_period_days: user.plan === 'TRIAL' ? 0 : undefined,
        metadata: { userId: user.id, plan },
      },
      allow_promotion_codes: true,
    });

    await auditLog(prisma, { userId: user.id, action: 'CHECKOUT_INITIATED', metadata: { plan }, ipAddress: req.ip });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/portal ────────────────────────────────
router.post('/portal', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    if (!user.stripeCustomerId) return res.status(400).json({ error: 'No active subscription found.' });

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${process.env.APP_URL}/account`,
    });

    await auditLog(req.prisma, { userId: user.id, action: 'BILLING_PORTAL_ACCESSED', ipAddress: req.ip });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── GET /api/subscriptions/status ─────────────────────────────────
router.get('/status', requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const sub  = await req.prisma.subscription.findFirst({
      where:   { userId: user.id, status: { in: ['ACTIVE', 'TRIALING'] } },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      plan: user.plan,
      trialEndsAt: user.trialEndsAt,
      subscription: sub ? {
        status:           sub.status,
        currentPeriodEnd: sub.currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      } : null,
    });
  } catch (err) { next(err); }
});

module.exports = router;
