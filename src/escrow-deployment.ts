import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  encodeAbiParameters,
  encodePacked,
  keccak256,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { hoodi, sepolia } from "viem/chains";
import { anvilChain } from "./chain.js";

export type EscrowNetwork = "hoodi" | "sepolia" | "local";
export type ServiceRole = "operator" | "courier" | "exchange";
export type JournalStatus = "pending" | "submitted" | "confirmed" | "failed";

export const DEFAULT_RECORD_PATH = "escrow-deployments.json";
export const DEFAULT_LOCAL_RPC_URL = "http://127.0.0.1:8545";

export const ESCROW_WINDOWS = {
  decisionBlocks: 20,
  handoffBlocks: 40,
  courierBlocks: 60,
  responseBlocks: 30,
  disputeBlocks: 30,
} as const;

export const SERVICE_REGISTRATION_WINDOWS = {
  challengeResponseBlocks: 30,
  requestRecordBlocks: 20,
  decisionRecordBlocks: 40,
} as const;

export const INBOX_WINDOWS = {
  forwardBlocks: 20,
  responseBlocks: 30,
} as const;

export const NETWORKS: Record<EscrowNetwork, {
  chain: Chain;
  rpcEnv: "HOODI_RPC_URL" | "SEPOLIA_RPC_URL" | "LOCAL_RPC_URL";
  explorer?: string;
}> = {
  hoodi: { chain: hoodi, rpcEnv: "HOODI_RPC_URL", explorer: "https://hoodi.etherscan.io" },
  sepolia: { chain: sepolia, rpcEnv: "SEPOLIA_RPC_URL", explorer: "https://sepolia.etherscan.io" },
  local: { chain: anvilChain(31337, DEFAULT_LOCAL_RPC_URL), rpcEnv: "LOCAL_RPC_URL" },
};

export interface JournalTransaction {
  status: JournalStatus;
  transactionHash?: Hex;
  blockNumber?: number;
  contractAddress?: Address;
  error?: string;
}

export interface ContractDeploymentRecord {
  address: Address;
  runtimeCodeHash: Hex;
  deploymentBlock?: number;
  transactionHash?: Hex;
  source: "existing-public-deployment" | "deployed-by-this-run";
}

export interface ServiceDeploymentRecord {
  role: ServiceRole;
  serviceId: Hex;
  operator: Address;
  signer: Address;
  profileHash: Hex;
  challengeResponseBlocks: number;
  requestRecordBlocks: number;
  decisionRecordBlocks: number;
}

export interface EscrowDeploymentRecord {
  format: "blocknotice-escrow-deployment-v1";
  status: "in-progress" | "complete";
  network: EscrowNetwork;
  chainId: number;
  rpcEnvironmentVariable: string;
  deployer: Address;
  namespace: Hex;
  createdAt: string;
  completedAt?: string;
  demoMode: {
    token: "MockGold";
    permissionlessMinting: true;
    warning: string;
  };
  services: {
    commonControl: true;
    controlDisclosure: string;
    operator: ServiceDeploymentRecord;
    courier: ServiceDeploymentRecord;
    exchange: ServiceDeploymentRecord;
  };
  profile: typeof ESCROW_WINDOWS & { profileHash?: Hex };
  inboxProfile: typeof INBOX_WINDOWS & { profileHash?: Hex };
  contracts: {
    log?: ContractDeploymentRecord;
    token?: ContractDeploymentRecord;
    escrow?: ContractDeploymentRecord;
    inbox?: ContractDeploymentRecord;
  };
  transactions: Partial<Record<"log" | "token" | "registerOperator" | "registerCourier" | "registerExchange" | "escrow" | "inbox", JournalTransaction>>;
  explorer?: {
    log?: string;
    token?: string;
    escrow?: string;
    inbox?: string;
  };
}

export type CompleteEscrowDeploymentRecord = EscrowDeploymentRecord & {
  status: "complete";
  completedAt: string;
  profile: typeof ESCROW_WINDOWS & { profileHash: Hex };
  inboxProfile: typeof INBOX_WINDOWS & { profileHash: Hex };
  contracts: {
    log: ContractDeploymentRecord;
    token: ContractDeploymentRecord;
    escrow: ContractDeploymentRecord;
    inbox: ContractDeploymentRecord;
  };
  transactions: Record<"token" | "registerOperator" | "registerCourier" | "registerExchange" | "escrow" | "inbox", JournalTransaction> &
    Partial<Record<"log", JournalTransaction>>;
};

export type EscrowDeploymentFile = Partial<Record<EscrowNetwork, EscrowDeploymentRecord>>;

const here = dirname(fileURLToPath(import.meta.url));
function readArtifact(source: string, contract: string) {
  const path = join(here, "..", "forge-out", source, `${contract}.json`);
  if (!existsSync(path)) throw new Error(`missing ${path}; run \`npm run build:contracts\` first`);
  return JSON.parse(readFileSync(path, "utf8"));
}

