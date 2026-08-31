/**
 * Ed25519 signing and SHA-256 hashing over canonical bytes.
 *
 * node:crypto only — no third-party crypto, and no network. Everything here
 * is deterministic given its inputs.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  timingSafeEqual,
  verify as nodeVerify,
  type KeyObject,
} from 'node:crypto';

import { canonicalBytes } from './canonical.js';

export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}

/** Lowercase hex SHA-256 of the canonical form of `value`. */
export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(canonicalBytes(value)).digest('hex');
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function generateEd25519KeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function loadPrivateKey(pem: string): KeyObject {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new CryptoError(`Expected an Ed25519 private key, got ${key.asymmetricKeyType}`);
    }
    return key;
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError('Could not parse Ed25519 private key (expected PKCS#8 PEM)');
  }
}

function loadPublicKey(pem: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new CryptoError(`Expected an Ed25519 public key, got ${key.asymmetricKeyType}`);
    }
    return key;
  } catch (err) {
    if (err instanceof CryptoError) throw err;
    throw new CryptoError('Could not parse Ed25519 public key (expected SPKI PEM)');
  }
}

/** Sign arbitrary bytes. Ed25519 takes no digest algorithm, hence the null. */
export function signBytes(message: Buffer, privateKeyPem: string): string {
  return nodeSign(null, message, loadPrivateKey(privateKeyPem)).toString('base64');
}

export function verifyBytes(
  message: Buffer,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
  } catch {
    return false;
  }
  // An Ed25519 signature is exactly 64 bytes; anything else is malformed input,
  // not a verification we should hand to the crypto layer.
  if (signature.length !== 64) return false;

  try {
    return nodeVerify(null, message, loadPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}

/** Sign the canonical form of a value. */
export function signCanonical(value: unknown, privateKeyPem: string): string {
  return signBytes(canonicalBytes(value), privateKeyPem);
}

export function verifyCanonical(
  value: unknown,
  signatureBase64: string,
  publicKeyPem: string,
): boolean {
  return verifyBytes(canonicalBytes(value), signatureBase64, publicKeyPem);
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Used for mandate-hash and API-key comparisons, where a timing side channel
 * would let a caller discover a valid value byte by byte.
 */
export function hashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
