import { describe, expect, it } from 'vitest';
import { ConfigError, safeEqual, seal, unseal } from '../src/worker/crypto';
import type { Env } from '../src/worker/types';

// With CONFIG_ENCRYPTION_KEY set, crypto.ts never touches D1, so a bare object works.
const env = { CONFIG_ENCRYPTION_KEY: 'test-key-material-0123456789abcdef' } as Env;

describe('seal / unseal', () => {
  it('round-trips plaintext', async () => {
    const sealed = await seal(env, 'mf_cnx_super_secret');
    expect(sealed.ciphertext).not.toContain('mf_cnx');
    await expect(unseal(env, sealed.ciphertext, sealed.iv)).resolves.toBe('mf_cnx_super_secret');
  });

  it('produces a fresh IV per call', async () => {
    const a = await seal(env, 'same input');
    const b = await seal(env, 'same input');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects tampered ciphertext with a ConfigError', async () => {
    const sealed = await seal(env, 'value');
    const tampered = sealed.ciphertext.slice(0, -4) + (sealed.ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    await expect(unseal(env, tampered, sealed.iv)).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects ciphertext sealed under a different key', async () => {
    const other = { CONFIG_ENCRYPTION_KEY: 'another-key-material-0123456789abcdef' } as Env;
    const sealed = await seal(env, 'value');
    await expect(unseal(other, sealed.ciphertext, sealed.iv)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects unequal ones', () => {
    expect(safeEqual('swordfish', 'swordfish')).toBe(true);
    expect(safeEqual('swordfish', 'swordfIsh')).toBe(false);
    expect(safeEqual('short', 'longer-value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
