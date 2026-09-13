// Wires a full case end to end: request → acceptance → decision → bundle. Used by the CLI and tests.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Institution, localClock, bigintReplacer, type Knobs } from "./institution.js";
import { Requester } from "./requester.js";
import { newSigner } from "./crypto.js";
import { DEMO_PROFILE } from "./profile.js";
import type { PolicyInputs } from "./policy.js";
import type { ProtocolProfile, ReceiptBundle, RequestEnvelope } from "./types.js";
import type { Clock } from "./institution.js";

export const SANCTIONED = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

export const INPUTS: Record<"clean" | "screening" | "review" | "limit", PolicyInputs> = {
  clean:     { sanctionsListVersion: "OFAC-2026-09-01", sanctioned: [SANCTIONED], dailyLimit: "1000", withdrawnToday: "0",   riskScore: 10, riskThreshold: 80, reviewBlocks: 40 },
  screening: { sanctionsListVersion: "OFAC-2026-09-01", sanctioned: [SANCTIONED], dailyLimit: "1000", withdrawnToday: "0",   riskScore: 10, riskThreshold: 80, reviewBlocks: 40 },
  review:    { sanctionsListVersion: "OFAC-2026-09-01", sanctioned: [SANCTIONED], dailyLimit: "1000", withdrawnToday: "0",   riskScore: 95, riskThreshold: 80, reviewBlocks: 40 },
  limit:     { sanctionsListVersion: "OFAC-2026-09-01", sanctioned: [SANCTIONED], dailyLimit: "1000", withdrawnToday: "900", riskScore: 10, riskThreshold: 80, reviewBlocks: 40 },
};

export interface RunOptions {
  body?: Partial<RequestEnvelope>; inputs?: keyof typeof INPUTS; knobs?: Knobs; decide?: boolean; ack?: boolean;
  /** Anchoring against a real chain needs the chain's block height and the deployed log address. */
  profile?: Omit<ProtocolProfile, "institutionKeyId">; clock?: Clock;
}

export async function runCase(o: RunOptions = {}) {
  const clock = o.clock ?? localClock();
  const inst = await Institution.create(o.profile ?? DEMO_PROFILE, newSigner(), clock);
  const req = await Requester.create(newSigner());
  const body: Omit<RequestEnvelope, "salt"> = {
    requestType: "WITHDRAWAL", asset: "USDT", amount: "500",
    destination: o.inputs === "screening" ? SANCTIONED : "0xabc0000000000000000000000000000000000001",
    ...o.body,
  };
  const built = await req.buildRequest(inst.profile, body, inst.hpke.publicKey, clock.block());
  await inst.accept(built.request, built.signature, built.sealedEnvelope, req.hpke.publicKey, o.knobs);
  if (o.decide !== false) {
    const { sealed } = await inst.decide(built.request.requestId, INPUTS[o.inputs ?? "screening"], o.knobs);
    const received = await req.receive(inst.profile, sealed, inst.address);   // requester checks the signature itself
    if (o.ack) inst.recordAck(await req.ack(inst.profile, received.record));
  }
  return { inst, req, clock, requestId: built.request.requestId, bundle: inst.bundle(built.request.requestId) };
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, bigintReplacer, 2));
}
export function readBundle(path: string): ReceiptBundle {
  const { readFileSync } = require("node:fs");
  const { bigintReviver } = require("./institution.js");
  return JSON.parse(readFileSync(path, "utf8"), bigintReviver);
}
