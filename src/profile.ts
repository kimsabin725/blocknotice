// demo-sla-v1: a technical demonstration profile. Block counts here are NOT legal periods.
import type { ProtocolProfile } from "./types.js";
import { bytes32FromString } from "./encode.js";

export const DEMO_PROFILE: Omit<ProtocolProfile, "institutionKeyId"> = {
  name: "BlockNotice", version: "1",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000000001",
  serviceId: bytes32FromString("demo-exchange"),
  requestRecordDueBlocks: 5,
  decisionRecordDueBlocks: 20,
  challengeResponseBlocks: 30,
  maxDeferReviews: 2,
};
