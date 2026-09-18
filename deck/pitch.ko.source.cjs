// 한글 덱: 영문 덱과 같은 벡터/텍스트 골격을 쓰고 내용만 한글이다.
const fs = require('node:fs');
const path = require('node:path');
const C = {navy:'#10283F',ink:'#172D40',gold:'#AE812B',pale:'#F4EDDE',slate:'#526477',light:'#F1F4F6',rule:'#D7DEE4',white:'#FFFFFF',teal:'#21766B',rust:'#A24B35',soft:'#CFD9E2'};
const slides = [];
const repo = 'https://github.com/kimsabin725/blocknotice';
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


// 01 — 표지. 오른쪽 세 시계 스파인은 영문판과 같은 자리.
{
  const a=slide('TRUST404 · TRACK 3 · 실행 이전','거절된 요청은\n트랜잭션이 되지 못합니다.','제출 저장소 github.com/kimsabin725/blocknotice · 증거 기준 2026년 9월 18일',{dark:true});
  const c=a.find(n=>n.name==='Conclusion'); c.size=72; c.w=1250;
  a.push(text(100,450,1050,'승인만 체인에 남고,\n막힌 요청은 기관 DB에만 남습니다.',38,C.white));
  a.push(text(100,640,1030,'그 판단에 서명 영수증을 붙이고, 서명한 기한이 지켜졌는지를\n기관 서버에 한 번도 접속하지 않고 확인합니다.',28,C.soft));
  a.push(text(100,861,1100,'에스크로  /  거래소 인박스  /  공개 검증기',21,C.soft,true));
  a.push(rect(1370,230,3,528,C.gold,'세 시계 축'));
  [['01','거래소','서명 요청 제출'],['02','운영사','토큰 잠금'],['03','인도 기관','인계 앵커']].forEach((d,i)=>{
    a.push(rect(1357,244+i*236,29,29,C.gold,'지점'));
    a.push(stack(1430,223+i*236,370,175,[tx(370,d[0],24,C.soft,true),tx(370,d[1],37,C.white,true),tx(370,d[2],26,C.soft)],{gap:12,name:d[1]}));
  });
}
// 02 — 문제 정의.
{
  const a=slide('문제 정의','「그런 요청 받은 적 없는데요」','일반화된 구조입니다. 특정 기관이 실제로 그렇게 한다는 주장은 아닙니다.');
  a.push(text(96,300,1660,'기록은 기관 내부 DB에만 있습니다. 사후에 바꿔 적어도, 행을 지워도 밖에서는 알 수 없습니다.',30,C.slate));
  [['01','승인은 남습니다','승인은 트랜잭션이 되어\n체인에 흔적을 남깁니다.'],['02','거절은 사라집니다','사유를 바꿔 적어도, 행을\n지워도 요청자는 모릅니다.'],['03','안 주는 게 이득입니다','영수증을 아예 안 주면\n안 줬다는 증거도 없습니다.']].forEach((d,i)=>{
    const x=96+i*584;
    a.push(stack(x,420,530,330,[tx(530,d[0],74,C.gold,true),tx(530,d[1],36,C.ink,true),tx(530,d[2],28,C.slate)],{gap:22,name:d[1]}));
  });
  a.push(band(846,'금 RWA 상환은 이 구조를 가장 두껍게 보여주는 예시입니다. 에스크로는 소각 가능한 임의의 ERC-20을 받습니다.'));
}
// 03 — 1차 대상.
{
  const a=slide('누구를 위한 것인가 — 먼저 좁힙니다','1차 대상은 자기 키로 잠그는 요청자','「모든 이용자를 위한 것」이라고 말하면 가장 먼저 무너지는 곳이 여기입니다.');
  [[C.teal,'닿는 사람','자기 지갑에 자산을 보유한\n고액 개인·기관. 직접 잠금\n트랜잭션으로 운영사 시계를\n시작합니다.\n\n도입 주체는 발행사·운영사.\n책임 구간을 구분할 유인이\n있다는 가설입니다.'],[C.gold,'조건부','거래소 지갑 이용자는 거래소\n밖 키로 인박스 요청에 서명할\n수 있을 때만.\n\n인박스는 구현했습니다.\npasskey는 설계 범위입니다.'],[C.rust,'안 닿는 사람','서명할 키가 없는\n커스터디얼 이용자.\n\n이 프로토콜의 직접 이용\n범위 밖입니다.']].forEach((d,i)=>{
    const x=96+i*584;
    a.push(stack(x,360,530,430,[tx(490,d[1],34,d[0],true),tx(490,d[2],26,C.slate)],{gap:20,pad:28,bg:C.light,name:d[1]}));
  });
}
// 04 — 위협 모델. 트랙 3 의 핵심 장이라 표를 그대로 쓴다.
{
  const a=slide('위협 모델','누가, 무엇을 가지고, 무엇을 시도하는가','비가정: 로그키·앵커키 동시 유출, 체인 재구성, 요청자 = 결정자, 오프체인 전달 자체의 증명(존재하지 않습니다).');
  const w=[300,430,998];
  a.push(row(96,330,w,['행위자','가진 능력','시도할 수 있는 공격'],{h:74,header:true}));
  [['기관 (결정자)','로그 서명키, 앵커키,\nDB, 서버, 멤풀 관찰','기록 누락·삭제·수정·백데이트 / 사유 사후 교체 /\n영수증 보류 / 기한 자가 연장 / 늦은 응답으로 지각 은폐'],
   ['요청자','자기 키, 받은 영수증','없던 의무 날조 / 남의 영수증으로 기관 괴롭히기 /\n조작된 묶음으로 허위 고발'],
   ['제3자','자기 도메인·자기 키','통째로 위조한 묶음을 진짜처럼 제시'],
   ['외부 관찰자','로그·앵커·공개 제출 열람','건수 추정 / 상환 확장에서는 보유자·수량·소각·반환 공개']]
  .forEach((r,i)=>{ a.push(row(96,404+i*138,w,r,{h:138,bg:i%2?C.light:null})); });
}
// 05 — 메커니즘.
{
  const a=slide('어떻게','서명 영수증과 공개 로그','컨트랙트는 해시만 저장합니다. 요청 내용·통지문·사유를 모릅니다.');
  a.push(stack(96,330,860,470,[tx(804,'요청자 ──서명 요청(EIP-712)+HPKE 봉투──▶ 기관\n\n   ◀── AcceptedReceipt ─────────────\n       (기록 기한 + 요청자 바인딩)      REQ 리프 기록\n\n   ◀── DecisionRecord ──────────────\n       (암호화 전달, 기관 서명)          DEC 리프 기록\n\n공개 로그 : append-only 머클 트리(깊이 32)\n            루트는 제출받지 않고 컨트랙트가 계산\n검증기    : 파일 + 공개 로그 루트만으로 판정\n            기관 접속 0회 (실측)',24,C.ink)],{pad:28,bg:C.light,name:'프로토콜 흐름'}));
  [['루트를 제출받지 않습니다.','리프를 받아 컨트랙트가 계산합니다. 기관이 자기가 만들지 않은 트리의 루트를 올릴 수 없습니다.'],
   ['기한은 체인이 본 블록에서.','영수증이 인용한 앵커의 실제 블록 + 등록된 간격을 컨트랙트가 다시 계산해 대조합니다.'],
   ['영수증 사본은 자격이 아닙니다.','이름이 적힌 요청자만 챌린지를 열 수 있고, 그 바인딩에 기관이 서명합니다.']]
  .forEach((d,i)=>{ a.push(stack(1010,330+i*190,814,170,[tx(814,d[0],30,C.ink,true),tx(814,d[1],26,C.slate)],{gap:14,name:d[0]})); });
}
// 06 — 보증 / 비보증.
{
  const a=slide('보증하는 것 / 보증하지 않는 것','「모르겠다」와 「위반이다」를 섞지 않습니다','판정 5분류: CONFIRMED · NOT_DUE · OBLIGATION_UNMET · UNVERIFIABLE · OUT_OF_SCOPE — 「아직」과 「모름」은 위반이 아닙니다.');
  a.push(stack(96,330,856,560,[tx(800,'보증합니다',34,C.teal,true),tx(800,'기록 무결성 — 영수증 서명과 공개 커밋의 일치.\n사후 교체 탐지.\n\n접수 책임 — 서명한 기록 기한이 지켜졌는가.\n\n독립 제출 — 영수증 없이도 공개 경로에\n제출 사실을 남김.\n\n기관 접속 0회 — 검증 중 나간 HTTP 호출을\n세어서 보고. 상수가 아니라 실측.',26,C.slate)],{gap:20,pad:28,bg:C.light,name:'보증'}));
  a.push(stack(968,330,856,560,[tx(800,'보증하지 않습니다',34,C.rust,true),tx(800,'비공개 사유의 진실성 — 커밋은 교체를 탐지할 뿐.\n\n실물 준비금 — PoR 영역. 자산의 존재를 증명하지 않음.\n\n실제 인도 — 인도 기관의 기록은 인도 주장.\n물리적 이행의 증명이 아님.\n\n완전성 — 각자 자기 항목만. 전체는 근사.\n\n법적 강제력 — 체인은 의무를 만들지 않음.',26,C.slate)],{gap:20,pad:28,bg:C.light,name:'비보증'}));
}
// 07 — 검증 결과.
{
  const a=slide('검증 결과 — test:all + demo','공격 20개 기대 판정 일치, 정상 10개 오탐 0','기한 경과 장면은 로컬 체인에서 블록을 당겨 시연했습니다. 공개 테스트넷에는 실제로 일어난 것만 있습니다.');
  [['20/20','공격 탐지',C.teal],['0','오탐 (정상을 위반으로)',C.ink],['30','실행 시나리오',C.ink]].forEach((d,i)=>{
    const x=96+i*584;
    a.push(stack(x,330,530,240,[tx(474,d[0],96,d[2],true),tx(474,d[1],26,C.slate)],{gap:12,pad:28,bg:C.light,name:d[1]}));
  });
  a.push(stack(96,620,856,220,[tx(800,'실행 전에 검사 id와 기대 판정을 선언합니다.',30,C.ink,true),tx(800,'검증기가 조용해서 통과하지 않습니다. 거부·지각 표시·검증 불가도 기대값이며, 모두 위반 판정이라는 뜻은 아닙니다.',26,C.slate)],{gap:14,name:'선언'}));
  a.push(stack(968,620,856,168,[tx(800,'공격 예시 — 무응답 · 다른 건으로 응답 · 사후 조작 · 기한 자가 연장',26,C.ink),tx(800,'정상 예시 — 제때 처리 · 불완전 번들 · 중립 공개 제출',26,C.slate)],{gap:18,pad:24,bg:C.light,name:'예시'}));
}
// 08 — 공개 증거.
{
  const a=slide('공개 증거','우리 말을 믿지 말고 직접 확인하세요','신규 계약 모두 Sourcify exact_match. 배포·등록 6건 성공, 비용 약 0.00586 테스트 ETH.');
  const w=[420,900,408];
  a.push(row(96,330,w,['네트워크','컨트랙트','비고'],{h:70,header:true}));
  [['Sepolia · MockGold','0xb3a791fbb0a2f5001375dd32b6fb621837955b1a','시연 토큰'],
   ['Sepolia · Escrow','0x8c8cbf50a91ce2c6d0746d0c4745d3a8b8f7778c','상환 잠금'],
   ['Sepolia · Inbox','0x870238b0be5d5835ff47de3510875c996c01bb5d','거래소 요청']]
  .forEach((r,i)=>{ a.push(row(96,400+i*96,w,r,{h:96,bg:i%2?C.light:null})); });
  a.push(stack(96,720,856,180,[tx(800,'check:escrow -- sepolia',28,C.ink,true),tx(800,'공개 RPC에서 주소·영수증·런타임 해시·서비스·불변 값·프로필을 대조해 통과했습니다. 기록: escrow-deployments.json',26,C.slate)],{gap:14,pad:28,bg:C.light,name:'되읽기'}));
  a.push(stack(968,720,856,180,[tx(800,'Sourcify 소스 검증 3개 완료',28,C.ink,true),tx(800,'기존 Sepolia·Hoodi 로그는 그대로 유지합니다. 누구든 같은 주소로 직접 대조할 수 있습니다.',26,C.slate)],{gap:14,pad:28,bg:C.light,name:'소스검증'}));
}
// 09 — 정직한 델타.
{
  const a=slide('무엇이 새로운가 — 정직한 델타','「Arbitrum delayed inbox와 뭐가 다르죠?」','참고: Arbitrum delayed inbox · zkSync priority queue · Certificate Transparency(RFC 6962) · SCITT(RFC 9943)');
  a.push(stack(96,320,1728,120,[tx(1672,'발명이 아니라 이식입니다. 롤업은 프로토콜이 포함을 강제합니다. 오프체인 결정 서비스에는 그 강제가 없습니다.',30,C.ink,true)],{pad:28,gap:0,bg:C.pale,name:'요지'}));
  [['포함 여부를 롤업 상태 대신 머클 앵커로 판정합니다.'],['강제가 없는 자리를 「기관이 서명한 기한」 + 「체인이 본 앵커에서의 역산」으로 채웠습니다.'],['CT와 달리 여기선 안 올리는 게 이득이라, 안 올린 사실을 요청자가 자기 영수증으로 증명하게 만들었습니다.']]
  .forEach((d,i)=>{ a.push(text(96,486+i*120,860,'— ' + d[0],27,C.slate)); });
  a.push(stack(1010,486,814,290,[tx(758,'상환 구현의 추가 델타',30,C.gold,true),tx(758,'자산 잠금이 있는 자리에서는 영수증 없이 시계가 시작됩니다.',28,C.ink,true),tx(758,'영수증을 안 줘서 시계를 안 시작시키는 회피를 잠금 트랜잭션으로 막습니다. 잠금으로 운영사 시계를, 인계로 인도 기관 시계를 시작합니다.',26,C.slate)],{gap:16,pad:28,bg:C.light,name:'추가 델타'}));
}
// 10 — 세 시계.
{
  const a=slide('상환 에스크로·인박스 · Sepolia 배포','거래소·운영사·인도 기관의 세 시계','상세: docs/redemption-design.md · 실물 준비금·물리적 인도·사유 진실성은 보증하지 않습니다.');
  const w=[380,560,788];
  a.push(row(96,330,w,['시계','시작','무응답 확정 후'],{h:70,header:true}));
  [['거래소','서명 요청 제출 블록','UNANSWERED · 운영사 시계 미시작'],
   ['운영사','토큰 잠금 블록','UNANSWERED · finalize 호출에서 토큰 반환'],
   ['인도 기관','인계 리프 앵커 블록','UNANSWERED · STALLED · 잠금 유지']]
  .forEach((r,i)=>{ a.push(row(96,400+i*92,w,r,{h:92,bg:i%2?C.light:null})); });
  a.push(stack(96,706,856,194,[tx(800,'인도 이후: 보유자의 확인과 이의',30,C.ink,true),tx(800,'인도 기관은 자기 로그로 인도를 주장합니다. 보유자 수령 확인 또는 이의 기간 경과 후 소각합니다. 이의 제기 시 잠금을 유지하며, 운영사 단독 완료 확인은 없습니다.',25,C.slate)],{gap:14,pad:28,bg:C.light,name:'인도 이후'}));
  a.push(stack(968,706,856,194,[tx(800,'판단 결과는 비공개',30,C.ink,true),tx(800,'ALLOW / DENY / DEFER와 사유 분류는 해시로 묶습니다. 판단 후 인계가 없으면 기한 경과 시 회수하고, 인계 기한 후 증명은 거부합니다.',25,C.slate)],{gap:14,pad:28,bg:C.light,name:'비공개'}));
}
// 11 — 한계.
{
  const a=slide('한계 — 우리가 먼저 적습니다','안 되는 것, 안 만든 것','조회 블록을 고정해 검증하지만 체인 재조직을 막지는 못합니다. 운영 환경에서는 별도의 확정성 정책이 필요합니다.');
  a.push(text(96,330,856,'요청자 = 결정자는 못 잡습니다. 자기 지갑·같은 법인.\n\n기존 경로의 영수증 보류는 못 막습니다.\n상환 구현에서는 잠금으로 시계를 시작합니다.\n\n경제적 강제층(stake·fee)은 설계만.\n지금 컨트랙트엔 예치금도 수수료도 없습니다.\n\nserviceId는 선착순. 남의 영수증 위조는 불가하지만\n이름은 뺏깁니다.',27,C.slate));
  a.push(text(968,330,856,'인도 기관 무응답·보유자 이의 — 잠금 유지, 오프체인 해결.\n토큰 자동 해제 없음.\n\n반환·소각은 공개. 사유 비공개가 최종 결과의\n비공개는 아닙니다.\n\n키 회전 미구현. 요청자 키 분실 = 자기 증거 상실.\n\n서명된 타임라인은 양날. 기관 방어 증거이자 소송의\n원고 증거. 법무팀이 거부할 수 있습니다 — 기술로 못 풉니다.',27,C.slate));
}
// 12 — 정리.
{
  const a=slide('정리','증거를 먼저 확인하고,\n그다음 운영을 시험하십시오.','저장소 github.com/kimsabin725/blocknotice · 아이디어 SBK · 상환 확장 tnwjd023-boop · AI 보조 구현',{dark:true});
  a.push(text(100,420,1000,'거절 판단의 증거 비대칭을 서명 영수증 + 공개 커밋으로 줄입니다.\n\n30개 시나리오의 기대 판정 일치, 오탐 0. npm run demo 로 재현.\n\n로그 Sepolia·Hoodi, 상환·인박스 Sepolia 배포. 공개 RPC 되읽기 검증.\n\n실물 준비금·실제 인도·사유 진실성은 보증하지 않습니다.',28,C.soft));
  a.push(stack(1180,420,644,300,[tx(588,'이번 구현',30,C.gold,true),tx(588,'에스크로·인박스 계약, 독립 검증기, 30개 데모, 배포·대조 도구를 구현했습니다.\n\nMockGold 로컬 검증이며 실물 운영 검증은 아닙니다.',26,C.soft)],{gap:16,pad:28,bg:'#16344F',name:'이번 구현'}));
  a.push(text(96,879,1728,'github.com/kimsabin725/blocknotice',30,C.white,true));
}

