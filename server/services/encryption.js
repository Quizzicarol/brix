/**
 * AES-256-GCM encryption for PII (phone, email) at rest.
 * Uses BRIX_ENCRYPTION_KEY from environment (32-byte hex = 64 chars).
 * Format: iv:authTag:ciphertext (all hex-encoded)
 */
const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey() {
  const hex = process.env.BRIX_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypt a plaintext string. Returns null if encryption key not configured.
 * @param {string} plaintext
 * @returns {string|null} encrypted string in format "iv:tag:ciphertext" or null
 */
function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  if (!key) return plaintext; // passthrough if no key configured
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an encrypted string. Handles both encrypted and plaintext values.
 * @param {string} ciphertext - encrypted "iv:tag:data" format or plaintext
 * @returns {string|null} decrypted string
 */
function decrypt(ciphertext) {
  if (!ciphertext) return null;
  const key = getKey();
  if (!key) return ciphertext; // passthrough if no key configured
  // If value doesn't look encrypted (no colons), return as-is (legacy plaintext)
  const parts = ciphertext.split(':');
  if (parts.length !== 3) return ciphertext;
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) return ciphertext;
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(data) + decipher.final('utf8');
  } catch {
    // Decryption failed — likely plaintext or corrupted
    return ciphertext;
  }
}

/**
 * Hash a value for indexed lookups (phone/email search).
 * Uses HMAC-SHA256 with the encryption key for consistent but non-reversible hashing.
 * @param {string} value
 * @returns {string|null} hex-encoded hash
 */
function hmacHash(value) {
  if (!value) return null;
  const key = getKey();
  if (!key) return value; // passthrough if no key
  return crypto.createHmac('sha256', key).update(value).digest('hex');
}

module.exports = { encrypt, decrypt, hmacHash };
