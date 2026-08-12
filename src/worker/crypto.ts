/**
 * Encryption at rest, plus a constant-time string compare.
 *
 * Two real credentials end up in D1: Manyfold's device code (the only thing that can
 * redeem agent tokens) and each agent's bearer token. Neither may be stored in the
 * clear — a database export, a stray log line, or a single console query would leak them.
 *
 * AES-GCM with a key derived by SHA-256 from key material resolved in this order:
 *   1. the CONFIG_ENCRYPTION_KEY secret, if it is at least 32 characters
 *   2. a key previously generated and stored in the `settings` table
 *   3. a fresh 32 random bytes, stored with INSERT OR IGNORE so that concurrent
 *      first requests converge on one winner
 *
 * Step 3 is what makes one-click deploy possible: nothing to invent before the app
 * runs. The trade-off is honest — with a generated key, encryption protects against
 * partial exposure (logs, error messages, a table-scoped query) but not against
 * someone who can dump the whole database, since the key sits in it. Setting the
 * secret removes that caveat:  npx wrangler secret put CONFIG_ENCRYPTION_KEY
 */

import type { Env } from './types';
import { getSetting, setSettingIfAbsent } from './db';

const GENERATED_KEY_SETTING = 'config_encryption_key';

const enc = new TextEncoder();
const dec = new TextDecoder();

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const toB64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const fromB64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** Per-isolate memo of the generated key, so the common path costs no extra query. */
let generatedMaterial: string | null = null;

async function keyMaterial(env: Env): Promise<string> {
  const secret = (env.CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (secret.length >= 32) return secret;
  if (generatedMaterial) return generatedMaterial;

  const stored = await getSetting(env, GENERATED_KEY_SETTING);
  if (stored && stored.length >= 32) {
    generatedMaterial = stored;
    return stored;
  }

  const fresh = toB64(crypto.getRandomValues(new Uint8Array(32)));
  await setSettingIfAbsent(env, GENERATED_KEY_SETTING, fresh);
  // Re-read rather than trusting `fresh`: a concurrent request may have won the insert.
  const winner = (await getSetting(env, GENERATED_KEY_SETTING)) ?? fresh;
  generatedMaterial = winner;
  return winner;
}

const keyCache = new Map<string, CryptoKey>();

async function aesKey(env: Env): Promise<CryptoKey> {
  const material = await keyMaterial(env);
  const cached = keyCache.get(material);
  if (cached) return cached;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(material));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  keyCache.set(material, key);
  return key;
}

export interface Sealed {
  ciphertext: string;
  iv: string;
}

export async function seal(env: Env, plaintext: string): Promise<Sealed> {
  const key = await aesKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return { ciphertext: toB64(new Uint8Array(buffer)), iv: toB64(iv) };
}

export async function unseal(env: Env, ciphertext: string, iv: string): Promise<string> {
  const key = await aesKey(env);
  try {
    const buffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(iv) },
      key,
      fromB64(ciphertext),
    );
    return dec.decode(buffer);
  } catch {
    // Reached after the key material changes: old ciphertext can never be read again,
    // so the user has to authorize the agent once more.
    throw new ConfigError(
      'Could not decrypt a stored credential — the encryption key changed. Connect your agent again.',
    );
  }
}

/** Constant-time compare, so response timing cannot be used to guess the password. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
  return diff === 0;
}
