import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  zeroHash,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ESCROW_WINDOWS,
  INBOX_WINDOWS,
  LOG_DEPLOYMENT_ABI,
  LOG_DEPLOYMENT_BYTECODE,
  MOCK_GOLD_ABI,
  MOCK_GOLD_BYTECODE,
  NETWORKS,
  REDEMPTION_ESCROW_ABI,
  REDEMPTION_ESCROW_BYTECODE,
  REDEMPTION_INBOX_ABI,
  REDEMPTION_INBOX_BYTECODE,
  SERVICE_REGISTRATION_WINDOWS,
  assertWritableRecordSlot,
  computeEscrowProfileHash,
  computeInboxProfileHash,
  computeServiceProfileHash,
  deriveServiceIds,
  loadEnvFile,
  parseDeployArgs,
  readDeploymentFile,
  rpcUrlFor,
  runtimeCodeHash,
  writeDeploymentFile,
  type CompleteEscrowDeploymentRecord,
  type EscrowDeploymentFile,
  type EscrowDeploymentRecord,
  type EscrowNetwork,
  type JournalTransaction,
  type ServiceDeploymentRecord,
} from "./escrow-deployment.js";

export interface DeployEscrowOptions {
  network: EscrowNetwork;
  recordPath?: string;
  rpcUrl?: string;
  deployerKey?: Hex;
  publicDeploymentsPath?: string;
  quiet?: boolean;
}

type Effect = "log" | "token" | "registerOperator" | "registerCourier" | "registerExchange" | "escrow" | "inbox";

export const DEFAULT_LOCAL_DEPLOYER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

export function selectDeployerKey(
  network: EscrowNetwork,
  actualChainId: number,
  env: Record<string, string | undefined> = process.env,
): Hex {
  const configured = env.DEPLOYER_KEY;
  if (configured) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(configured)) throw new Error("DEPLOYER_KEY must be a 32-byte 0x-prefixed hex value");
    return configured as Hex;
  }
  if (network === "local") {
    if (actualChainId !== 31337) throw new Error("refusing to use the development key before observing local chain ID 31337");
    return DEFAULT_LOCAL_DEPLOYER_KEY;
  }
  throw new Error("set DEPLOYER_KEY in .env for a public deployment");
}

function publicLogRecord(network: "hoodi" | "sepolia", path: string): { address: Address; deploymentBlock?: number } {
  if (!existsSync(path)) throw new Error(`${path} missing; public escrow deployment reuses its recorded BlockNoticeLog`);
  const all = JSON.parse(readFileSync(path, "utf8"));
  const entry = all.network ? all : all[network];
  if (!entry || entry.network !== network || !entry.contract) throw new Error(`${path} has no ${network} BlockNoticeLog deployment`);
  if (Number(entry.chainId) !== NETWORKS[network].chain.id) throw new Error(`${path} ${network} chain ID does not match ${NETWORKS[network].chain.id}`);
  return { address: entry.contract as Address, deploymentBlock: entry.deployTxBlock === undefined ? undefined : Number(entry.deployTxBlock) };
}

function serviceRecord(
  role: "operator" | "courier" | "exchange",
  serviceId: Hex,
  deployer: Address,
  profileHash: Hex = zeroHash,
): ServiceDeploymentRecord {
  return { role, serviceId, operator: deployer, signer: deployer, profileHash, ...SERVICE_REGISTRATION_WINDOWS };
}

function failExistingTransaction(effect: Effect, transaction: JournalTransaction): never {
  if (transaction.status === "pending") {
    throw new Error(`${effect} is pending without a recorded transaction hash; refusing an ambiguous redeploy; use --record PATH after investigating the account nonce`);
  }
  throw new Error(`${effect} previously failed (${transaction.error ?? "unknown error"}); use --record PATH for a fresh deployment`);
}

