// Shared vector/text source for the English HTML, PDF, and Figma Slides build.
const fs = require('node:fs');
const path = require('node:path');
const C = {navy:'#10283F',ink:'#172D40',gold:'#AE812B',pale:'#F4EDDE',slate:'#526477',light:'#F1F4F6',rule:'#D7DEE4',white:'#FFFFFF',teal:'#21766B',rust:'#A24B35',soft:'#CFD9E2'};
const slides = [];
const repo = 'https://github.com/tnwjd023-boop/BlockNotice_GoldRWA';
function text(x,y,w,value,size=30,color=C.ink,bold=false,name='Text') { return {type:'text',name,x,y,w,text:value,size,color,bold,line:1.26}; }
function rect(x,y,w,h,color,name='Rule') { return {type:'rect',name,x,y,w,h,color}; }
function stack(x,y,w,h,items,{gap=16,pad=0,bg=null,name='Content group',direction='VERTICAL'}={}) {
  return {type:'group',name,x,y,w,h,items,gap,pad,bg,direction};
}
function tx(w,value,size=30,color=C.ink,bold=false) { return text(0,0,w,value,size,color,bold); }
function slide(kicker,title,source,{dark=false,subtitle}={}) {
  const n=slides.length+1;
  const s={name:`${String(n).padStart(2,'0')} · ${title.replace(/\n/g,' ')}`,bg:dark?C.navy:C.white,children:[]};
  s.children.push(text(96,62,1650,kicker.toUpperCase(),20,dark?C.soft:C.slate,true,'Section label'));
  s.children.push(rect(96,106,62,6,C.gold,'Gold milestone'));
  s.children.push(text(96,146,1728,title,56,dark?C.white:C.ink,true,'Conclusion'));
  if(subtitle) s.children.push(text(98,300,1680,subtitle,27,dark?C.soft:C.slate));
  s.children.push(rect(96,992,1728,1,dark?'#395064':C.rule,'Footer rule'));
  s.children.push(text(96,1011,1620,source,18,dark?C.soft:C.slate,false,'Source'));
  s.children.push(text(1744,1007,80,String(n).padStart(2,'0'),24,dark?C.white:C.ink,true,'Page number'));
  slides.push(s); return s.children;
}
function row(x,y,widths,values,{h=110,bg=null,header=false}={}) {
  const items=values.map((v,i)=>stack(0,0,widths[i],h,[tx(widths[i]-40,v,header?22:28,header?C.white:C.ink,header)],{pad:20,gap:0,name:`Column ${i+1}`}));
  return stack(x,y,widths.reduce((a,b)=>a+b,0),h,items,{direction:'HORIZONTAL',gap:0,bg:bg||(header?C.navy:null),name:'Table row'});
}
function band(y,message,dark=false) {
  return stack(96,y,1728,94,[tx(1672,message,28,dark?C.white:C.ink,true)],{pad:28,gap:0,bg:dark?C.navy:C.pale,name:'Key implication'});
}

