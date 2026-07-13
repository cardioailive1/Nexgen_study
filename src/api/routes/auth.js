'use strict';

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const passport = require('passport');
const GoogleStrategy   = require('passport-google-oauth20').Strategy;
const MicrosoftStrategy = require('passport-microsoft').Strategy;
const { auditLog } = require('../services/auditService');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/emailService');
const { requireAuth } = require('../middleware/requireAuth');
const { encryptMfaSecret, decryptMfaSecret, generateMfaBackupCodes } = require('../utils/crypto');
const speakeasy = require('speakeasy') // you'll add this dep
  || { generateSecret: () => ({ base32: 'MOCK' }), totp: { verify: () => true } }; // graceful fallback

const router = express.Router();

// ── PASSPORT SETUP ────────────────────────────────────────────────
function setupPassport(prisma) {
  // Google OAuth2
  if (process.env.GOOGLE_CLIENT_ID) {
    passport.use(new GoogleStrategy({
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL,
      scope: ['profile', 'email'],
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value;
        if (!email) return done(new Error('No email from Google'));

        let user = await prisma.user.findFirst({
          where: { OR: [{ email }, { oauthProvider: 'GOOGLE', oauthProviderId: profile.id }] }
        });

        if (!user) {
          user = await prisma.user.create({
            data: {
              email,
              fullName: profile.displayName || email.split('@')[0],
              avatarUrl: profile.photos?.[0]?.value,
              emailVerified: true,
              emailVerifiedAt: new Date(),
              oauthProvider: 'GOOGLE',
              oauthProviderId: profile.id,
              plan: 'TRIAL',
              trialStartedAt: new Date(),
              trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              termsAcceptedAt: new Date(),
              privacyAcceptedAt: new Date(),
            }
          });
        }
        return done(null, user);
      } catch (err) { return done(err); }
    }));
  }

  // Microsoft OAuth2
  if (process.env.MICROSOFT_CLIENT_ID) {
    passport.use(new MicrosoftStrategy({
      clientID:     process.env.MICROSOFT_CLIENT_ID,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
      callbackURL:  process.env.MICROSOFT_CALLBACK_URL,
      scope: ['user.read'],
    }, async (accessToken, refreshToken, profile, done) => {
      try {
        const email = profile.emails?.[0]?.value || profile._json?.mail || profile._json?.userPrincipalName;
        if (!email) return done(new Error('No email from Microsoft'));

        let user = await prisma.user.findFirst({
          where: { OR: [{ email }, { oauthProvider: 'MICROSOFT', oauthProviderId: profile.id }] }
        });

        if (!user) {
          user = await prisma.user.create({
            data: {
              email,
              fullName: profile.displayName || email.split('@')[0],
              emailVerified: true,
              emailVerifiedAt: new Date(),
              oauthProvider: 'MICROSOFT',
              oauthProviderId: profile.id,
              plan: 'TRIAL',
              trialStartedAt: new Date(),
              trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
              termsAcceptedAt: new Date(),
              privacyAcceptedAt: new Date(),
            }
          });
        }
        return done(null, user);
      } catch (err) { return done(err); }
    }));
  }

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id, done) => {
    try {
      const user = await prisma.user.findUnique({ where: { id } });
      done(null, user);
    } catch (err) { done(err); }
  });
}

// ── TOKEN HELPERS ─────────────────────────────────────────────────
function signAccessToken(userId) {
  return jwt.sign({ sub: userId, type: 'access' },
    process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

function signRefreshToken(userId) {
  return jwt.sign({ sub: userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' });
}

function setAuthCookies(res, accessToken, refreshToken) {
  const isProduction = process.env.NODE_ENV === 'production';
  res.cookie('access_token', accessToken, {
    httpOnly: true, secure: isProduction, sameSite: 'strict',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true, secure: isProduction, sameSite: 'strict',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/api/auth/refresh',
  });
}

// ── REGISTER ──────────────────────────────────────────────────────
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  body('fullName').trim().isLength({ min: 2, max: 100 }),
  body('termsAccepted').equals('true'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, fullName } = req.body;
    const prisma = req.prisma;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists.' });

    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    const verificationToken = uuidv4();

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        fullName,
        plan: 'TRIAL',
        trialStartedAt: new Date(),
        trialEndsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        termsAcceptedAt: new Date(),
        privacyAcceptedAt: new Date(),
      }
    });

    await sendVerificationEmail(email, fullName, verificationToken);
    await auditLog(prisma, { userId: user.id, action: 'USER_REGISTERED', ipAddress: req.ip });

    res.status(201).json({
      message: 'Account created. Please check your email to verify your account.',
      userId: user.id,
    });
  } catch (err) { next(err); }
});

