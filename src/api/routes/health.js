'use strict';

const express = require('express');
const router  = express.Router();

router.get('/', async (req, res) => {
  try {
    await req.prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', service: 'nexgen-study', timestamp: new Date().toISOString(), env: process.env.NODE_ENV });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'unavailable' });
  }
});

router.get('/ready', (_req, res) => res.json({ ready: true }));

module.exports = router;
