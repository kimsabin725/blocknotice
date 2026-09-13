#!/usr/bin/env tsx
// blocknotice CLI — day 1: issue a synthetic denial, then verify it with the institution gone.
import { readFileSync } from "node:fs";
import { verifyBundle, type VerifyReport } from "./verify.js";
import { bigintReviver } from "./institution.js";
import { runCase, writeJson, INPUTS } from "./scenario.js";
import type { ReceiptBundle } from "./types.js";

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
      if (!path) throw new Error("usage: verify <bundle.json> [--block N]");
      const bundle = JSON.parse(readFileSync(path, "utf8"), bigintReviver) as ReceiptBundle;
      const block = arg("block");
      process.exit(render(await verifyBundle(bundle, { currentBlock: block ? BigInt(block) : undefined })));
    }
    default:
      console.log(`blocknotice
  issue  --case clean|screening|review|limit [--ack] [--out path]
  verify <bundle.json> [--block N]`);
  }
}
main().catch(e => { console.error(e); process.exit(2); });