const logArtifact = readArtifact("BlockNoticeLog.sol", "BlockNoticeLog");
const tokenArtifact = readArtifact("MockGold.sol", "MockGold");
const escrowArtifact = readArtifact("RedemptionEscrow.sol", "RedemptionEscrow");
const inboxArtifact = readArtifact("RedemptionInbox.sol", "RedemptionInbox");
export const LOG_DEPLOYMENT_ABI = logArtifact.abi as any;
export const LOG_DEPLOYMENT_BYTECODE = logArtifact.bytecode.object as Hex;
export const MOCK_GOLD_ABI = tokenArtifact.abi as any;
export const MOCK_GOLD_BYTECODE = tokenArtifact.bytecode.object as Hex;
export const REDEMPTION_ESCROW_ABI = escrowArtifact.abi as any;
export const REDEMPTION_ESCROW_BYTECODE = escrowArtifact.bytecode.object as Hex;
export const REDEMPTION_INBOX_ABI = inboxArtifact.abi as any;
export const REDEMPTION_INBOX_BYTECODE = inboxArtifact.bytecode.object as Hex;

export function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
}

export function parseDeployArgs(args: string[]): { network: EscrowNetwork; recordPath: string } {
  const network = args[0];
  if (!network || network.startsWith("--")) {
    throw new Error("an explicit network is required: hoodi, sepolia, or local");
  }
  if (!(network in NETWORKS)) throw new Error(`unknown network ${network}; expected hoodi, sepolia, or local`);
  let recordPath = DEFAULT_RECORD_PATH;
  for (let index = 1; index < args.length; index++) {
    if (args[index] !== "--record" || !args[index + 1]) throw new Error(`unknown or incomplete argument ${args[index]}`);
    recordPath = args[++index];
  }
  return { network: network as EscrowNetwork, recordPath };
}

export function parseCheckArgs(args: string[]): { network?: EscrowNetwork; recordPath: string } {
  let network: EscrowNetwork | undefined;
  let recordPath = DEFAULT_RECORD_PATH;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--record") {
      if (!args[index + 1]) throw new Error("--record requires a path");
      recordPath = args[++index];
    } else if (!network && arg in NETWORKS) {
      network = arg as EscrowNetwork;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  return { network, recordPath };
}

export function deriveServiceIds(namespace: Hex): { operator: Hex; courier: Hex; exchange: Hex } {
  return {
    operator: keccak256(encodePacked(["string", "bytes32"], ["blocknotice-redemption-demo-operator-v1", namespace])),
    courier: keccak256(encodePacked(["string", "bytes32"], ["blocknotice-redemption-demo-courier-v1", namespace])),
    exchange: keccak256(encodePacked(["string", "bytes32"], ["blocknotice-redemption-demo-exchange-v1", namespace])),
  };
}

export function computeInboxProfileHash(args: {
  chainId: number;
  inbox: Address;
  log: Address;
  escrow: Address;
  forwardBlocks: number;
  responseBlocks: number;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "uint64" }, { type: "uint64" },
    ],
    [
      BigInt(args.chainId), args.inbox, args.log, args.escrow,
      BigInt(args.forwardBlocks), BigInt(args.responseBlocks),
    ],
  ));
}

export function computeServiceProfileHash(args: {
  chainId: number;
  log: Address;
  serviceId: Hex;
  role: ServiceRole;
  operator: Address;
  signer: Address;
  challengeResponseBlocks: number;
  requestRecordBlocks: number;
  decisionRecordBlocks: number;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "string" }, { type: "uint256" }, { type: "address" }, { type: "bytes32" },
      { type: "string" }, { type: "address" }, { type: "address" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
    ],
    [
      "BlockNotice Redemption Demo Service Profile v1", BigInt(args.chainId), args.log, args.serviceId,
      args.role, args.operator, args.signer, BigInt(args.challengeResponseBlocks),
      BigInt(args.requestRecordBlocks), BigInt(args.decisionRecordBlocks),
    ],
  ));
}

export function computeEscrowProfileHash(args: {
  chainId: number;
  escrow: Address;
  log: Address;
  token: Address;
  operatorServiceId: Hex;
  courierServiceId: Hex;
  decisionBlocks: number;
  handoffBlocks: number;
  courierBlocks: number;
  responseBlocks: number;
  disputeBlocks: number;
}): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "uint64" }, { type: "uint64" },
      { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
    ],
    [
      BigInt(args.chainId), args.escrow, args.log, args.token, args.operatorServiceId, args.courierServiceId,
      BigInt(args.decisionBlocks), BigInt(args.handoffBlocks), BigInt(args.courierBlocks),
      BigInt(args.responseBlocks), BigInt(args.disputeBlocks),
    ],
  ));
}

export function runtimeCodeHash(code: Hex | undefined): Hex {
  if (!code || code === "0x") throw new Error("expected deployed runtime code, found none");
  return keccak256(code);
}

export function readDeploymentFile(path: string): EscrowDeploymentFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must contain a JSON object`);
  return parsed as EscrowDeploymentFile;
}

export function writeDeploymentFile(path: string, value: EscrowDeploymentFile) {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flush: true });
  renameSync(temporary, absolute);
}

export function assertWritableRecordSlot(
  existing: Record<string, { status?: string } | undefined>,
  network: EscrowNetwork,
  recordPath: string,
) {
  const current = existing[network];
  if (current?.status === "complete") {
    throw new Error(
      `${recordPath} already contains a complete ${network} deployment; use --record PATH for an explicit fresh output file`,
    );
  }
}

export function rpcUrlFor(
  network: EscrowNetwork,
  override?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (override) return override;
  const configured = env[NETWORKS[network].rpcEnv];
  if (configured) return configured;
  if (network === "local") return DEFAULT_LOCAL_RPC_URL;
  throw new Error(`set ${NETWORKS[network].rpcEnv} in .env`);
}
