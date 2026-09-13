// Re-read the public deployment from chain and check it against deployments.json.
// Nothing here trusts the repo: every value is fetched from the RPC and compared.
// Usage: npm run check:deployment
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, http, formatEther, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { LOG_ABI } from "./chain.js";

function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const ok = (b: boolean) => (b ? "PASS" : "FAIL");
let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  if (!pass) failures++;
  console.log(`  [${ok(pass)}] ${label}: ${detail}`);
}

async function main() {
  loadEnv();
  if (!existsSync("deployments.json")) throw new Error("deployments.json missing — run `npm run deploy -- sepolia` first");
  const d = JSON.parse(readFileSync("deployments.json", "utf8"));
  const rpc = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
  const pub = createPublicClient({ chain: sepolia, transport: http(rpc) });

  console.log(`deployments.json says: ${d.contract} on chainId ${d.chainId}`);
  console.log(`re-reading from ${new URL(rpc).host}\n`);

  check("chainId", (await pub.getChainId()) === d.chainId, `${await pub.getChainId()} (expected ${d.chainId})`);

  const code = await pub.getBytecode({ address: d.contract as Address });
  check("contract deployed", !!code && code.length > 2, `${code ? (code.length - 2) / 2 : 0} bytes of runtime code`);

  const s: any = await pub.readContract({ address: d.contract as Address, abi: LOG_ABI, functionName: "getService", args: [d.serviceId as Hex] });
  check("service registered", s.exists === true, `exists=${s.exists}`);
  check("institution signer matches", s.signer.toLowerCase() === String(d.institutionSigner).toLowerCase(), s.signer);
  check("profile hash matches", s.profileHash.toLowerCase() === String(d.profileHash).toLowerCase(), s.profileHash);
  console.log(`  [info] log size ${s.size}, root ${s.root}`);

  const bal = await pub.getBalance({ address: s.operator as Address });
  console.log(`  [info] operator ${s.operator}, balance ${formatEther(bal)} ETH`);

  console.log(`\n${failures === 0 ? "OK — the chain agrees with deployments.json." : `${failures} check(s) FAILED.`}`);
  console.log(`explorer: ${d.explorer}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(String(e.message ?? e)); process.exit(1); });
