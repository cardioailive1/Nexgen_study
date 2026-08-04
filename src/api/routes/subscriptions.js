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


// ── POST /api/subscriptions/apple-verify ─────────────────────────
// Called by iOS app after successful Apple In-App Purchase
// Verifies the receipt and updates user subscription status in DB
router.post('/apple-verify', requireAuth, async (req, res, next) => {
  try {
    const { receiptData, productId } = req.body;

    if (!receiptData) {
      return res.status(400).json({ error: 'Receipt data is required.' });
    }

    // Map product IDs to plans
    const productPlanMap = {
      'com.corverxis.nexgenstudy.scholar':    'SCHOLAR',
      'com.corverxis.nexgenstudy.researcher': 'RESEARCHER',
      'nexgenstudy.scholar.monthly':          'SCHOLAR',
      'nexgenstudy.researcher.monthly':       'RESEARCHER',
    };

    // Verify receipt with Apple
    const verifyWithApple = async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receiptData,
          password: process.env.APPLE_SHARED_SECRET || '',
          'exclude-old-transactions': true,
        }),
      });
      return response.json();
    };

    // Try production first, fall back to sandbox
    let appleResponse = await verifyWithApple('https://buy.itunes.apple.com/verifyReceipt');

    // Status 21007 means it's a sandbox receipt
    if (appleResponse.status === 21007) {
      appleResponse = await verifyWithApple('https://sandbox.itunes.apple.com/verifyReceipt');
    }

    // Apple verification failed
    if (appleResponse.status !== 0) {
      console.error('[Apple IAP] Verification failed, status:', appleResponse.status);
      return res.status(400).json({
        error: 'Receipt verification failed.',
        appleStatus: appleResponse.status,
      });
    }

    // Get the latest receipt info
    const latestReceipts = appleResponse.latest_receipt_info || [];
    const latestReceipt  = latestReceipts[latestReceipts.length - 1];

    if (!latestReceipt) {
      return res.status(400).json({ error: 'No valid purchase found in receipt.' });
    }

    // Determine plan from product ID
    const purchasedProductId = productId || latestReceipt.product_id;
    const plan = productPlanMap[purchasedProductId];

    if (!plan) {
      return res.status(400).json({
        error: 'Unknown product ID: ' + purchasedProductId,
      });
    }

    // Check subscription is still active
    const expiresDateMs = parseInt(latestReceipt.expires_date_ms || '0');
    const isActive      = expiresDateMs > Date.now();

    if (!isActive) {
      return res.status(400).json({ error: 'Subscription has expired.' });
    }

    const expiresAt = new Date(expiresDateMs);
    const now       = new Date();

    // Update user subscription in database
    await req.prisma.$queryRawUnsafe(`
      UPDATE "User"
      SET plan               = $1,
          "subscriptionStatus" = 'ACTIVE',
          "trialEndsAt"      = NULL,
          "updatedAt"        = $2
      WHERE id = $3
    `, plan, now, req.user.id);

    // Log the subscription event
    const { auditLog } = require('../services/auditService');
    await auditLog(req.prisma, {
      userId:    req.user.id,
      action:    'APPLE_IAP_VERIFIED',
      severity:  'INFO',
      metadata:  { plan, productId: purchasedProductId, expiresAt },
      ipAddress: req.ip,
    });

    console.log(`[Apple IAP] User ${req.user.id} upgraded to ${plan}, expires ${expiresAt}`);

    // Return updated user
    const userRows = await req.prisma.$queryRawUnsafe(
      `SELECT id, email, "fullName", plan, "subscriptionStatus", "mfaEnabled", "totalGenerations", "trialEndsAt"
       FROM "User" WHERE id = $1`,
      req.user.id
    );

    res.json({
      success: true,
      plan,
      subscriptionStatus: 'ACTIVE',
      expiresAt,
      user: userRows[0] || null,
    });

  } catch (err) {
    console.error('[Apple IAP] Error:', err.message);
    next(err);
  }
});

module.exports = router;
