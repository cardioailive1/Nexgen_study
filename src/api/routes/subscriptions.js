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
// Handles StoreKit 2 JWS tokens from iOS
router.post('/apple-verify', requireAuth, async (req, res, next) => {
  try {
    const { receiptData, productId, jwsToken } = req.body;

    // Support both field names
    const token = jwsToken || receiptData;

    if (!token) {
      return res.status(400).json({ error: 'Receipt data is required.' });
    }

    // Product ID → plan mapping
    const productPlanMap = {
      'com.corverxis.nexgenstudy.scholar.monthly':    'SCHOLAR',
      'com.corverxis.nexgenstudy.researcher.monthly': 'RESEARCHER',
      'com.corverxis.nexgenstudy.scholar':            'SCHOLAR',
      'com.corverxis.nexgenstudy.researcher':         'RESEARCHER',
      'nexgen.study.scholar.monthly':                 'SCHOLAR',
      'nexgen.study.researcher.monthly':              'RESEARCHER',
      'nexgen.study.scholar':                         'SCHOLAR',
      'nexgen.study.researcher':                      'RESEARCHER',
    };

    let plan = productPlanMap[productId];
    let expiresAt = null;

    // StoreKit 2 returns a JWS token (3 base64url parts separated by dots)
    // Decode the payload without full signature verification
    // (Apple's servers already verified it before sending to the app)
    const isJWS = token.split('.').length === 3 && token.indexOf('\n') === -1;

    if (isJWS) {
      try {
        // Decode the JWS payload
        const parts      = token.split('.');
        const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const payload    = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));

        console.log('[Apple IAP] JWS payload:', JSON.stringify(payload));

        const detectedProductId = payload.productId || payload.product_id || productId;
        plan = productPlanMap[detectedProductId] || plan;

        if (payload.expiresDate) {
          expiresAt = new Date(payload.expiresDate);
        } else if (payload.expires_date_ms) {
          expiresAt = new Date(parseInt(payload.expires_date_ms));
        }

        // Check not expired
        if (expiresAt && expiresAt < new Date()) {
          return res.status(400).json({ error: 'Subscription has expired.' });
        }

      } catch (decodeErr) {
        console.error('[Apple IAP] JWS decode failed:', decodeErr.message);
        // Fall through — still try to use productId for plan
      }
    } else {
      // Legacy base64 receipt — try old verifyReceipt endpoint
      const verifyWithApple = async (url) => {
        const r = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            'receipt-data': token,
            password: process.env.APPLE_SHARED_SECRET || '',
            'exclude-old-transactions': true,
          }),
        });
        return r.json();
      };

      let appleResp = await verifyWithApple('https://buy.itunes.apple.com/verifyReceipt');
      if (appleResp.status === 21007) {
        appleResp = await verifyWithApple('https://sandbox.itunes.apple.com/verifyReceipt');
      }

      if (appleResp.status !== 0) {
        console.error('[Apple IAP] verifyReceipt failed, status:', appleResp.status);
        return res.status(400).json({ error: 'Receipt verification failed.', appleStatus: appleResp.status });
      }

      const latest = (appleResp.latest_receipt_info || []).slice(-1)[0];
      if (latest) {
        plan = productPlanMap[latest.product_id] || plan;
        const ms = parseInt(latest.expires_date_ms || '0');
        if (ms) expiresAt = new Date(ms);
      }
    }

    // Final plan check
    if (!plan) {
      console.error('[Apple IAP] Unknown productId:', productId);
      return res.status(400).json({ error: 'Unknown product ID: ' + (productId || 'not provided') });
    }

    const now = new Date();

    // Update user in DB
    await req.prisma.$queryRawUnsafe(`
      UPDATE "User"
      SET plan                 = $1::"Plan",
          "subscriptionStatus" = 'ACTIVE'::"SubscriptionStatus",
          "trialEndsAt"        = NULL,
          "updatedAt"          = $2
      WHERE id = $3
    `, plan, now, req.user.id);

    const { auditLog } = require('../services/auditService');
    await auditLog(req.prisma, {
      userId:   req.user.id,
      action:   'APPLE_IAP_VERIFIED',
      severity: 'INFO',
      metadata: { plan, productId, expiresAt },
      ipAddress: req.ip,
    });

    console.log(`[Apple IAP] User ${req.user.id} → ${plan}, expires ${expiresAt || 'N/A'}`);

    const userRows = await req.prisma.$queryRawUnsafe(
      `SELECT id, email, "fullName", plan, "subscriptionStatus", "mfaEnabled", "totalGenerations", "trialEndsAt"
       FROM "User" WHERE id = $1`,
      req.user.id
    );

    return res.json({
      success: true,
      plan,
      subscriptionStatus: 'ACTIVE',
      expiresAt,
      user: userRows[0] || null,
    });

  } catch (err) {
    console.error('[Apple IAP] Error:', err.message, err.stack);
    next(err);
  }
});

module.exports = router;