const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function render(n,flow=false){
  let common=`${flow?'position:relative;flex-shrink:0;':'position:absolute;left:'+n.x+'px;top:'+n.y+'px;'}width:${n.w}px;`;
  if(n.type==='text')return `<div class="text" data-name="${esc(n.name)}" style="${common}font-size:${n.size}px;line-height:${n.line};color:${n.color};font-weight:${n.bold?700:400};white-space:pre-wrap">${esc(n.text)}</div>`;
  if(n.type==='rect')return `<div data-name="${esc(n.name)}" style="${common}height:${n.h}px;background:${n.color}"></div>`;
  return `<div class="group" data-name="${esc(n.name)}" style="${common}height:${n.h}px;display:flex;flex-direction:${n.direction==='VERTICAL'?'column':'row'};gap:${n.gap}px;padding:${n.pad}px;${n.bg?'background:'+n.bg+';':''}">${n.items.map(c=>render(c,true)).join('')}</div>`;
}
const FONT='"Apple SD Gothic Neo","Pretendard","Malgun Gothic",-apple-system,BlinkMacSystemFont,sans-serif';
const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BlockNotice — 체인에 남지 않는 거절의 기록</title><style>
*{box-sizing:border-box}html,body{margin:0;background:#DCE2E8;font-family:${FONT};word-break:keep-all;-webkit-print-color-adjust:exact;print-color-adjust:exact}.slide{position:relative;width:1920px;height:1080px;overflow:hidden;margin:32px auto;break-after:page}.slide:last-child{break-after:auto}.group{overflow:visible}.text{margin:0} @page{size:20in 11.25in;margin:0}@media print{html,body{background:white}.slide{margin:0}} </style></head><body>${slides.map((s,i)=>`<section class="slide" aria-label="${esc(s.name)}" data-page="${i+1}" style="background:${s.bg}">${s.children.map(n=>render(n)).join('')}</section>`).join('\n')}</body></html>`;
fs.writeFileSync(path.join(__dirname,'pitch.ko.html'),html);
fs.writeFileSync(path.join(__dirname,'pitch.ko.scene.json'),JSON.stringify({width:1920,height:1080,font:'Apple SD Gothic Neo',repo,colors:C,slides},null,2)+'\n');
console.log(`한글 슬라이드 ${slides.length}장 생성.`);