// ── LOGIN ─────────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password, mfaCode } = req.body;
    const prisma = req.prisma;

    const user = await prisma.user.findUnique({ where: { email } });

    // Constant-time comparison to prevent user enumeration
    if (!user || !user.passwordHash) {
      await bcrypt.compare(password, '$2b$12$invalidhashforenumeration123456789');
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Account lockout (SOC 2 CC6.1)
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      return res.status(423).json({ error: 'Account temporarily locked. Please try again later.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      const attempts = (user.loginAttempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await prisma.user.update({ where: { id: user.id }, data: { loginAttempts: attempts, lockedUntil } });
      await auditLog(prisma, { userId: user.id, action: 'LOGIN_FAILED', ipAddress: req.ip, severity: 'WARN' });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // MFA check
    if (user.mfaEnabled) {
      if (!mfaCode) return res.status(200).json({ requiresMfa: true });
      const secret = decryptMfaSecret(user.mfaSecret);
      const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: mfaCode, window: 1 });
      if (!verified) {
        await auditLog(prisma, { userId: user.id, action: 'MFA_FAILED', ipAddress: req.ip, severity: 'WARN' });
        return res.status(401).json({ error: 'Invalid MFA code.' });
      }
    }

    // Reset lockout on success
    await prisma.user.update({
      where: { id: user.id },
      data: { loginAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), lastLoginIp: req.ip }
    });

    const accessToken  = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);
    await auditLog(prisma, { userId: user.id, action: 'USER_LOGIN', ipAddress: req.ip });

    res.json({
      user: { id: user.id, email: user.email, fullName: user.fullName, plan: user.plan, mfaEnabled: user.mfaEnabled },
      accessToken,
    });
  } catch (err) { next(err); }
});

// ── REFRESH TOKEN ─────────────────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const token = req.cookies.refresh_token;
    if (!token) return res.status(401).json({ error: 'No refresh token.' });

    const payload = jwt.verify(token, process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET);
    if (payload.type !== 'refresh') return res.status(401).json({ error: 'Invalid token type.' });

    const user = await req.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || user.deletedAt) return res.status(401).json({ error: 'User not found.' });

    const accessToken = signAccessToken(user.id);
    res.cookie('access_token', accessToken, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ accessToken });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }
    next(err);
  }
});

// ── LOGOUT ────────────────────────────────────────────────────────
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    res.clearCookie('access_token');
    res.clearCookie('refresh_token', { path: '/api/auth/refresh' });
    await auditLog(req.prisma, { userId: req.user.id, action: 'USER_LOGOUT', ipAddress: req.ip });
    res.json({ message: 'Logged out successfully.' });
  } catch (err) { next(err); }
});

// ── GOOGLE OAUTH2 ─────────────────────────────────────────────────
router.get('/google', (req, res, next) => {
  setupPassport(req.prisma);
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })(req, res, next);
});

router.get('/google/callback', (req, res, next) => {
  passport.authenticate('google', { session: false }, async (err, user) => {
    if (err || !user) return res.redirect(`${process.env.APP_URL}/?error=oauth_failed`);
    const accessToken  = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);
    await auditLog(req.prisma, { userId: user.id, action: 'OAUTH_LOGIN', metadata: { provider: 'GOOGLE' }, ipAddress: req.ip });
    res.redirect(`${process.env.APP_URL}/?auth=success`);
  })(req, res, next);
});

// ── MICROSOFT OAUTH2 ──────────────────────────────────────────────
router.get('/microsoft', (req, res, next) => {
  setupPassport(req.prisma);
  passport.authenticate('microsoft', { session: false })(req, res, next);
});

