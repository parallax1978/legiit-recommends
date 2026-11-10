// Choosing which saved wording each step of a conversation uses.
//
// No model call is involved: selection is a pure function of the campaign's selection seed, the
// run's ordinal (0, 1, 2, …) and how many wordings each step has. The same inputs always give the
// same combination, so every run can be reproduced from what is stored on it.
//
//   balanced       Walks every combination exactly once per cycle in a seed-dependent order, and
//                  starts over when the library is exhausted. Each wording of each step is used
//                  equally often within a cycle.
//   seeded_random  Picks each step independently from a seeded pseudo-random stream (with
//                  replacement).

export type SelectionMode = "balanced" | "seeded_random";

export interface SelectionInput {
  mode: SelectionMode;
  seed: string;
  /** Zero-based position of the run in its revision's sequence. */
  ordinal: number;
  /** Number of saved wordings per step, in step order. Every entry must be >= 1. */
  counts: number[];
}

export interface SelectionResult {
  /** Zero-based wording index per step. */
  indices: number[];
  /** Index of the combination in mixed-radix order (first step is the least significant digit). */
  combinationIndex: bigint;
  totalCombinations: bigint;
  /** Which pass over the full set of combinations this run belongs to (balanced mode). */
  cycle: bigint;
}

const MASK_64 = (1n << 64n) - 1n;

/** FNV-1a 64-bit over UTF-8 bytes, followed by a splitmix64 finalizer for better diffusion. */
export function hash64(input: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  hash ^= hash >> 30n;
  hash = (hash * 0xbf58476d1ce4e5b9n) & MASK_64;
  hash ^= hash >> 27n;
  hash = (hash * 0x94d049bb133111ebn) & MASK_64;
  hash ^= hash >> 31n;
  return hash;
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a < 0n ? -a : a;
}

export function totalCombinations(counts: number[]): bigint {
  return counts.reduce((product, count) => product * BigInt(count), 1n);
}

function decompose(index: bigint, counts: number[]): number[] {
  const indices: number[] = [];
  let rest = index;
  for (const count of counts) {
    const radix = BigInt(count);
    indices.push(Number(rest % radix));
    rest /= radix;
  }
  return indices;
}

function compose(indices: number[], counts: number[]): bigint {
  let index = 0n;
  let weight = 1n;
  indices.forEach((digit, step) => {
    index += BigInt(digit) * weight;
    weight *= BigInt(counts[step] ?? 1);
  });
  return index;
}

export function selectCombination(input: SelectionInput): SelectionResult {
  const { mode, seed, ordinal, counts } = input;
  if (!Number.isInteger(ordinal) || ordinal < 0)
    throw new Error("ordinal must be a non-negative integer");
  if (counts.length === 0 || counts.some((count) => !Number.isInteger(count) || count < 1)) {
    throw new Error("every step needs at least one wording");
  }
  const total = totalCombinations(counts);
  const n = BigInt(ordinal);

  if (mode === "seeded_random") {
    const indices = counts.map((count, step) =>
      Number(hash64(`${seed}:random:${ordinal}:${step}`) % BigInt(count)),
    );
    return {
      indices,
      combinationIndex: compose(indices, counts),
      totalCombinations: total,
      cycle: n / total,
    };
  }

  // Balanced: an affine walk (multiplier * n + offset) mod total. The multiplier is coprime with
  // the number of combinations, so the walk is a permutation: every combination appears exactly
  // once in each cycle of `total` runs.
  let multiplier = 1n;
  if (total > 1n) {
    // Start in the middle half of the range so consecutive runs differ in every step, not just
    // the first one, then move to the nearest value that is coprime with `total`.
    multiplier = total / 4n + (hash64(`${seed}:multiplier`) % (total / 2n + 1n));
    if (multiplier === 0n) multiplier = 1n;
    while (gcd(multiplier, total) !== 1n) {
      multiplier += 1n;
      if (multiplier >= total) multiplier = 1n;
    }
  }
  const offset = hash64(`${seed}:offset`) % total;
  const combinationIndex = (multiplier * (n % total) + offset) % total;
  return {
    indices: decompose(combinationIndex, counts),
    combinationIndex,
    totalCombinations: total,
    cycle: n / total,
  };
}
