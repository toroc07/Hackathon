import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTime = -1;
let lastRandom = new Uint8Array(10);

function encodeTime(timestamp: number): string {
  let value = timestamp;
  let encoded = '';
  for (let index = 0; index < 10; index += 1) {
    encoded = CROCKFORD[value % 32] + encoded;
    value = Math.floor(value / 32);
  }
  return encoded;
}

function incrementRandom(bytes: Uint8Array): void {
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const value = (bytes[index] ?? 0) + 1;
    bytes[index] = value & 0xff;
    if (value <= 0xff) return;
  }
}

function encodeRandom(bytes: Uint8Array): string {
  let value = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += CROCKFORD[(value >>> bits) & 31];
    }
  }
  return encoded.padEnd(16, '0').slice(0, 16);
}

/** ULID compatible: 10 caracteres temporales + 16 aleatorios, monotónico por proceso. */
export function newId(timestamp = Date.now()): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 281_474_976_710_655) {
    throw new RangeError('El timestamp para newId debe caber en 48 bits');
  }
  if (timestamp === lastTime) {
    incrementRandom(lastRandom);
  } else {
    lastTime = timestamp;
    lastRandom = randomBytes(10);
  }
  return encodeTime(timestamp) + encodeRandom(lastRandom);
}
