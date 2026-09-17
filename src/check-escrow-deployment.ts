import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  encodePacked,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import {
  ESCROW_WINDOWS,
  INBOX_WINDOWS,
  LOG_DEPLOYMENT_ABI,
  MOCK_GOLD_ABI,
  NETWORKS,
  REDEMPTION_ESCROW_ABI,
  REDEMPTION_INBOX_ABI,
  computeEscrowProfileHash,
  computeInboxProfileHash,
  computeServiceProfileHash,
  deriveServiceIds,
  loadEnvFile,
  parseCheckArgs,
  readDeploymentFile,
  rpcUrlFor,
  runtimeCodeHash,
  type EscrowDeploymentRecord,
  type EscrowNetwork,
} from "./escrow-deployment.js";

export interface CheckEscrowOptions {
  network?: EscrowNetwork;
  recordPath?: string;
  rpcUrl?: string;
  publicDeploymentsPath?: string;
  quiet?: boolean;
}

export interface DeploymentCheckFailure {
  network: EscrowNetwork;
  label: string;
  expected: unknown;
  actual: unknown;
}

export interface DeploymentCheckResult {
  checked: number;
  failures: DeploymentCheckFailure[];
}

const comparable = (value: unknown) => typeof value === "string" ? value.toLowerCase() : typeof value === "bigint" ? value.toString() : value;

export async function checkEscrowDeployments(options: CheckEscrowOptions = {}): Promise<DeploymentCheckResult> {
  loadEnvFile();
  const recordPath = options.recordPath ?? "escrow-deployments.json";
  const file = readDeploymentFile(recordPath);
  const networks = options.network ? [options.network] : (Object.keys(file) as EscrowNetwork[]);
  if (networks.length === 0) throw new Error(`${recordPath} has no escrow deployments to check`);

  const result: DeploymentCheckResult = { checked: 0, failures: [] };
  for (const network of networks) {
    const record = file[network];
    if (!record) throw new Error(`${recordPath} has no ${network} escrow deployment`);
    await checkOne(network, record, options, result);
  }
  return result;
}

