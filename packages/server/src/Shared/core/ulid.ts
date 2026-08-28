import { randomBytes } from "node:crypto";

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const ULID_LENGTH = TIME_LENGTH + RANDOM_LENGTH;
const TIME_MAX = 281474976710655; // 2^48 - 1
const RANDOM_MAX = (1n << 80n) - 1n;

const CHAR_TO_VALUE = new Map<string, number>();
for (let i = 0; i < ENCODING.length; i++) {
  CHAR_TO_VALUE.set(ENCODING[i]!, i);
}

function encodeTime(timeMs: number): string {
  if (!Number.isInteger(timeMs) || timeMs < 0 || timeMs > TIME_MAX) {
    throw new RangeError(`ULID timestamp must be an integer between 0 and ${TIME_MAX}, got ${timeMs}`);
  }
  let remaining = timeMs;
  let encoded = "";
  for (let i = 0; i < TIME_LENGTH; i++) {
    encoded = ENCODING[remaining % 32]! + encoded;
    remaining = Math.floor(remaining / 32);
  }
  return encoded;
}

function encodeRandom(random: bigint): string {
  let value = random;
  let encoded = "";
  for (let i = 0; i < RANDOM_LENGTH; i++) {
    encoded = ENCODING[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return encoded;
}

function randomBigint(): bigint {
  return BigInt(`0x${randomBytes(10).toString("hex")}`);
}

/** Random ULID: 48-bit millisecond timestamp + 80 bits of CSPRNG entropy. */
export function ulid(timeMs: number = Date.now()): string {
  return `${encodeTime(timeMs)}${encodeRandom(randomBigint())}`;
}

let monotonicTime = -1;
let monotonicRandom = 0n;

/**
 * Monotonic ULID: within this process, ids are strictly increasing even when
 * generated inside the same millisecond (the random section is incremented) or
 * when the clock regresses, so lexicographic order equals creation order.
 */
export function monotonicUlid(timeMs: number = Date.now()): string {
  if (timeMs > monotonicTime) {
    monotonicTime = timeMs;
    monotonicRandom = randomBigint();
  } else {
    // Same or regressed millisecond: keep ordering by incrementing the random
    // section; on 80-bit overflow bump the stored millisecond forward.
    monotonicRandom += 1n;
    if (monotonicRandom > RANDOM_MAX) {
      monotonicTime += 1;
      monotonicRandom = randomBigint();
    }
  }
  return `${encodeTime(monotonicTime)}${encodeRandom(monotonicRandom)}`;
}

/** Recover the 48-bit millisecond timestamp embedded in a ULID. */
export function decodeTime(id: string): number {
  if (id.length !== ULID_LENGTH) {
    throw new Error(`Invalid ULID length ${id.length}, expected ${ULID_LENGTH}`);
  }
  let time = 0;
  for (let i = 0; i < ULID_LENGTH; i++) {
    const value = CHAR_TO_VALUE.get(id[i]!);
    if (value === undefined) {
      throw new Error(`Invalid ULID character "${id[i]!}" at position ${i}`);
    }
    if (i < TIME_LENGTH) {
      time = time * 32 + value;
    }
  }
  return time;
}
