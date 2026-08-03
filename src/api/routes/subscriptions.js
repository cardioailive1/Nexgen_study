'use strict';

const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { requireAuth } = require('../middleware/requireAuth');
const { auditLog }    = require('../services/auditService');
const router = express.Router();

// ── POST /api/subscriptions/checkout ─────────────────────────────
router.post('/checkout', requireAuth, async (req, res, next) => {
  try {
    const { plan } = req.body;
    const priceMap = {
      scholar:    process.env.STRIPE_PRICE_SCHOLAR,
      researcher: process.env.STRIPE_PRICE_RESEARCHER,
    };
    const priceId = priceMap[plan?.toLowerCase()];

    // Fallback to direct Stripe links if price IDs not configured
    if (!priceId || !process.env.STRIPE_SECRET_KEY) {
      const links = {
        scholar:    'https://buy.stripe.com/14A9AT9p83rfbDddjI1oI0k',
        researcher: 'https://buy.stripe.com/dRm7sL7h09PDePpa7w1oI0l',
      };
      return res.json({ url: links[plan?.toLowerCase()] || null });
    }

    const session = await stripe.checkout.sessions.create({
      mode:               'subscription',
      payment_method_types: ['card'],
      line_items:         [{ price: priceId, quantity: 1 }],
      customer_email:     req.user.email,
      client_reference_id: req.user.id,
      success_url:        `${process.env.APP_URL || 'https://nexgen-study.onrender.com'}/?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:         `${process.env.APP_URL  || 'https://nexgen-study.onrender.com'}/?subscription=cancelled`,
      metadata:           { userId: req.user.id, plan },
    });

    res.json({ url: session.url });
  } catch (err) { next(err); }
});

// ── POST /api/subscriptions/cancel ───────────────────────────────
router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({
      where: { id: req.user.id },
      include: { subscriptions: { where: { status: 'ACTIVE' }, take: 1 } }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });

    const sub = user.subscriptions?.[0];

    if (sub?.stripeSubscriptionId && process.env.STRIPE_SECRET_KEY) {
      // Cancel at period end via Stripe
      await stripe.subscriptions.update(sub.stripeSubscriptionId, {
        cancel_at_period_end: true
      });

      await req.prisma.subscription.update({
        where: { id: sub.id },
        data:  { cancelAtPeriodEnd: true, updatedAt: new Date() }
      });
    }

    // Update user plan to reflect cancellation pending
    await req.prisma.user.update({
      where: { id: req.user.id },
      data:  { subscriptionStatus: 'CANCELED', updatedAt: new Date() }
    });

    await auditLog(req.prisma, {
      userId:    req.user.id,
      action:    'SUBSCRIPTION_CANCELLED',
      severity:  'INFO',
      ipAddress: req.ip,
    });

    res.json({
      message: 'Subscription cancelled. You will retain access until the end of your current billing period.'
    });
  } catch (err) { next(err); }
});

// ── GET /api/subscriptions/portal ────────────────────────────────
router.get('/portal', requireAuth, async (req, res, next) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.json({ url: 'https://billing.stripe.com/p/login' });
    }
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.stripeCustomerId) {
      return res.status(400).json({ error: 'No billing account found.' });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: process.env.APP_URL || 'https://nexgen-study.onrender.com',
    });
    res.json({ url: session.url });
  } catch (err) { next(err); }
});

module.exports = router;