// 01 — opening position, with a visible three-clock signature.
{
  const a=slide('BlockNotice / Gold RWA redemption','Make every redemption\ndelay attributable.','TRUST404 · Track 3  |  Prototype evidence as of 17 September 2026',{dark:true});
  a.find(n=>n.name==='Conclusion').size=90; a.find(n=>n.name==='Conclusion').w=1190;
  a.push(text(100,450,1050,'Independent evidence for the journey\nfrom a token lock to a delivery claim.',38,C.white));
  a.push(text(100,640,1030,'A commitment to record and prove each step.\nRedemption approval remains an institutional decision.',28,C.soft));
  a.push(text(100,861,1100,'ESCROW  /  EXCHANGE INBOX  /  PUBLIC VERIFIER',21,C.soft,true));
  a.push(rect(1370,230,3,528,C.gold,'Three-clock spine'));
  [['01','Exchange','Signed request'],['02','Operator','Token lock'],['03','Delivery provider','Handoff anchor']].forEach((d,i)=>{
    a.push(rect(1357,244+i*236,29,29,C.gold,'Milestone'));
    a.push(stack(1430,223+i*236,370,175,[tx(370,d[0],24,C.soft,true),tx(370,d[1],37,C.white,true),tx(370,d[2],26,C.soft)],{gap:12,name:d[1]}));
  });
}
// 02 — executive thesis.
{
  const a=slide('Executive perspective','One redemption journey.\nThree accountable clocks.','Source: README.en.md §§1, 4–5, 8–9. Adoption incentives remain a hypothesis.');
  [['01','Locate the delay','Separate exchange forwarding, operator\ndecision-making, and delivery-provider\nrecording into distinct obligations.'],['02','Keep evidence portable','Let holders check signed records and\npublic commitments without relying\non the institution’s server.'],['03','Test before adoption','Use reproducible local scenarios and\nverified testnet deployments as the\nstarting point for a partner pilot.']].forEach((d,i)=>{
    const x=96+i*584;
    a.push(stack(x,385,530,390,[tx(530,d[0],74,C.gold,true),tx(530,d[1],36,C.ink,true),tx(530,d[2],29,C.slate)],{gap:24,name:d[1]}));
  });
  a.push(band(846,'Implemented today: signed receipts + public log + redemption escrow + exchange inbox.'));
}
// 03 — evidence gap, not an assertion about a specific issuer.
{
  const a=slide('The problem','A token lock reveals custody—\nnot who is delaying redemption.','Source: redemption proposal and README.en.md §1. Illustrative process; not a claim about any particular issuer.');
  a.push(text(96,334,1660,'Holders see one delay. Responsibility spans several institutions.',31,C.slate));
  a.push(rect(96,425,1728,352,C.light,'Process field'));
  const stages=[['Request','Exchange'],['Lock','Escrow'],['Decision','Operator'],['Handoff','Operator → provider'],['Delivery claim','Provider'],['Burn / return','Escrow']];
  stages.forEach((d,i)=>{
    let x=128+i*284;
    a.push(stack(x,471,244,250,[tx(244,String(i+1).padStart(2,'0'),23,C.gold,true),tx(244,d[0],33,C.ink,true),tx(244,d[1],23,C.slate)],{gap:24,name:d[0]}));
    if(i<5)a.push(text(x+245,531,34,'→',31,C.gold));
  });
  a.push(stack(96,822,760,118,[tx(760,'VISIBLE ONCHAIN',20,C.teal,true),tx(760,'Lock, amounts, token movements',32,C.ink,true)],{gap:13,name:'Public token evidence'}));
  a.push(stack(982,822,842,118,[tx(842,'EVIDENCE GAP',20,C.rust,true),tx(842,'Decision timing, handoff, delivery claims',32,C.ink,true)],{gap:13,name:'Institutional evidence gap'}));
}
// 04 — narrow the audience.
{
  const a=slide('Initial user focus','Start with holders who can sign\nand institutions that can integrate.','Source: README.en.md §1 and limitations §§10.5, 10.14. No customer adoption is claimed.');
  a.push(stack(96,378,740,545,[tx(636,'PRIMARY USER',20,C.soft,true),tx(636,'Self-custody\nholders and\ninstitutions',58,C.white,true),tx(636,'Direct locking starts the operator’s clock.\nThe holder retains control of challenges,\nreclaims, disputes, and acknowledgement.',28,C.white)],{gap:32,pad:52,bg:C.navy,name:'Primary audience'}));
  const items=[['ADOPTER','Issuer / operator','Integration incentive: distinguish responsibility\nacross the redemption chain. Hypothesis, not traction.'],['CONDITIONAL','Exchange-wallet customer','Needs an external signing key. The inbox does not\nverify customer status, balance, or eligibility.'],['OUTSIDE DIRECT SCOPE','Custodial user without a key','Cannot independently sign the current flow.\nPasskeys and gas sponsorship are not implemented.']];
  items.forEach((d,i)=>{
    a.push(stack(930,387+i*187,890,162,[tx(890,d[0],19,i===2?C.rust:C.gold,true),tx(890,d[1],33,C.ink,true),tx(890,d[2],26,C.slate)],{gap:12,name:d[1]}));
  });
}
// 05 — core responsibility matrix.
{
  const a=slide('Protocol design','Each clock starts from\na different onchain event.','Source: contracts and README.en.md §§4–5, 9. Deadlines are block counts, not elapsed-time guarantees.');
  const widths=[320,460,480,468];
  a.push(row(96,360,widths,['RESPONSIBLE PARTY','CLOCK STARTS AT','REQUIRED EVIDENCE','IF UNANSWERED'],{header:true,h:76}));
  a.push(row(96,436,widths,['01  Exchange','Holder-signed request\nsubmitted to inbox','Forward into escrow\nor prove rejection','Exchange breach only;\noperator clock not started'],{h:146,bg:C.light}));
  a.push(row(96,582,widths,['02  Operator','Token lock\n(direct or via inbox)','Decision record;\nthen a proven handoff','finalize returns tokens\nafter the response window'],{h:146}));
  a.push(row(96,728,widths,['03  Delivery provider','Handoff anchor\nrecorded onchain','Delivery claim in\nprovider’s own log','STALLED;\ntokens remain locked'],{h:146,bg:C.light}));
  a.push(text(96,916,1728,'Requests and locks start clocks without waiting for a separate acceptance receipt.',29,C.gold,true));
}
// 06 — architecture and privacy.
{
  const a=slide('Evidence architecture','Public commitments make records\nindependently checkable.','Source: README.en.md §§4, 6, 11. Fetch instrumentation is scoped to verifier call windows; not a universal network audit.');
  const blocks=[
    ['HOLDER','Signed request\n+ private evidence','EIP-712 binds the requester.\nPrivate opening material stays\nwith the case.'],
    ['PUBLIC CHAIN','Escrow / inbox\n+ append-only log','Contracts compute Merkle roots.\nEvents bind obligations to\nchain-observed blocks.'],
    ['INDEPENDENT VERIFIER','Replay records\n+ inspect proofs','Public RPC and held evidence\nproduce a finding per check,\nwithout the institution’s server.']
  ];
  blocks.forEach((d,i)=>{
    const x=96+i*595;
    a.push(stack(x,386,530,400,[tx(530,d[0],21,C.gold,true),tx(530,d[1],43,C.ink,true),tx(530,d[2],29,C.slate)],{gap:30,name:d[0]}));
    if(i<2)a.push(text(x+538,500,45,'→',40,C.gold));
  });
  a.push(stack(96,834,1728,108,[tx(1664,'PRIVATE: decision outcome + reason opening     PUBLIC: addresses, amounts, deadlines, states, burn / return',27,C.ink,true)],{pad:32,bg:C.pale,name:'Privacy boundary'}));
}
// 07 — conditions have different token effects.
{
  const a=slide('Escrow outcomes','Return, hold, or burn—\neach follows explicit conditions.','Source: RedemptionEscrow and README.en.md §5. STALLED / DISPUTED have no administrator override.');
  const lanes=[
    ['RETURN',C.teal,'Operator non-response is finalized,\nor the handoff deadline passes.','Tokens return through finalize / reclaim.'],
    ['HOLD',C.gold,'Provider non-response → STALLED.\nHolder dispute → DISPUTED.','Tokens stay locked pending offchain resolution.'],
    ['BURN',C.navy,'Provider delivery claim is proven;\nholder acknowledges or dispute window expires.','After expiry in DELIVERED, anyone can call burn.']
  ];
  lanes.forEach((d,i)=>{
    const y=360+i*171;
    a.push(stack(96,y,285,141,[tx(237,d[0],44,C.white,true)],{pad:24,bg:d[1],name:`${d[0]} outcome`}));
    a.push(stack(425,y+10,830,126,[tx(830,d[2],32,C.ink,true)],{gap:0,name:`${d[0]} trigger`}));
    a.push(stack(1320,y+10,500,125,[tx(500,d[3],28,C.slate)],{gap:0,name:`${d[0]} effect`}));
  });
  a.push(text(96,915,1728,'The dispute window begins when the escrow accepts the proof—not at an older delivery anchor.',28,C.gold,true));
}
// 08 — epistemic scope and threat model.
{
  const a=slide('Trust boundaries','Missing evidence must remain distinct\nfrom a proven breach.','Source: README.en.md §§3–4, 10. A manipulated bundle alone does not attribute wrongdoing to an institution.');
  const statuses=[['CONFIRMED','Signature / binding / proof checks out',C.teal],['NOT_DUE','Deadline has not arrived',C.slate],['OBLIGATION_UNMET','Inspect the failed check and evidence',C.rust],['UNVERIFIABLE','Evidence is insufficient',C.gold],['OUT_OF_SCOPE','Fact is outside the tool’s guarantees',C.slate]];
  statuses.forEach((d,i)=>{
    a.push(stack(96,355+i*113,855,92,[tx(803,d[0],27,d[2],true),tx(803,d[1],26,C.ink)],{gap:9,pad:14,bg:i%2?null:C.light,name:d[0]}));
  });
  a.push(stack(1062,367,738,227,[tx(738,'THREATS ADDRESSED',20,C.gold,true),tx(738,'Institution: omission and lateness\nRequester: fabricated obligations\nThird party: forged bundles',30,C.ink)],{gap:22,name:'Threat actors'}));
  a.push(stack(1062,649,738,243,[tx(738,'OUTSIDE THE GUARANTEE',20,C.rust,true),tx(738,'Physical gold and actual delivery\nTruth of private reasons\nLegal enforcement and chain finality',30,C.ink)],{gap:22,name:'Guarantee boundary'}));
}
// 09 — make denominators and environments unambiguous.
{
  const a=slide('Verification evidence','The prototype is reproducible;\nproduction validation is still ahead.','Source: README.en.md §§8–9; escrow-deployments.json. Counts are the 17 September 2026 verification snapshot.');
  [['191','Automated tests','107 Solidity + 84 TypeScript'],['30','Local scenarios','20 attack + 10 honest'],['3','Source-verified contracts','Sourcify exact_match on Sepolia']].forEach((d,i)=>{
    a.push(stack(96+i*590,340,540,320,[tx(540,d[0],132,i===2?C.gold:C.navy,true),tx(540,d[1],34,C.ink,true),tx(540,d[2],25,C.slate)],{gap:15,name:d[1]}));
  });
  a.push(stack(96,737,817,200,[tx(753,'LOCAL EVIDENCE',20,C.teal,true),tx(753,'All 30 scenarios matched expected findings.\nZero expectation mismatches in honest cases.',29,C.ink),tx(753,'This is not a statistical false-positive rate.',22,C.slate)],{gap:15,pad:32,bg:C.light,name:'Local validation'}));
  a.push(stack(951,737,873,200,[tx(809,'PUBLIC EVIDENCE',20,C.gold,true),tx(809,'Six deployment / registration transactions.\nMockGold + escrow + inbox on Sepolia.',29,C.ink),tx(809,'No physical redemption or full public scenario run.',22,C.slate)],{gap:15,pad:32,bg:C.pale,name:'Public validation'}));
}
// 10 — honest contribution.
{
  const a=slide('Technical contribution','The contribution is accountability\nfor offchain decisions.','Source: README.en.md §§7, 12. References: rollup inboxes, CT RFC 6962/9162, SCITT RFC 9943; no wire compatibility claimed.');
  const widths=[400,520,808];
  a.push(row(96,355,widths,['REFERENCE','CORE MECHANISM','BOUNDARY / ADAPTATION'],{h:78,header:true}));
  a.push(row(96,433,widths,['Rollup inboxes','Forced inclusion','The rollup protocol can enforce inclusion.\nAn offchain service cannot be forced the same way.'],{h:143,bg:C.light}));
  a.push(row(96,576,widths,['Transparency logs','Append-only commitments\nand inclusion proofs','Users monitor their own entries;\npublic roots provide evidence of inclusion.'],{h:143}));
  a.push(row(96,719,widths,['BlockNotice','Bound receipts, chain-derived\ndeadlines, asset locks','Locks start the operator clock without a receipt;\nhandoff starts the provider clock.'],{h:143,bg:C.pale}));
  a.push(text(96,915,1728,'Adapt established primitives to make delay attribution independently verifiable.',29,C.gold,true));
}
// 11 — adoption agenda, explicitly proposed.
{
  const a=slide('Path to adoption / proposed next steps','Adoption depends on identity, disputes,\nand operational controls.','Source: README.en.md §10. These are proposed validation workstreams, not committed delivery dates or completed controls.');
  const work=[
    ['01','Identity & access','Authenticate institutions and customers.\nAddress inbox spam and false balance claims.\nPlan key rotation and wallet support.'],
    ['02','Disputes & incentives','Define offchain resolution for locked cases.\nValidate issuer and legal-team incentives.\nEvaluate institutional collateral / penalties.'],
    ['03','Operational readiness','Set finality and monitoring policies.\nAudit contracts and token assumptions.\nPilot with a real operating partner.']
  ];
  work.forEach((d,i)=>{
    const x=96+i*590;
    a.push(stack(x,374,536,397,[tx(536,d[0],65,C.gold,true),tx(536,d[1],35,C.ink,true),tx(536,d[2],28,C.slate)],{gap:25,name:d[1]}));
  });
  a.push(band(844,'Shipped: working prototype and testnet evidence. Next: validate the operating model with a partner.'));
}
// 12 — executable close and source ownership.
{
  const a=slide('BlockNotice / next conversation','Verify the evidence.\nThen test the operating model.','Original: kimsabin725/blocknotice · Idea: SBK · Extension: tnwjd023-boop · AI-assisted implementation',{dark:true});
  a.find(n=>n.name==='Conclusion').size=75;
  a.push(stack(96,412,1065,303,[tx(1065,'REPRODUCE THE LOCAL DEMO',20,C.soft,true),tx(1065,'npm run demo',52,C.white,true),tx(1065,'CHECK THE PUBLIC DEPLOYMENT',20,C.soft,true),tx(1065,'npm run check:escrow -- sepolia',40,C.white,true),tx(1065,'Setup and SEPOLIA_RPC_URL are documented in the README.',23,C.soft)],{gap:22,name:'Reproduction commands'}));
  a.push(stack(1280,414,540,354,[tx(540,'SEPOLIA / 11155111',21,C.soft,true),tx(540,'MockGold       0xb3a791…955b1a\nEscrow            0x8c8cbf…f7778c\nInbox               0x870238…bb5d',27,C.white),tx(540,'Three services, one demo wallet.\nMockGold has no physical-gold backing.\nSource verification is not a security audit.',25,C.soft)],{gap:30,name:'Deployment registry'}));
  a.push(rect(96,841,62,6,C.gold,'Closing milestone'));
  a.push(text(96,879,1728,'github.com/tnwjd023-boop/BlockNotice_GoldRWA',30,C.white,true));
}

