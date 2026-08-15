import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** Field officer passcodes.

    Stored as a scrypt hash with a per-account salt -- never in clear text, and never
    recoverable. An admin can issue a NEW passcode; nobody, including an admin, can read an
    existing one back. That is deliberate: a passcode an admin can look up is a passcode that
    leaks with the admin's screen, their screenshot, or their session.

    scrypt is deliberately slow, so a stolen database of hashes does not become a list of
    working passcodes. Comparison is constant-time, so a wrong guess cannot be narrowed down
    by how long the answer took. */

const KEYLEN = 32;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Human-typable on a phone keypad, in the field, possibly in the sun. No 0/O or 1/I/L --
    a passcode that gets misread is a support call, and support calls get "solved" by
    sharing someone else's working one. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

export function generatePasscode(len = 8) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  // Grouped for reading aloud over the phone without losing your place.
  return out.slice(0, 4) + '-' + out.slice(4);
}

export function normalisePasscode(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export function hashPasscode(passcode) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(normalisePasscode(passcode), salt, KEYLEN, SCRYPT).toString('hex');
  return { hash, salt };
}

/** False for any account that has no passcode set, so a row created before passcodes
    existed can never be signed into by guessing an empty string. */
export function verifyPasscode(passcode, hash, salt) {
  if (!hash || !salt) return false;
  const given = normalisePasscode(passcode);
  if (!given) return false;
  let derived;
  try {
    derived = scryptSync(given, salt, KEYLEN, SCRYPT);
  } catch {
    return false;
  }
  const stored = Buffer.from(String(hash), 'hex');
  if (stored.length !== derived.length) return false;
  return timingSafeEqual(stored, derived);
}