async function checkOne(
  network: EscrowNetwork,
  record: EscrowDeploymentRecord,
  options: CheckEscrowOptions,
  result: DeploymentCheckResult,
) {
  const print = (line: string) => { if (!options.quiet) console.log(line); };
  const check = (label: string, actual: unknown, expected: unknown) => {
    result.checked++;
    const pass = comparable(actual) === comparable(expected);
    print(`  [${pass ? "PASS" : "FAIL"}] ${label}: ${String(actual)}${pass ? "" : ` (expected ${String(expected)})`}`);
    if (!pass) result.failures.push({ network, label, expected, actual });
  };
  const config = NETWORKS[network];
  const rpc = rpcUrlFor(network, options.rpcUrl);
  const pub = createPublicClient({ transport: http(rpc) });
  print(`\n=== ${network} escrow deployment ===`);

  const actualChainId = await pub.getChainId();
  check("record status", record.status, "complete");
  check("network", record.network, network);
  check("configured chain ID", record.chainId, config.chain.id);
  check("RPC chain ID", actualChainId, record.chainId);
  check("demo token", record.demoMode?.token, "MockGold");
  check("permissionless demo minting disclosure", record.demoMode?.permissionlessMinting, true);
  check("common-control disclosure", record.services?.commonControl, true);
  check("operator intended owner is deployer", record.services.operator.operator, record.deployer);
  check("operator intended signer is deployer", record.services.operator.signer, record.deployer);
  check("courier intended owner is deployer", record.services.courier.operator, record.deployer);
  check("courier intended signer is deployer", record.services.courier.signer, record.deployer);
  check("exchange intended owner is deployer", record.services.exchange.operator, record.deployer);
  check("exchange intended signer is deployer", record.services.exchange.signer, record.deployer);

  const expectedIds = deriveServiceIds(record.namespace);
  check("operator service ID derivation", record.services.operator.serviceId, expectedIds.operator);
  check("courier service ID derivation", record.services.courier.serviceId, expectedIds.courier);
  check("exchange service ID derivation", record.services.exchange.serviceId, expectedIds.exchange);
  check("service IDs differ", record.services.operator.serviceId !== record.services.courier.serviceId, true);
  check("exchange service differs from operator", record.services.exchange.serviceId !== record.services.operator.serviceId, true);
  check("exchange service differs from courier", record.services.exchange.serviceId !== record.services.courier.serviceId, true);

  for (const [name, expected] of Object.entries(ESCROW_WINDOWS)) {
    check(`fixed ${name}`, record.profile[name as keyof typeof ESCROW_WINDOWS], expected);
  }
  for (const [name, expected] of Object.entries(INBOX_WINDOWS)) {
    check(`fixed inbox ${name}`, record.inboxProfile[name as keyof typeof INBOX_WINDOWS], expected);
  }

  const log = record.contracts.log;
  const token = record.contracts.token;
  const escrow = record.contracts.escrow;
  const inbox = record.contracts.inbox;
  if (!log || !token || !escrow || !inbox) {
    check("all contract records present", false, true);
    return;
  }

  if (network !== "local") {
    check("public log source", log.source, "existing-public-deployment");
    const publicPath = options.publicDeploymentsPath ?? "deployments.json";
    if (!existsSync(publicPath)) {
      check("public deployment source file exists", false, true);
    } else {
      const publicFile = JSON.parse(readFileSync(publicPath, "utf8"));
      const publicRecord = publicFile.network ? publicFile : publicFile[network];
      check("public log matches deployments.json", log.address, publicRecord?.contract);
    }
  } else {
    check("local log source", log.source, "deployed-by-this-run");
  }
  check("token deployment source", token.source, "deployed-by-this-run");
  check("escrow deployment source", escrow.source, "deployed-by-this-run");
  check("inbox deployment source", inbox.source, "deployed-by-this-run");

  for (const [label, contract] of [["log", log], ["token", token], ["escrow", escrow], ["inbox", inbox]] as const) {
    const code = await pub.getBytecode({ address: contract.address });
    check(`${label} has runtime code`, Boolean(code && code !== "0x"), true);
    if (code && code !== "0x") check(`${label} runtime code hash`, runtimeCodeHash(code), contract.runtimeCodeHash);
  }

  const requiredTransactions = network === "local"
    ? ["log", "token", "registerOperator", "registerCourier", "registerExchange", "escrow", "inbox"] as const
    : ["token", "registerOperator", "registerCourier", "registerExchange", "escrow", "inbox"] as const;
  for (const effect of requiredTransactions) {
    const transaction = record.transactions[effect];
    check(`${effect} transaction recorded`, Boolean(transaction?.transactionHash), true);
    check(`${effect} transaction journal status`, transaction?.status, "confirmed");
    if (!transaction?.transactionHash) continue;
    try {
      const receipt = await pub.getTransactionReceipt({ hash: transaction.transactionHash });
      check(`${effect} transaction receipt status`, receipt.status, "success");
      check(`${effect} transaction block`, Number(receipt.blockNumber), transaction.blockNumber);
      const expectedAddress = effect === "log" ? log.address : effect === "token" ? token.address
        : effect === "escrow" ? escrow.address : effect === "inbox" ? inbox.address : undefined;
      if (expectedAddress) check(`${effect} receipt contract address`, receipt.contractAddress, expectedAddress);
    } catch (error) {
      check(`${effect} transaction receipt readable`, String((error as Error).message ?? error), "receipt available");
    }
  }
  if (network === "local") check("log deployment block", log.deploymentBlock, record.transactions.log?.blockNumber);
  check("token deployment block", token.deploymentBlock, record.transactions.token?.blockNumber);
  check("escrow deployment block", escrow.deploymentBlock, record.transactions.escrow?.blockNumber);
  check("inbox deployment block", inbox.deploymentBlock, record.transactions.inbox?.blockNumber);
  check("token deployment transaction", token.transactionHash, record.transactions.token?.transactionHash);
  check("escrow deployment transaction", escrow.transactionHash, record.transactions.escrow?.transactionHash);
  check("inbox deployment transaction", inbox.transactionHash, record.transactions.inbox?.transactionHash);

  for (const role of ["operator", "courier", "exchange"] as const) {
    const intended = record.services[role];
    const recomputedProfile = computeServiceProfileHash({ chainId: record.chainId, log: log.address, ...intended });
    check(`${role} registration profile recomputes`, intended.profileHash, recomputedProfile);
    const service: any = await pub.readContract({
      address: log.address,
      abi: LOG_DEPLOYMENT_ABI,
      functionName: "getService",
      args: [intended.serviceId],
    });
    check(`${role} service registered`, service.exists, true);
    check(`${role} service owner`, service.operator, intended.operator);
    check(`${role} service signer`, service.signer, intended.signer);
    check(`${role} service profile hash`, service.profileHash, intended.profileHash);
    check(`${role} challenge response blocks`, Number(service.challengeResponseBlocks), intended.challengeResponseBlocks);
    check(`${role} request record blocks`, Number(service.requestRecordBlocks), intended.requestRecordBlocks);
    check(`${role} decision record blocks`, Number(service.decisionRecordBlocks), intended.decisionRecordBlocks);
    check(`${role} tree ID`, service.treeId, keccak256(encodePacked(["bytes32"], [intended.serviceId])));
  }

  const immutableReads = await Promise.all([
    "log", "token", "operatorServiceId", "courierServiceId", "decisionBlocks", "handoffBlocks",
    "courierBlocks", "responseBlocks", "disputeBlocks", "profileHash",
  ].map(functionName => pub.readContract({
    address: escrow.address,
    abi: REDEMPTION_ESCROW_ABI,
    functionName,
  })));
  const [chainLog, chainToken, chainOperator, chainCourier, decision, handoff, courier, response, dispute, chainProfileHash] = immutableReads as any[];
  check("escrow immutable log", chainLog, log.address);
  check("escrow immutable token", chainToken, token.address);
  check("escrow immutable operator service", chainOperator, record.services.operator.serviceId);
  check("escrow immutable courier service", chainCourier, record.services.courier.serviceId);
  check("escrow immutable decision blocks", Number(decision), record.profile.decisionBlocks);
  check("escrow immutable handoff blocks", Number(handoff), record.profile.handoffBlocks);
  check("escrow immutable courier blocks", Number(courier), record.profile.courierBlocks);
  check("escrow immutable response blocks", Number(response), record.profile.responseBlocks);
  check("escrow immutable dispute blocks", Number(dispute), record.profile.disputeBlocks);

  const recomputedEscrowProfile = computeEscrowProfileHash({
    chainId: record.chainId,
    escrow: escrow.address,
    log: log.address,
    token: token.address,
    operatorServiceId: record.services.operator.serviceId,
    courierServiceId: record.services.courier.serviceId,
    decisionBlocks: record.profile.decisionBlocks,
    handoffBlocks: record.profile.handoffBlocks,
    courierBlocks: record.profile.courierBlocks,
    responseBlocks: record.profile.responseBlocks,
    disputeBlocks: record.profile.disputeBlocks,
  });
  check("stored escrow profile hash recomputes", record.profile.profileHash, recomputedEscrowProfile);
  check("on-chain escrow profile hash", chainProfileHash, recomputedEscrowProfile);

  const inboxReads = await Promise.all([
    "log", "escrow", "token", "forwardBlocks", "responseBlocks", "profileHash",
  ].map(functionName => pub.readContract({
    address: inbox.address,
    abi: REDEMPTION_INBOX_ABI,
    functionName,
  })));
  const [inboxLog, inboxEscrow, inboxToken, forwardBlocks, inboxResponseBlocks, chainInboxProfileHash] = inboxReads as any[];
  check("inbox immutable log", inboxLog, log.address);
  check("inbox immutable escrow", inboxEscrow, escrow.address);
  check("inbox immutable token", inboxToken, token.address);
  check("inbox immutable forward blocks", Number(forwardBlocks), record.inboxProfile.forwardBlocks);
  check("inbox immutable response blocks", Number(inboxResponseBlocks), record.inboxProfile.responseBlocks);
  const recomputedInboxProfile = computeInboxProfileHash({
    chainId: record.chainId,
    inbox: inbox.address,
    log: log.address,
    escrow: escrow.address,
    forwardBlocks: record.inboxProfile.forwardBlocks,
    responseBlocks: record.inboxProfile.responseBlocks,
  });
  check("stored inbox profile hash recomputes", record.inboxProfile.profileHash, recomputedInboxProfile);
  check("on-chain inbox profile hash", chainInboxProfileHash, recomputedInboxProfile);

  const [name, symbol, decimals] = await Promise.all([
    pub.readContract({ address: token.address, abi: MOCK_GOLD_ABI, functionName: "name" }),
    pub.readContract({ address: token.address, abi: MOCK_GOLD_ABI, functionName: "symbol" }),
    pub.readContract({ address: token.address, abi: MOCK_GOLD_ABI, functionName: "decimals" }),
  ]);
  check("demo token name", name, "Demo Gold");
  check("demo token symbol", symbol, "mGOLD");
  check("demo token decimals", Number(decimals), 18);

  print(result.failures.filter(failure => failure.network === network).length === 0
    ? "OK — chain state exactly matches the saved escrow deployment."
    : `${result.failures.filter(failure => failure.network === network).length} check(s) failed.`);
}

async function main() {
  const args = parseCheckArgs(process.argv.slice(2));
  const result = await checkEscrowDeployments(args);
  process.exitCode = result.failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
