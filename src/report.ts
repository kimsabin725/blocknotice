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

/** Korean reading of each scene. The English `claim` in scenarios.ts stays the technical source of
 *  truth; this is what a reader who did not write the code needs in order to judge the result. */
const KO: Record<string, { title: string; story: string; why: string }> = {
  "honest.recorded": {
    title: "정상 처리",
    story: "기관이 제때 서명하고 제때 기록했다.",
    why: "정상은 정상으로 나와야 한다. 여기서 틀리면 나머지가 무의미하다.",
  },
  "honest.notYetDue": {
    title: "아직 기한 전",
    story: "접수는 됐지만 결정 기한이 아직 안 지났다.",
    why: "「아직 안 함」을 「위반」으로 찍지 않는다. 오탐 방지의 핵심.",
  },
  "honest.noAck": {
    title: "이용자가 확인 안 함",
    story: "기관은 다 했는데 이용자가 수신 확인(ACK)을 안 보냈다.",
    why: "이용자가 조용한 게 기관 잘못이 되면 안 된다.",
  },
  "honest.ackBound": {
    title: "확인이 결정에 묶임",
    story: "이용자가 보낸 ACK가 실제로 그 결정에 대한 것인지 본다.",
    why: "아무 ACK나 갖다 붙여 「통지했다」고 우기지 못하게.",
  },
  "attack.omitRequestLeaf": {
    title: "접수 기록 누락",
    story: "기관이 접수 영수증에 서명해놓고 공개 로그에는 안 올렸다.",
    why: "이용자가 가진 영수증 하나로 잡힌다. 기관 서버가 필요 없다.",
  },
  "attack.omitDecisionLeaf": {
    title: "결정 기록 누락",
    story: "결정에 서명은 했는데 공개 로그에 안 올렸다.",
    why: "서명만으로 「기록했다」가 성립하지 않는다.",
  },
  "attack.tamperedNotice": {
    title: "사후 내용 조작",
    story: "나중에 통지문을 「승인했다」로 바꿔치기했다.",
    why: "이용자가 쥔 서명과 안 맞는다. 말 바꾸기가 탐지된다.",
  },
  "attack.foreignRootProof": {
    title: "가짜 루트로 증명",
    story: "이 체인이 공표한 적 없는 루트를 근거로 증명서를 냈다.",
    why: "증명서 자체의 산수가 맞아도 안 통한다. 공개된 로그와 대조한다.",
  },
  "attack.forgedDomain": {
    title: "통째로 위조한 묶음",
    story: "공격자가 자기 도메인·자기 키로 전부 만들어낸 가짜를 진짜처럼 낸다.",
    why: "「범위 밖」으로 나온다 — 위반 주장이 아니라 「이건 그 기관 얘기가 아니다」.",
  },
  "attack.noRegistration": {
    title: "등록 정보 없이 검증",
    story: "체인에 등록된 기준점 없이 파일만 들고 왔다.",
    why: "「검증 불가」라고 말한다. 모르는 걸 확인했다고 하지 않는다.",
  },
  "attack.silentInstitution": {
    title: "기관이 무응답",
    story: "이용자가 증빙을 요구했는데 기관이 기한까지 아무 답이 없다.",
    why: "체인에 UNANSWERED로 영구히 남는다. 이 구조의 유일한 「위반 증거」.",
  },
  "attack.lateRecordingStillFlagged": {
    title: "뒤늦게 기록해 은폐",
    story: "챌린지를 받고 나서야 부랴부랴 기록하고 응답했다.",
    why: "응답은 인정되지만 「늦었다」는 사실이 지워지지 않는다.",
  },
  "attack.strangerChallenges": {
    title: "남의 영수증으로 괴롭히기",
    story: "제3자가 남의 영수증 사본을 들고 기관을 두드린다.",
    why: "영수증에 이름이 적힌 당사자만 열 수 있다. 괴롭힘 수단이 되지 않는다.",
  },
  "attack.stretchedDeadline": {
    title: "기관이 자기 시간 벌기",
    story: "같은 영수증에 5,000블록을 더 얹어 다시 서명했다. 서명은 유효하다.",
    why: "기한을 체인이 본 앵커 블록에서 역산해 대조한다. 막히는 건 서명이 아니라 산수.",
  },
  "attack.phantomAnchor": {
    title: "없는 앵커 인용",
    story: "체인에 올라온 적 없는 앵커를 근거로 기한을 주장한다.",
    why: "존재하지 않는 기준점은 거부된다.",
  },
  "honest.publicNoticeIsNeutral": {
    title: "영수증 없는 공개 제출",
    story: "영수증을 못 받은 이용자가 「나 요청했다」를 공개로 남긴다.",
    why: "허용된다. 단 이것은 중립 기록이지 기관의 위반 증거가 아니다.",
  },
};

