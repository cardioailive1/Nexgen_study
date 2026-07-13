'use strict';

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH  = 16;
const TAG_LENGTH = 16;

function getKey() {
  const k = process.env.ENCRYPTION_KEY;
  if (!k) throw new Error('ENCRYPTION_KEY not set');
  return Buffer.from(k, 'hex').slice(0, KEY_LENGTH);
}

function encryptMfaSecret(plaintext) {
  const iv  = crypto.randomBytes(IV_LENGTH);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptMfaSecret(ciphertext) {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv  = buf.slice(0, IV_LENGTH);
  const tag = buf.slice(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const encrypted = buf.slice(IV_LENGTH + TAG_LENGTH);
  const key = getKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function generateMfaBackupCodes() {
  const plain = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());
  const encrypted = plain.map(c => encryptMfaSecret(c));
  return { plain, encrypted };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

module.exports = { encryptMfaSecret, decryptMfaSecret, generateMfaBackupCodes, hashToken };