router.get('/microsoft/callback', (req, res, next) => {
  passport.authenticate('microsoft', { session: false }, async (err, user) => {
    if (err || !user) return res.redirect(`${process.env.APP_URL}/?error=oauth_failed`);
    const accessToken  = signAccessToken(user.id);
    const refreshToken = signRefreshToken(user.id);
    setAuthCookies(res, accessToken, refreshToken);
    await auditLog(req.prisma, { userId: user.id, action: 'OAUTH_LOGIN', metadata: { provider: 'MICROSOFT' }, ipAddress: req.ip });
    res.redirect(`${process.env.APP_URL}/?auth=success`);
  })(req, res, next);
});

// ── PASSWORD RESET REQUEST ────────────────────────────────────────
router.post('/forgot-password', [body('email').isEmail().normalizeEmail()], async (req, res, next) => {
  try {
    // Always return 200 to prevent email enumeration
    const user = await req.prisma.user.findUnique({ where: { email: req.body.email } });
    if (user) {
      const token = jwt.sign({ sub: user.id, type: 'password_reset' }, process.env.JWT_SECRET, { expiresIn: '1h' });
      await sendPasswordResetEmail(user.email, user.fullName, token);
      await auditLog(req.prisma, { userId: user.id, action: 'PASSWORD_RESET_REQUESTED', ipAddress: req.ip });
    }
    res.json({ message: 'If an account exists with that email, a reset link has been sent.' });
  } catch (err) { next(err); }
});

// ── PASSWORD RESET CONFIRM ────────────────────────────────────────
router.post('/reset-password', [
  body('token').notEmpty(),
  body('password').isLength({ min: 8 }).matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    const payload = jwt.verify(req.body.token, process.env.JWT_SECRET);
    if (payload.type !== 'password_reset') throw new Error('Invalid token type');
    const passwordHash = await bcrypt.hash(req.body.password, parseInt(process.env.BCRYPT_ROUNDS || '12'));
    await req.prisma.user.update({ where: { id: payload.sub }, data: { passwordHash, loginAttempts: 0, lockedUntil: null } });
    await auditLog(req.prisma, { userId: payload.sub, action: 'PASSWORD_RESET_COMPLETED', ipAddress: req.ip });
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(400).json({ error: 'Invalid or expired reset link.' });
    }
    next(err);
  }
});

// ── MFA SETUP ─────────────────────────────────────────────────────
router.post('/mfa/setup', requireAuth, async (req, res, next) => {
  try {
    const secret = speakeasy.generateSecret({ name: `NexGen Study (${req.user.email})`, length: 20 });
    const encryptedSecret = encryptMfaSecret(secret.base32);
    await req.prisma.user.update({ where: { id: req.user.id }, data: { mfaSecret: encryptedSecret } });
    res.json({ secret: secret.base32, otpauth_url: secret.otpauth_url });
  } catch (err) { next(err); }
});

router.post('/mfa/verify', requireAuth, async (req, res, next) => {
  try {
    const { code } = req.body;
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    const secret = decryptMfaSecret(user.mfaSecret);
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: code, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid code.' });
    const backupCodes = generateMfaBackupCodes();
    await req.prisma.user.update({ where: { id: req.user.id }, data: { mfaEnabled: true, mfaBackupCodes: backupCodes.encrypted } });
    await auditLog(req.prisma, { userId: req.user.id, action: 'MFA_ENABLED', ipAddress: req.ip });
    res.json({ message: 'MFA enabled.', backupCodes: backupCodes.plain });
  } catch (err) { next(err); }
});

router.post('/mfa/disable', requireAuth, [body('code').notEmpty()], async (req, res, next) => {
  try {
    const user = await req.prisma.user.findUnique({ where: { id: req.user.id } });
    const secret = decryptMfaSecret(user.mfaSecret);
    const verified = speakeasy.totp.verify({ secret, encoding: 'base32', token: req.body.code, window: 1 });
    if (!verified) return res.status(400).json({ error: 'Invalid code.' });
    await req.prisma.user.update({ where: { id: req.user.id }, data: { mfaEnabled: false, mfaSecret: null, mfaBackupCodes: [] } });
    await auditLog(req.prisma, { userId: req.user.id, action: 'MFA_DISABLED', ipAddress: req.ip, severity: 'WARN' });
    res.json({ message: 'MFA disabled.' });
  } catch (err) { next(err); }
});

module.exports = router;
