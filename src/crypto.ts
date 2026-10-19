// Password hashing with the Web Crypto API (built into Cloudflare Workers).
// Stored format:  pbkdf2$<iterations>$<salt base64>$<hash base64>
// Cloudflare Workers allows at most 100,000 PBKDF2 iterations.

const ITERATIONS = 100_000;

const toB64 = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toB64(salt)}$${toB64(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split('$');
  if (scheme !== 'pbkdf2') return false;
  const bits = new Uint8Array(await derive(password, fromB64(salt), Number(iter)));
  const expected = fromB64(hash);
  if (bits.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < bits.length; i++) diff |= bits[i] ^ expected[i]; // constant-time compare
  return diff === 0;
}

// ---------- reversible encryption (so an admin can look a student's password up again) ----------
// Stored format:  v1$<iv base64>$<ciphertext base64>   (AES-256-GCM)
// The key is derived from a Cloudflare secret, so a copy of the database alone cannot reveal passwords.

async function aesKey(secret: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('damiland-student-password-v1:' + secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptSecret(plain: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), new TextEncoder().encode(plain));
  return `v1$${toB64(iv)}$${toB64(ct)}`;
}

// Returns null when the value is missing, malformed, or the secret has changed.
export async function decryptSecret(stored: string | null | undefined, secret: string): Promise<string | null> {
  if (!stored) return null;
  const [scheme, iv, ct] = stored.split('$');
  if (scheme !== 'v1' || !iv || !ct) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(secret), fromB64(ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// Easy-to-read random password for students (no 0/O, 1/I/L confusion).
export function randomPassword(length = 6): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
