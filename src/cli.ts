#!/usr/bin/env tsx
// blocknotice CLI — issue a synthetic denial, then verify it with the institution gone: the bundle
// file plus a public RPC is everything the verifier gets.
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { verifyBundle, type VerifyReport, type VerifyOptions } from "./verify.js";
import { bigintReviver } from "./institution.js";
import { runCase, writeJson, INPUTS } from "./scenario.js";
import { acceptedReceiptDigest, challengeIdOf } from "./encode.js";
import type { ReceiptBundle } from "./types.js";

const PUBLIC_RPC: Record<string, string> = {
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  hoodi: "https://ethereum-hoodi-rpc.publicnode.com",
};

const [, , cmd, ...rest] = process.argv;
const arg = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

function render(r: VerifyReport) {
  const mark: Record<string, string> = { CONFIRMED: "확인됨   ", NOT_DUE: "기한 미도래", OBLIGATION_UNMET: "의무 미이행", UNVERIFIABLE: "검증 불가 ", OUT_OF_SCOPE: "범위 밖  " };
  console.log(`\nrequest  ${r.requestId}`);
  console.log(`요청자   ${r.requester}`);
  console.log(`기관     ${r.institution}`);
  console.log(`결과     ${r.outcome}   앵커 상태 ${r.anchorState}   기관 서버 접속 ${r.institutionNetworkCalls}회\n`);
  for (const c of r.checks) console.log(`  ${mark[c.status]}  ${c.id.padEnd(24)} ${c.detail}`);
  console.log(`\n  합계  ${Object.entries(r.summary).map(([k, v]) => `${k}=${v}`).join("  ")}`);
  return r.summary.OBLIGATION_UNMET === 0 ? 0 : 1;
}

async function main() {
  switch (cmd) {
    case "issue": {
      const inputs = (arg("case") ?? "screening") as keyof typeof INPUTS;
      const out = arg("out") ?? `out/bundle-${inputs}.json`;
      const { bundle, inst, requestId } = await runCase({ inputs, ack: arg("ack") !== undefined });
      writeJson(out, bundle);
      writeJson(out.replace(/\.json$/, ".reason.json"), inst.openReason(requestId, 0));  // authorised-reviewer material, kept separate
      console.log(`issued ${inputs} case → ${out}`);
      console.log(`  outcome ${bundle.decisions.at(-1)?.record.outcome}  notice: ${bundle.decisions.at(-1)?.record.noticeText}`);
      break;
    }
    case "verify": {
      const path = arg("bundle") ?? rest[0];
      if (!path) throw new Error("usage: verify <bundle.json> [--block N] [--rpc URL --contract 0x… | --network sepolia|hoodi]");
      const bundle = JSON.parse(readFileSync(path, "utf8"), bigintReviver) as ReceiptBundle;
      const block = arg("block");
      const opts: VerifyOptions = { currentBlock: block ? BigInt(block) : undefined };
      const net = arg("network");
      let rpc = arg("rpc"), contract = arg("contract");
      if (net) {
        const d = JSON.parse(readFileSync("deployments.json", "utf8"))[net];
        if (!d) throw new Error(`no deployment named ${net} in deployments.json`);
        contract ??= d.contract;
        rpc ??= process.env[`${net.toUpperCase()}_RPC_URL`] || PUBLIC_RPC[net];
      }
      if (rpc && contract) {
        // Everything below is read from the public chain. The institution is not contacted and may
        // no longer exist; the bundle's own proofs are not trusted — the log is rebuilt from events.
        const { readonlyCtx, observe } = await import("./chain.js");
        const ctx = readonlyCtx(rpc, contract as Address);
        const id = challengeIdOf(bundle.profile.serviceId, acceptedReceiptDigest(bundle.profile, bundle.acceptedReceipt));
        const { opts: seen, log } = await observe(ctx, bundle.profile.serviceId, id);
        console.log(`\nchain    ${new URL(rpc).host}  chainId ${seen.registry.chainId}  contract ${contract}  block ${seen.currentBlock}`);
        console.log(`log      rebuilt from Appended events: ${log.size} leaves, root ${log.root.slice(0, 10)}… — ${log.agrees ? "agrees with the contract's root" : "DISAGREES with the contract's root"}`);
        console.log(`challenge ${id.slice(0, 10)}…  state ${seen.challenge.state}${seen.challenge.answeredLate ? " (answered late)" : ""}`);
        Object.assign(opts, seen, { currentBlock: opts.currentBlock ?? seen.currentBlock });
      } else if (rpc || contract) {
        throw new Error("--rpc and --contract go together (or use --network)");
      }
      process.exit(render(await verifyBundle(bundle, opts)));
    }
    default:
      console.log(`blocknotice
  issue  --case clean|screening|review|limit [--ack] [--out path]
  verify <bundle.json> [--block N] [--rpc URL --contract 0x… | --network sepolia|hoodi]
         with --rpc/--network the registration, the log and the challenge verdict are read from the chain`);
  }
}
main().catch(e => { console.error(e); process.exit(2); });