async function main() {
  if (!existsSync("out/scenarios.json")) throw new Error("run `npm run scenarios` first");
  const sc = JSON.parse(readFileSync("out/scenarios.json", "utf8"));
  const deployments = existsSync("deployments.json") ? JSON.parse(readFileSync("deployments.json", "utf8")) : {};

  const { bundle } = await runCase({ inputs: "screening" });
  const report = await verifyBundle(bundle, {});

  const when = new Date(sc.generatedAt).toLocaleString("ko-KR", { dateStyle: "long", timeStyle: "short" });
  const attacks = sc.scenarios.filter((r: any) => r.kind === "attack");
  const honest = sc.scenarios.filter((r: any) => r.kind === "honest");

  const sceneCard = (r: any) => {
    const ko = KO[r.id] ?? { title: r.id, story: r.claim, why: "" };
    return `<div class="scene ${r.ok ? "" : "bad"}">
      <div class="sh"><span class="tick ${r.ok ? "ok" : "no"}">${r.ok ? "✓" : "✕"}</span>
        <b>${esc(ko.title)}</b><span class="tag ${r.kind}">${r.kind === "attack" ? "공격" : "정상"}</span></div>
      <div class="story">${esc(ko.story)}</div>
      <div class="why">→ ${esc(ko.why)}</div>
      <div class="meta"><code>${esc(r.id)}</code> · ${esc(r.note)}</div>
    </div>`;
  };

  const deployRows = Object.values(deployments).map((d: any) => `
    <tr><td><b>${esc(d.network)}</b> <span class="dim">chainId ${esc(d.chainId)}</span></td>
        <td><code>${esc(d.contract)}</code></td>
        <td><a href="${esc(d.explorer)}">탐색기에서 보기 ↗</a></td></tr>`).join("");

  const checkRows = report.checks.map(c => `
    <tr><td><span class="s ${c.status}">${esc(c.status)}</span></td>
        <td><code>${esc(c.id)}</code></td><td class="note">${esc(c.detail)}</td></tr>`).join("");

  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BlockNotice — 검증 결과</title>
<style>
 :root{--bg:#fcfcfb;--panel:#fff;--fg:#191917;--dim:#6f6f6a;--line:#e6e6e1;--ok:#13734a;--no:#b3261e;--warn:#8a6100;--accent:#1d4ed8}
 @media(prefers-color-scheme:dark){:root{--bg:#141417;--panel:#1b1b1f;--fg:#eaeae7;--dim:#9b9b96;--line:#2d2d33;--ok:#5cc48d;--no:#ff8073;--warn:#e2b455;--accent:#8ab4ff}}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);
   font:15px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Malgun Gothic",sans-serif;
   word-break:keep-all;overflow-wrap:anywhere}
 .wrap{max-width:960px;margin:0 auto;padding:44px 20px 96px}
 h1{font-size:27px;margin:0 0 6px;letter-spacing:-.02em}
 h2{font-size:13px;margin:44px 0 14px;letter-spacing:.1em;color:var(--dim);font-weight:700}
 .lede{font-size:16px;color:var(--fg);margin:0 0 4px}
 .stamp{color:var(--dim);font-size:13px;margin:0 0 28px}
 .brief{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:22px 24px;margin:0 0 22px}
 .brief h3{margin:0 0 8px;font-size:15px}
 .brief p{margin:0 0 14px;color:var(--fg)}
 .brief p:last-child{margin-bottom:0}
 .brief .q{color:var(--dim);font-size:13px;font-weight:700;letter-spacing:.04em;margin:0 0 4px}
 .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(146px,1fr));gap:11px;margin:22px 0}
 .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
 .card .n{font-size:29px;font-weight:700;line-height:1.15;letter-spacing:-.02em}
 .card .n.good{color:var(--ok)} .card .l{color:var(--dim);font-size:12.5px;margin-top:1px}
 .warn{border-left:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 9%,transparent);
   padding:12px 16px;border-radius:0 8px 8px 0;font-size:14px;margin:18px 0}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:11px}
 .scene{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
 .scene.bad{border-color:var(--no);background:color-mix(in srgb,var(--no) 7%,transparent)}
 .sh{display:flex;align-items:center;gap:8px;margin-bottom:6px}
 .sh b{font-size:15px}
 .tick{font-weight:800}.tick.ok{color:var(--ok)}.tick.no{color:var(--no)}
 .tag{margin-left:auto;font-size:11px;padding:2px 8px;border-radius:20px;border:1px solid var(--line);color:var(--dim)}
 .tag.attack{color:var(--no);border-color:color-mix(in srgb,var(--no) 35%,transparent)}
 .tag.honest{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent)}
 .story{font-size:14px;margin-bottom:5px}
 .why{font-size:13.5px;color:var(--dim);margin-bottom:9px}
 .meta{font-size:11px;color:var(--dim);border-top:1px solid var(--line);padding-top:7px}
 table{width:100%;border-collapse:collapse;font-size:13.5px;background:var(--panel);
   border:1px solid var(--line);border-radius:10px;overflow:hidden}
 td,th{border-bottom:1px solid var(--line);padding:10px 13px;text-align:left;vertical-align:top}
 tr:last-child td{border-bottom:none}
 code{font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
 .note{color:var(--dim);font-size:12.5px}
 .s{font:11px/1 ui-monospace,monospace;padding:4px 7px;border-radius:4px;white-space:nowrap;
   background:color-mix(in srgb,currentColor 14%,transparent)}
 .s.CONFIRMED{color:var(--ok)}.s.OBLIGATION_UNMET{color:var(--no)}
 .s.UNVERIFIABLE,.s.NOT_DUE,.s.OUT_OF_SCOPE{color:var(--warn)}
 pre{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;
   overflow:auto;max-height:420px;font-size:11.5px;line-height:1.5}
 details{border:1px solid var(--line);border-radius:10px;padding:11px 14px;margin-top:10px;background:var(--panel)}
 summary{cursor:pointer;color:var(--dim);font-size:13px}
 .dim{color:var(--dim);font-weight:400;font-size:12.5px}
 a{color:var(--accent)}
 .foot{margin-top:52px;padding-top:18px;border-top:1px solid var(--line);color:var(--dim);font-size:13px}
</style>
<div class="wrap">

<h1>BlockNotice — 검증 결과</h1>
<p class="lede">거절된 출금은 트랜잭션이 되지 않습니다. 그래서 기록이 기관 쪽에만 남습니다.</p>
<p class="stamp">${esc(when)} 실행 · 로그 컨트랙트 <code>${esc(sc.logContract)}</code></p>

<div class="brief">
  <div class="q">이게 뭔가</div>
  <p>출금이 <b>승인</b>되면 체인에 트랜잭션이 남습니다. 그런데 <b>거절·보류</b>되면 아무 데도 안 남습니다 —
  기관의 내부 DB 말고는. 나중에 기관이 「그런 요청 없었다」거나 「사유는 이랬다」고 말을 바꾸면
  이용자에게는 반박할 근거가 없습니다.</p>
  <p>BlockNotice는 그 판단의 <b>서명 영수증을 요청자에게 돌려주고</b>, 기관이 서명한 약속이 지켜졌는지를
  <b>기관 서버에 한 번도 접속하지 않고</b> 확인합니다.</p>

  <div class="q">이 화면은 뭔가</div>
  <p>방금 <b>실제로 돌린 결과</b>입니다. 16개 상황을 로컬 체인에 올려 재현했고, 각 상황은
  <b>돌기 전에</b> 「제3자가 무엇을 결론지어야 하는가」를 먼저 선언합니다. 그래서
  검증기가 조용해서 통과하는 일이 없습니다.</p>

  <div class="q">뭘 보면 되나</div>
  <p><b>아래 숫자 두 개만 보셔도 됩니다.</b> 공격을 몇 개 잡았는지, 그리고 <b>정상인데 위반으로 잘못 찍은 게
  몇 개인지</b>. 두 번째가 첫 번째만큼 중요합니다 — 정직한 기관을 범인으로 모는 도구는 아무도 안 씁니다.</p>
</div>

<div class="cards">
  <div class="card"><div class="n good">${sc.totals.attacksCaught}/${sc.totals.attacks}</div><div class="l">공격 탐지</div></div>
  <div class="card"><div class="n ${sc.totals.falsePositives === 0 ? "good" : ""}">${sc.totals.falsePositives}</div><div class="l">오탐 (정상을 위반으로)</div></div>
  <div class="card"><div class="n">${sc.totals.scenes}</div><div class="l">재현한 상황</div></div>
  <div class="card"><div class="n good">${report.institutionNetworkCalls}</div><div class="l">기관 접속 횟수 (실측)</div></div>
</div>

<div class="warn"><b>로컬 시연과 공개 증거는 다릅니다.</b> 기한이 지나야 보이는 상황은 로컬 체인에서
블록을 당겨 시연했습니다. 아래 공개 테스트넷에는 <b>실제로 일어난 것만</b> 있습니다. 둘을 섞어 제시하지 않습니다.</div>

<h2>공격 ${attacks.length}개 — 전부 잡혔는가</h2>
<div class="grid">${attacks.map(sceneCard).join("")}</div>

<h2>정상 ${honest.length}개 — 잘못 찍지 않았는가</h2>
<div class="grid">${honest.map(sceneCard).join("")}</div>

<h2>공개 테스트넷 배포</h2>
<table>${deployRows || "<tr><td class=dim>기록 없음</td></tr>"}</table>
<p class="note" style="margin-top:10px">Sepolia가 2026-09-30에 종료 예정이라 같은 컨트랙트를 Hoodi에도 올렸습니다.
저장소에서 <code>npm run check:deployment</code>를 돌리면 양쪽을 공개 RPC에서 다시 읽어 대조합니다.</p>

<h2>검증기 출력 — 영수증 한 건을 실제로 검사한 결과</h2>
<p class="note">체인 등록 정보를 일부러 주지 않고 돌렸습니다. 그래서 신뢰 기준점이
<code>UNVERIFIABLE</code>로 나옵니다 — 파일 하나만 놓고 볼 때의 정직한 판정입니다.
「모르겠다」와 「위반이다」를 섞지 않는 것이 이 도구의 핵심입니다.</p>
<table><tr><th>판정</th><th>검사 항목</th><th>내용</th></tr>${checkRows}</table>

<details><summary>이용자가 보유하는 영수증 묶음 원본 (raw JSON)</summary><pre>${json(bundle)}</pre></details>
<details><summary>검증기 출력 (raw JSON)</summary><pre>${json(report)}</pre></details>
<details><summary>deployments.json (raw)</summary><pre>${json(deployments)}</pre></details>

<p class="foot">이 페이지의 모든 수치는 <code>npm run demo</code> 한 명령으로 재현됩니다.
등장하는 기관·이용자·금액·주소는 전부 시뮬레이터가 만든 합성 데이터이며, 실제 거래가 아닙니다.</p>
</div>`;

  mkdirSync("out", { recursive: true });
  writeFileSync("out/report.html", html);
  console.log(`wrote out/report.html  (${(html.length / 1024).toFixed(0)} KB, open it directly — no server needed)`);
}

main().catch(e => { console.error(String(e?.message ?? e)); process.exit(1); });