const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function render(n,flow=false){
  let common=`${flow?'position:relative;flex-shrink:0;':'position:absolute;left:'+n.x+'px;top:'+n.y+'px;'}width:${n.w}px;`;
  if(n.type==='text')return `<div class="text" data-name="${esc(n.name)}" style="${common}font-size:${n.size}px;line-height:${n.line};color:${n.color};font-weight:${n.bold?700:400};white-space:pre-wrap">${esc(n.text)}</div>`;
  if(n.type==='rect')return `<div data-name="${esc(n.name)}" style="${common}height:${n.h}px;background:${n.color}"></div>`;
  return `<div class="group" data-name="${esc(n.name)}" style="${common}height:${n.h}px;display:flex;flex-direction:${n.direction==='VERTICAL'?'column':'row'};gap:${n.gap}px;padding:${n.pad}px;${n.bg?'background:'+n.bg+';':''}">${n.items.map(c=>render(c,true)).join('')}</div>`;
}
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BlockNotice — Gold RWA Redemption</title><style>
*{box-sizing:border-box}html,body{margin:0;background:#DCE2E8;font-family:Arial,Helvetica,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}.slide{position:relative;width:1920px;height:1080px;overflow:hidden;margin:32px auto;break-after:page}.slide:last-child{break-after:auto}.group{overflow:visible}.text{margin:0} @page{size:20in 11.25in;margin:0}@media print{html,body{background:white}.slide{margin:0}} </style></head><body>${slides.map((s,i)=>`<section class="slide" aria-label="${esc(s.name)}" data-page="${i+1}" style="background:${s.bg}">${s.children.map(n=>render(n)).join('')}</section>`).join('\n')}</body></html>`;
fs.writeFileSync(path.join(__dirname,'pitch.en.html'),html);
fs.writeFileSync(path.join(__dirname,'pitch.en.scene.json'),JSON.stringify({width:1920,height:1080,font:'Arial',repo,colors:C,slides},null,2)+'\n');
console.log(`Generated ${slides.length} English slides with shared Figma-ready vector/text data.`);
