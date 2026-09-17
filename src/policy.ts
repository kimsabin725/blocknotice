// Synthetic redemption policy fixture (demo-policy-v1). Public on purpose so a verifier can re-execute it.
// Nothing here is a real exchange rule; it exists to produce ALLOW / DENY / DEFER from identical input shapes.
import { Outcome } from "./types.js";

export const POLICY_VERSION = "demo-policy-v1";
export const POLICY_SOURCE = `
R1 destination ∈ sanctioned(sanctionsListVersion)      -> DENY  SCREENING_MATCH
R2 riskScore >= riskThreshold                           -> DEFER ENHANCED_REVIEW (review due in reviewBlocks)
R3 amount + withdrawnToday > dailyLimit                 -> DENY  LIMIT_EXCEEDED
else                                                    -> ALLOW OK
`.trim();

export interface PolicyInputs {
  sanctionsListVersion: string;
  sanctioned: string[];
  dailyLimit: string;
  withdrawnToday: string;
  riskScore: number;
  riskThreshold: number;
  reviewBlocks: number;
}

export interface PolicyResult {
  outcome: Outcome;
  category: string;          // public notice category code
  noticeText: string;        // what the requester is told
  ruleIds: string[];         // private detail
  detail: string;            // private detail
}

export function runPolicy(env: { amount: string; destination: string }, inp: PolicyInputs): PolicyResult {
  if (inp.sanctioned.map(s => s.toLowerCase()).includes(env.destination.toLowerCase()))
    return { outcome: Outcome.DENY, category: "SCREENING_MATCH", ruleIds: ["R1"],
      noticeText: "상환 요청이 승인되지 않았습니다. 사유 분류: 거래 상대방 스크리닝.",
      detail: `destination matched sanctions list ${inp.sanctionsListVersion}` };
  if (inp.riskScore >= inp.riskThreshold)
    return { outcome: Outcome.DEFER, category: "ENHANCED_REVIEW", ruleIds: ["R2"],
      noticeText: "상환 요청이 추가 검토 대상으로 보류되었습니다. 재검토 기한이 영수증에 기재되어 있습니다.",
      detail: `riskScore ${inp.riskScore} >= threshold ${inp.riskThreshold}` };
  if (Number(env.amount) + Number(inp.withdrawnToday) > Number(inp.dailyLimit))
    return { outcome: Outcome.DENY, category: "LIMIT_EXCEEDED", ruleIds: ["R3"],
      noticeText: "상환 요청이 승인되지 않았습니다. 사유 분류: 일일 상환 한도 초과.",
      detail: `amount ${env.amount} + withdrawnToday ${inp.withdrawnToday} > dailyLimit ${inp.dailyLimit}` };
  return { outcome: Outcome.ALLOW, category: "OK", ruleIds: [], noticeText: "상환 요청이 승인되었습니다.", detail: "no rule fired" };
}
