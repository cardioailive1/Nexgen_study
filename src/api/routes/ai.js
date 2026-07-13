'use strict';

const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/requireAuth');
const { requirePlan }  = require('../middleware/requirePlan');
const { checkDailyLimit, incrementDailyUsage } = require('../services/usageService');
const { auditLog } = require('../services/auditService');
const { body, validationResult } = require('express-validator');

const router   = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Model map — route by plan and tool type
const MODELS = {
  sonnet: process.env.ANTHROPIC_MODEL_SONNET || 'claude-sonnet-4-6',
  haiku:  process.env.ANTHROPIC_MODEL_HAIKU  || 'claude-haiku-4-5-20251001',
};

// Tools that use Haiku (cost optimisation)
const HAIKU_TOOLS = ['notes', 'flash', 'cite'];

// Cost per token (USD)
const COST = {
  [MODELS.sonnet]: { input: 3.00 / 1e6, output: 15.00 / 1e6 },
  [MODELS.haiku]:  { input: 1.00 / 1e6, output:  5.00 / 1e6 },
};

// Validate and sanitize AI requests
const validateAiRequest = [
  body('tool').isIn(['notes','essay','lecture','research','slides','flash','cite','stem','notebook']),
  body('subTool').isString().trim().isLength({ max: 50 }),
  body('prompt').isString().trim().isLength({ min: 1, max: 20000 }),
  body('system').isString().trim().isLength({ min: 1, max: 8000 }),
];

// ── POST /api/ai/generate ─────────────────────────────────────────
router.post('/generate', requireAuth, validateAiRequest, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { tool, subTool, prompt, system, stream = false } = req.body;
    const user   = req.user;
    const prisma = req.prisma;

    // Plan gating
    const planLimits = {
      TRIAL:      { allowed: true,  maxTokens: 2048 },
      SCHOLAR:    { allowed: true,  maxTokens: 4096 },
      RESEARCHER: { allowed: true,  maxTokens: 8192 },
    };

    const planLimit = planLimits[user.plan] || { allowed: false };
    if (!planLimit.allowed) {
      return res.status(403).json({ error: 'Please upgrade your plan to use this feature.' });
    }

    // NexGen Notebook — Researcher only
    if (tool === 'notebook' && user.plan !== 'RESEARCHER') {
      return res.status(403).json({
        error: 'NexGen Notebook is available on the Researcher plan.',
        upgradeUrl: process.env.STRIPE_RESEARCHER_LINK,
      });
    }

    // Check trial expiry
    if (user.plan === 'TRIAL' && user.trialEndsAt && user.trialEndsAt < new Date()) {
      return res.status(403).json({
        error: 'Your 7-day trial has ended. Please upgrade to continue.',
        upgradeUrl: process.env.STRIPE_SCHOLAR_LINK,
      });
    }

    // Daily usage limit
    const withinLimit = await checkDailyLimit(prisma, user);
    if (!withinLimit) {
      return res.status(429).json({
        error: 'Daily generation limit reached.',
        upgradeUrl: process.env.STRIPE_SCHOLAR_LINK,
      });
    }

    // Select model
    const model = HAIKU_TOOLS.includes(tool) && user.plan !== 'RESEARCHER'
      ? MODELS.haiku
      : MODELS.sonnet;

    const maxTokens = planLimit.maxTokens;

    // Call Anthropic
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '';
    const usage = response.usage || { input_tokens: 0, output_tokens: 0 };
    const costUsd = (usage.input_tokens * COST[model].input) + (usage.output_tokens * COST[model].output);

    // Track generation (SOC 2 CC7.2)
    await Promise.all([
      prisma.generation.create({
        data: {
          userId:       user.id,
          tool,
          subTool,
          model,
          inputTokens:  usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd,
          outputSize:   Buffer.byteLength(text, 'utf8'),
          status:       'COMPLETED',
          durationMs:   response._request_id ? undefined : undefined,
        }
      }),
      incrementDailyUsage(prisma, user),
      auditLog(prisma, {
        userId: user.id,
        action: 'GENERATION_CREATED',
        resource: 'generation',
        metadata: { tool, subTool, model, tokens: usage.input_tokens + usage.output_tokens },
      }),
    ]);

    res.json({ text, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, model } });

  } catch (err) {
    if (err.status === 429) {
      return res.status(503).json({ error: 'AI service temporarily unavailable. Please try again in a moment.' });
    }
    next(err);
  }
});

// ── GET /api/ai/usage ─────────────────────────────────────────────
router.get('/usage', requireAuth, async (req, res, next) => {
  try {
    const today = new Date(); today.setHours(0,0,0,0);
    const [todayCount, totalCount] = await Promise.all([
      req.prisma.generation.count({ where: { userId: req.user.id, createdAt: { gte: today } } }),
      req.prisma.generation.count({ where: { userId: req.user.id } }),
    ]);
    const limits = { TRIAL: 3, SCHOLAR: 999999, RESEARCHER: 999999 };
    const limit  = limits[req.user.plan] || 3;
    res.json({ today: todayCount, total: totalCount, limit, remaining: Math.max(0, limit - todayCount) });
  } catch (err) { next(err); }
});

module.exports = router;
