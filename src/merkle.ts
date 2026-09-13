// Order-preserving, append-only binary Merkle tree, fixed depth 32, leaves unsorted.
// Same hashing as the on-chain log so proofs verify identically off-chain and on-chain.
import type { Hex } from "viem";
import { leafHash, nodeHash, ZERO32 } from "./encode.js";
import type { InclusionProof } from "./types.js";

export const DEPTH = 32;

export const ZEROS: Hex[] = (() => {
  const z: Hex[] = [ZERO32];               // empty leaf slot
  for (let i = 1; i <= DEPTH; i++) z.push(nodeHash(z[i - 1], z[i - 1]));
  return z;
})();

export class IncrementalTree {
  readonly leaves: Hex[] = [];
  constructor(readonly treeId: Hex) {}

  get size() { return this.leaves.length; }

  /** Append an already-domain-separated leaf hash (use leafHash(recordDigest)). Returns index. */
  append(leaf: Hex): number {
    if (this.leaves.length >= 2 ** DEPTH) throw new Error("tree full");
    this.leaves.push(leaf);
    return this.leaves.length - 1;
  }
  appendRecord(rd: Hex): number { return this.append(leafHash(rd)); }

  root(): Hex { return rootOf(this.leaves); }

  proof(index: number): InclusionProof {
    if (index < 0 || index >= this.leaves.length) throw new Error("index out of range");
    const siblings: Hex[] = [];
    let level: Hex[] = this.leaves.slice();
    let idx = index;
    for (let d = 0; d < DEPTH; d++) {
      const sib = idx ^ 1;
      siblings.push(sib < level.length ? level[sib] : ZEROS[d]);
      const next: Hex[] = [];
      for (let i = 0; i < level.length; i += 2) {
        const l = level[i], r = i + 1 < level.length ? level[i + 1] : ZEROS[d];
        next.push(nodeHash(l, r));
      }
      level = next; idx >>= 1;
    }
    return { treeId: this.treeId, index, size: this.leaves.length, root: this.root(), siblings };
  }
}

export function rootOf(leaves: Hex[]): Hex {
  let level: Hex[] = leaves.slice();
  for (let d = 0; d < DEPTH; d++) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i], r = i + 1 < level.length ? level[i + 1] : ZEROS[d];
      next.push(nodeHash(l, r));
    }
    level = next.length ? next : [ZEROS[d + 1]];
  }
  return level[0];
}

/** Verify that `leaf` sits at proof.index of a tree with proof.size leaves and root proof.root. */
export function verifyInclusion(leaf: Hex, proof: InclusionProof): boolean {
  if (proof.siblings.length !== DEPTH) return false;
  if (proof.index < 0 || proof.index >= proof.size) return false;
  let h = leaf, idx = proof.index;
  for (let d = 0; d < DEPTH; d++) {
    const s = proof.siblings[d];
    h = (idx & 1) === 0 ? nodeHash(h, s) : nodeHash(s, h);
    idx >>= 1;
  }
  return h.toLowerCase() === proof.root.toLowerCase();
}
