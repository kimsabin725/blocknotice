// Builds a single self-contained HTML file from what actually ran: the scenario results, a real
// verifier report, and the on-chain deployment record. No server, no build step, no placeholder
// animation — every number on the page came out of a run and is shown next to its raw JSON.
//
// Usage: npm run report      (run `npm run scenarios` first)
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { runCase } from "./scenario.js";
import { verifyBundle } from "./verify.js";
import { bigintReplacer } from "./institution.js";

const esc = (s: unknown) => String(s).replace(/[&<>]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[ch]!));
const json = (v: unknown) => esc(JSON.stringify(v, bigintReplacer, 2));

async function main() {
  if (!existsSync("out/scenarios.json")) throw new Error("run `npm run scenarios` first");
  const sc = JSON.parse(readFileSync("out/scenarios.json", "utf8"));
  const deployments = existsSync("deployments.json") ? JSON.parse(readFileSync("deployments.json", "utf8")) : {};

  // Area 1+2: a real receipt bundle straight from the institution simulator.
  const { bundle } = await runCase({ inputs: "screening" });
  // Area 3: the independent verdict on it, with no registration supplied — so the page shows what
  // an outsider concludes from the file alone, honestly labelled.
  const report = await verifyBundle(bundle, {});

  const badge = (ok: boolean) => `<span class="b ${ok ? "ok" : "no"}">${ok ? "PASS" : "FAIL"}</span>`;
  const rows = sc.scenarios.map((r: any) => `
    <tr class="${r.ok ? "" : "bad"}">
      <td>${badge(r.ok)}</td>
      <td><span class="k ${r.kind}">${esc(r.kind)}</span></td>
      <td><code>${esc(r.id)}</code><div class="claim">${esc(r.claim)}</div></td>
      <td class="note">${esc(r.note)}</td>
    </tr>`).join("");

  const deployRows = Object.values(deployments).map((d: any) => `
    <tr><td><b>${esc(d.network)}</b> <span class="dim">(${esc(d.chainId)})</span></td>
        <td><code>${esc(d.contract)}</code></td>
        <td><a href="${esc(d.explorer)}">explorer</a></td></tr>`).join("");

  const checkRows = report.checks.map(c => `
    <tr><td><span class="s ${c.status}">${esc(c.status)}</span></td>
        <td><code>${esc(c.id)}</code></td><td class="note">${esc(c.detail)}</td></tr>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><title>BlockNotice — verification report</title>
<style>
 :root{--bg:#fbfbfa;--fg:#1a1a1a;--dim:#6b6b6b;--line:#e3e3e0;--ok:#16794a;--no:#b3261e;--warn:#8a6100}
 @media(prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8e6;--dim:#9a9a97;--line:#2e2e33;--ok:#5bc48c;--no:#ff7a6e;--warn:#e0b050}}
 *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
 .wrap{max-width:1080px;margin:0 auto;padding:32px 20px 80px}
 h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:36px 0 10px;letter-spacing:.02em;text-transform:uppercase;color:var(--dim)}
 .sub{color:var(--dim);margin:0 0 24px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:18px 0}
 .card{border:1px solid var(--line);border-radius:8px;padding:12px 14px}
 .card .n{font-size:26px;font-weight:650;line-height:1.1}.card .l{color:var(--dim);font-size:12px;margin-top:2px}
 table{width:100%;border-collapse:collapse;font-size:13px}
 td,th{border-bottom:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
 code{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
 .b{font:11px/1 ui-monospace,monospace;padding:4px 7px;border-radius:4px;font-weight:700}
 .b.ok{background:color-mix(in srgb,var(--ok) 16%,transparent);color:var(--ok)}
 .b.no{background:color-mix(in srgb,var(--no) 16%,transparent);color:var(--no)}
 .k{font-size:11px;color:var(--dim)}.k.attack{color:var(--no)}.k.honest{color:var(--ok)}
 .claim{color:var(--dim);font-size:12px;margin-top:3px;max-width:46ch}
 .note{color:var(--dim);font-size:12px}
 tr.bad{background:color-mix(in srgb,var(--no) 7%,transparent)}
 .s{font:11px/1 ui-monospace,monospace;padding:3px 6px;border-radius:4px}
 .s.CONFIRMED{color:var(--ok)}.s.OBLIGATION_UNMET{color:var(--no)}
 .s.UNVERIFIABLE,.s.NOT_DUE,.s.OUT_OF_SCOPE{color:var(--warn)}
 pre{background:color-mix(in srgb,var(--fg) 5%,transparent);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;max-height:380px;font-size:11.5px}
 details{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-top:8px}
 summary{cursor:pointer;color:var(--dim);font-size:12.5px}
 .dim{color:var(--dim)}a{color:inherit}
 .warn{border-left:3px solid var(--warn);padding:8px 12px;background:color-mix(in srgb,var(--warn) 8%,transparent);border-radius:0 6px 6px 0;font-size:13px;margin:10px 0}
</style>
<div class="wrap">
<h1>BlockNotice — verification report</h1>
<p class="sub">Generated ${esc(sc.generatedAt)} · log contract <code>${esc(sc.logContract)}</code> on <code>${esc(sc.rpc)}</code></p>

<div class="cards">
  <div class="card"><div class="n">${sc.totals.attacksCaught}/${sc.totals.attacks}</div><div class="l">attacks caught</div></div>
  <div class="card"><div class="n">${sc.totals.falsePositives}</div><div class="l">false positives</div></div>
  <div class="card"><div class="n">${sc.totals.scenes}</div><div class="l">scenes replayed</div></div>
  <div class="card"><div class="n">${report.institutionNetworkCalls}</div><div class="l">institution calls (measured)</div></div>
</div>

<div class="warn"><b>Local chain, accelerated blocks.</b> Deadline-expiry scenes advance blocks on a local
chain so a window that takes hours passes in seconds. The public testnet deployments below carry only
what really happened. The two are never presented as the same evidence.</div>

<h2>③ Independent verdict — every scene</h2>
<table><tr><th></th><th>kind</th><th>scenario / claim stated before the run</th><th>result</th></tr>${rows}</table>

<h2>① A requester's receipt bundle</h2>
<p class="sub">Straight from the institution simulator — this is the file a requester keeps.</p>
<details open><summary>bundle (raw)</summary><pre>${json(bundle)}</pre></details>

<h2>② Verifier output on that bundle</h2>
<p class="sub">No on-chain registration was supplied here, so the trust anchor is reported as
UNVERIFIABLE rather than silently assumed. That is the honest reading of a file on its own.</p>
<table><tr><th>status</th><th>check</th><th>detail</th></tr>${checkRows}</table>
<details><summary>report (raw JSON)</summary><pre>${json(report)}</pre></details>

<h2>Public testnet deployments</h2>
<table>${deployRows || "<tr><td class=dim>none recorded</td></tr>"}</table>
<details><summary>deployments.json (raw)</summary><pre>${json(deployments)}</pre></details>
</div>`;

  mkdirSync("out", { recursive: true });
  writeFileSync("out/report.html", html);
  console.log(`wrote out/report.html  (${(html.length / 1024).toFixed(0)} KB, open it directly — no server needed)`);
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
