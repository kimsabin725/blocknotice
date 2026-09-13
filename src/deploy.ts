// Deploy the public log to a real chain and write the deployment record the verifier reads.
// Usage: npm run deploy -- sepolia     (needs .env: SEPOLIA_RPC_URL, DEPLOYER_KEY)
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { defineChain, formatEther, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { connect, deployLog, registerService } from "./chain.js";
import { profileHash, institutionKeyId, bytes32FromString } from "./encode.js";
import { DEMO_PROFILE } from "./profile.js";
import type { ProtocolProfile } from "./types.js";

const NETWORKS = { sepolia: { chain: sepolia, rpcEnv: "SEPOLIA_RPC_URL", explorer: "https://sepolia.etherscan.io" } } as const;

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

async function main() {
  loadEnv();
  const name = (process.argv[2] ?? "sepolia") as keyof typeof NETWORKS;
  const net = NETWORKS[name];
  if (!net) throw new Error(`unknown network ${name}`);
  const rpc = process.env[net.rpcEnv];
  const key = process.env.DEPLOYER_KEY as Hex | undefined;
  if (!rpc) throw new Error(`set ${net.rpcEnv} in .env`);
  if (!key) throw new Error("set DEPLOYER_KEY in .env");

  const base = await connect(rpc, net.chain, key);
  const balance = await base.pub.getBalance({ address: base.account.address });
  console.log(`deployer ${base.account.address}  balance ${formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error(`deployer has no ETH — fund ${base.account.address} from a ${name} faucet first`);

  const address = await deployLog(base);
  console.log(`BlockNoticeLog deployed: ${address}`);
  console.log(`${net.explorer}/address/${address}`);

  // Register the demo service under the profile the receipts will be issued with.
  const institutionSigner = (process.env.INSTITUTION_ADDRESS as Hex | undefined) || base.account.address;
  const profile: ProtocolProfile = {
    ...DEMO_PROFILE, chainId: net.chain.id, verifyingContract: address,
    serviceId: bytes32FromString("demo-exchange"), institutionKeyId: institutionKeyId(institutionSigner as any),
  };
  const c = { ...base, address };
  const r = await registerService(c, profile.serviceId, institutionSigner as any, profileHash(profile), profile.challengeResponseBlocks);
  console.log(`service registered in ${r.transactionHash}`);

  const record = {
    network: name, chainId: net.chain.id, contract: address, deployTxBlock: Number(r.blockNumber),
    serviceId: profile.serviceId, institutionSigner, profileHash: profileHash(profile),
    explorer: `${net.explorer}/address/${address}`, deployedAt: new Date().toISOString(),
  };
  writeFileSync("deployments.json", JSON.stringify(record, null, 2) + "\n");
  console.log("wrote deployments.json");
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