export async function deployEscrow(options: DeployEscrowOptions): Promise<CompleteEscrowDeploymentRecord> {
  loadEnvFile();
  const network = options.network;
  const config = NETWORKS[network];
  const recordPath = options.recordPath ?? "escrow-deployments.json";
  const rpcUrl = rpcUrlFor(network, options.rpcUrl);

  // Establish chain identity with a read-only client before a private key is selected or a wallet exists.
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const actualChainId = await pub.getChainId();
  if (actualChainId !== config.chain.id) {
    throw new Error(`RPC chain ID ${actualChainId} does not match explicit ${network} chain ID ${config.chain.id}; no signer was created`);
  }
  const key = options.deployerKey ?? selectDeployerKey(network, actualChainId);
  const account = privateKeyToAccount(key);
  const chain = network === "local" ? { ...config.chain, rpcUrls: { default: { http: [rpcUrl] } } } : config.chain;
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const balance = await pub.getBalance({ address: account.address });
  if (balance === 0n) throw new Error(`deployer ${account.address} has no native currency for gas`);

  const file = readDeploymentFile(recordPath);
  assertWritableRecordSlot(file as Record<string, { status?: string } | undefined>, network, recordPath);
  let record = file[network];
  if (record) {
    if (record.format !== "blocknotice-escrow-deployment-v1" || record.chainId !== actualChainId) {
      throw new Error(`${recordPath} contains an incompatible ${network} partial deployment`);
    }
    if (record.deployer.toLowerCase() !== account.address.toLowerCase()) {
      throw new Error(`${recordPath} partial deployment belongs to ${record.deployer}, not ${account.address}`);
    }
    if (!record.services?.exchange || !record.inboxProfile) {
      throw new Error(`${recordPath} contains a pre-inbox partial deployment; use --record PATH for a fresh complete deployment`);
    }
  } else {
    const namespace = `0x${randomBytes(32).toString("hex")}` as Hex;
    const serviceIds = deriveServiceIds(namespace);
    record = {
      format: "blocknotice-escrow-deployment-v1",
      status: "in-progress",
      network,
      chainId: actualChainId,
      rpcEnvironmentVariable: config.rpcEnv,
      deployer: account.address,
      namespace,
      createdAt: new Date().toISOString(),
      demoMode: {
        token: "MockGold",
        permissionlessMinting: true,
        warning: "DEMO ONLY: MockGold has permissionless minting and is not gold-backed.",
      },
      services: {
        commonControl: true,
        controlDisclosure: "Demo operator, courier, and exchange roles are distinct service IDs under the same deployer-controlled account.",
        operator: serviceRecord("operator", serviceIds.operator, account.address),
        courier: serviceRecord("courier", serviceIds.courier, account.address),
        exchange: serviceRecord("exchange", serviceIds.exchange, account.address),
      },
      profile: { ...ESCROW_WINDOWS },
      inboxProfile: { ...INBOX_WINDOWS },
      contracts: {},
      transactions: {},
      explorer: config.explorer ? {} : undefined,
    };
    file[network] = record;
    writeDeploymentFile(recordPath, file);
  }

  const save = () => {
    file[network] = record;
    writeDeploymentFile(recordPath, file);
  };

  async function transact(
    effect: Effect,
    send: () => Promise<Hash>,
    confirm: (receipt: TransactionReceipt) => Promise<void>,
  ) {
    let transaction = record!.transactions[effect];
    let hash: Hash;
    if (!transaction) {
      transaction = { status: "pending" };
      record!.transactions[effect] = transaction;
      save();
      try {
        hash = await send();
      } catch (error) {
        transaction.status = "failed";
        transaction.error = String((error as Error).message ?? error);
        save();
        throw error;
      }
      transaction.status = "submitted";
      transaction.transactionHash = hash;
      save();
    } else if (transaction.status === "submitted" && transaction.transactionHash) {
      hash = transaction.transactionHash;
    } else if (transaction.status === "confirmed") {
      return;
    } else {
      failExistingTransaction(effect, transaction);
    }

    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      transaction.status = "failed";
      transaction.error = `transaction ${hash} reverted`;
      save();
      throw new Error(transaction.error);
    }
    await confirm(receipt);
    transaction.status = "confirmed";
    transaction.blockNumber = Number(receipt.blockNumber);
    transaction.contractAddress = receipt.contractAddress ?? undefined;
    save();
  }

  if (network === "local") {
    await transact(
      "log",
      () => wallet.deployContract({ abi: LOG_DEPLOYMENT_ABI, bytecode: LOG_DEPLOYMENT_BYTECODE, account, chain, args: [] }),
      async receipt => {
        if (!receipt.contractAddress) throw new Error("BlockNoticeLog deployment receipt has no contract address");
        const code = await pub.getBytecode({ address: receipt.contractAddress });
        record!.contracts.log = {
          address: receipt.contractAddress,
          runtimeCodeHash: runtimeCodeHash(code),
          deploymentBlock: Number(receipt.blockNumber),
          transactionHash: receipt.transactionHash,
          source: "deployed-by-this-run",
        };
      },
    );
  } else if (!record.contracts.log) {
    const existing = publicLogRecord(network, options.publicDeploymentsPath ?? "deployments.json");
    const code = await pub.getBytecode({ address: existing.address });
    record.contracts.log = {
      address: existing.address,
      runtimeCodeHash: runtimeCodeHash(code),
      deploymentBlock: existing.deploymentBlock,
      source: "existing-public-deployment",
    };
    if (config.explorer) record.explorer = { ...record.explorer, log: `${config.explorer}/address/${existing.address}` };
    save();
  }

  const log = record.contracts.log?.address;
  if (!log) throw new Error("deployment journal has no BlockNoticeLog address");
  const logAddress: Address = log;
  for (const role of ["operator", "courier", "exchange"] as const) {
    const service = record.services[role];
    const intendedHash = computeServiceProfileHash({ chainId: actualChainId, log, ...service });
    if (service.profileHash !== intendedHash) service.profileHash = intendedHash;
  }
  save();

  await transact(
    "token",
    () => wallet.deployContract({ abi: MOCK_GOLD_ABI, bytecode: MOCK_GOLD_BYTECODE, account, chain, args: [] }),
    async receipt => {
      if (!receipt.contractAddress) throw new Error("MockGold deployment receipt has no contract address");
      const code = await pub.getBytecode({ address: receipt.contractAddress });
      record!.contracts.token = {
        address: receipt.contractAddress,
        runtimeCodeHash: runtimeCodeHash(code),
        deploymentBlock: Number(receipt.blockNumber),
        transactionHash: receipt.transactionHash,
        source: "deployed-by-this-run",
      };
      if (config.explorer) record!.explorer = { ...record!.explorer, token: `${config.explorer}/address/${receipt.contractAddress}` };
    },
  );

  async function register(role: "operator" | "courier" | "exchange") {
    const service = record!.services[role];
    const effect = role === "operator" ? "registerOperator" : role === "courier" ? "registerCourier" : "registerExchange";
    await transact(
      effect,
      async () => {
        const { request } = await pub.simulateContract({
          address: logAddress,
          abi: LOG_DEPLOYMENT_ABI,
          functionName: "registerService",
          args: [
            service.serviceId,
            service.signer,
            service.profileHash,
            BigInt(service.challengeResponseBlocks),
            BigInt(service.requestRecordBlocks),
            BigInt(service.decisionRecordBlocks),
          ],
          account,
        });
        return wallet.writeContract(request as any);
      },
      async () => {},
    );
  }
  await register("operator");
  await register("courier");
  await register("exchange");

  const token = record.contracts.token?.address;
  if (!token) throw new Error("deployment journal has no MockGold address");
  const operatorServiceId = record.services.operator.serviceId;
  const courierServiceId = record.services.courier.serviceId;
  await transact(
    "escrow",
    () => wallet.deployContract({
      abi: REDEMPTION_ESCROW_ABI,
      bytecode: REDEMPTION_ESCROW_BYTECODE,
      account,
      chain,
      args: [
        log, token, operatorServiceId, courierServiceId,
        BigInt(ESCROW_WINDOWS.decisionBlocks), BigInt(ESCROW_WINDOWS.handoffBlocks),
        BigInt(ESCROW_WINDOWS.courierBlocks), BigInt(ESCROW_WINDOWS.responseBlocks),
        BigInt(ESCROW_WINDOWS.disputeBlocks),
      ],
    }),
    async receipt => {
      if (!receipt.contractAddress) throw new Error("RedemptionEscrow deployment receipt has no contract address");
      const code = await pub.getBytecode({ address: receipt.contractAddress });
      record!.contracts.escrow = {
        address: receipt.contractAddress,
        runtimeCodeHash: runtimeCodeHash(code),
        deploymentBlock: Number(receipt.blockNumber),
        transactionHash: receipt.transactionHash,
        source: "deployed-by-this-run",
      };
      record!.profile.profileHash = computeEscrowProfileHash({
        chainId: actualChainId,
        escrow: receipt.contractAddress,
        log,
        token,
        operatorServiceId,
        courierServiceId,
        ...ESCROW_WINDOWS,
      });
      if (config.explorer) record!.explorer = { ...record!.explorer, escrow: `${config.explorer}/address/${receipt.contractAddress}` };
    },
  );

  const escrow = record.contracts.escrow?.address;
  if (!escrow) throw new Error("deployment journal has no RedemptionEscrow address");
  await transact(
    "inbox",
    () => wallet.deployContract({
      abi: REDEMPTION_INBOX_ABI,
      bytecode: REDEMPTION_INBOX_BYTECODE,
      account,
      chain,
      args: [log, escrow, BigInt(INBOX_WINDOWS.forwardBlocks), BigInt(INBOX_WINDOWS.responseBlocks)],
    }),
    async receipt => {
      if (!receipt.contractAddress) throw new Error("RedemptionInbox deployment receipt has no contract address");
      const code = await pub.getBytecode({ address: receipt.contractAddress });
      record!.contracts.inbox = {
        address: receipt.contractAddress,
        runtimeCodeHash: runtimeCodeHash(code),
        deploymentBlock: Number(receipt.blockNumber),
        transactionHash: receipt.transactionHash,
        source: "deployed-by-this-run",
      };
      record!.inboxProfile.profileHash = computeInboxProfileHash({
        chainId: actualChainId,
        inbox: receipt.contractAddress,
        log,
        escrow,
        ...INBOX_WINDOWS,
      });
      if (config.explorer) record!.explorer = { ...record!.explorer, inbox: `${config.explorer}/address/${receipt.contractAddress}` };
    },
  );

  if (!record.contracts.log || !record.contracts.token || !record.contracts.escrow || !record.contracts.inbox
    || !record.profile.profileHash || !record.inboxProfile.profileHash) {
    throw new Error("deployment journal is incomplete after all transactions confirmed");
  }
  record.status = "complete";
  record.completedAt = new Date().toISOString();
  save();

  if (!options.quiet) {
    console.log(`Escrow deployment complete on ${network} (chain ID ${actualChainId})`);
    console.log(`deployer ${account.address}, remaining balance ${formatEther(await pub.getBalance({ address: account.address }))}`);
    console.log(`log ${record.contracts.log.address}`);
    console.log(`MockGold ${record.contracts.token.address} — DEMO ONLY, permissionless minting`);
    console.log(`escrow ${record.contracts.escrow.address}`);
    console.log(`inbox ${record.contracts.inbox.address}`);
    console.log(`operator service ${record.services.operator.serviceId}`);
    console.log(`courier service ${record.services.courier.serviceId}`);
    console.log(`exchange service ${record.services.exchange.serviceId}`);
    console.log(`common control: all three demo roles use ${account.address}`);
    console.log(`wrote ${recordPath}`);
  }
  return record as CompleteEscrowDeploymentRecord;
}

async function main() {
  const args = parseDeployArgs(process.argv.slice(2));
  await deployEscrow(args);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(String(error?.message ?? error));
    process.exitCode = 1;
  });
}
