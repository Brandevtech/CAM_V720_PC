/**
 * NaxCrypto Module
 * Reverse engineered from com.naxclow.common.util.AESCbcUtils
 */

import crypto from 'crypto';

export const AES_KEY = 'TrxGGCimol8Fkzy8ITUjOHA6bv7hSjet';
export const ALGORITHM = 'aes-256-cbc';
export const CHAR_POOL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Generates random 16-byte IV from character pool
 */
export function generateIv() {
  let iv = '';
  for (let i = 0; i < 16; i++) {
    iv += CHAR_POOL.charAt(Math.floor(Math.random() * CHAR_POOL.length));
  }
  return iv;
}

/**
 * Encrypts plain text with AES-256-CBC and returns Base64 string
 */
export function encrypt(plainText, key = AES_KEY, ivString = null) {
  const iv = ivString ? Buffer.from(ivString, 'utf8') : crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key, 'utf8'), iv);
  
  let encrypted = cipher.update(plainText, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  return {
    iv: iv.toString('utf8'),
    data: encrypted
  };
}

/**
 * Decrypts Base64 ciphertext with AES-256-CBC
 */
export function decrypt(cipherTextBase64, ivString, key = AES_KEY) {
  try {
    const iv = Buffer.from(ivString, 'utf8');
    const decipher = crypto.createDecipheriv(ALGORITHM, Buffer.from(key, 'utf8'), iv);
    
    let decrypted = decipher.update(cipherTextBase64, 'base64', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption failed:', err.message);
    return null;
  }
}
