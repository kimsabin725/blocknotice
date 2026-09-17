# 금 RWA 상환 데모 대본 (5분)

준비: Node 22·Foundry를 PATH에 놓고 README 설치 명령, `npm run test:all`, `npm run typecheck`를 실행한다.
이번 시연은 MockGold를 사용하는 로컬 체인이다. 공개 Sepolia·Hoodi에는 기존 BlockNoticeLog가 배포되어 있다.
신규 MockGold·에스크로·인박스는 Sepolia에 배포했다. [공개 배포 기록](docs/public-deployment.md)을 보여주되
30개 로컬 시나리오를 공개망에서 실행한 것으로 발표하지 않는다. 최신 검증 수치는 README §8을 따른다.

## 0:00–0:45 · 문제와 대상

> 금 토큰을 상환하려고 잠갔는데 소식이 없습니다. 거래소가 넘기지 않았는지, 운영사가 판단하지 않았는지,
> 인도 기관이 멈췄는지 보유자는 구분하기 어렵습니다. BlockNotice는 각 구간의 기록과 기한을 공개 증거로 검증합니다.
> 상환 승인 약속이 아니라 기록하고 증빙할 의무를 다룹니다.
>
> 자기 키로 잠그거나 거래소 밖 키로 요청에 서명할 수 있는 보유자가 대상입니다.
> 서명할 키가 없는 커스터디얼 이용자는 직접 이용할 수 없습니다.

화면: README 첫 문단과 대상 표.

## 0:45–1:40 · 실제 실행

```bash
npm run scenarios -- --keep
npm run report
```

> 기존 로그·영수증 18개에 상환·인박스 12개를 더한 30개 장면을 실행합니다.
> 각 장면은 실행 전에 검사 항목과 기대 판정을 선언합니다. 공격 20개와 정상 10개를 대조합니다.
> 기한 경과는 로컬 블록을 당겨 재현합니다. 공개 테스트넷의 실제 이력과 구분합니다.

실행이 끝나면 `out/report.html`을 연다. 실패가 있으면 그대로 설명하고 성공으로 발표하지 않는다.
`--keep`은 Anvil만 남긴다. 기관 객체를 가진 시나리오 프로세스는 종료한다.

## 1:40–2:40 · 인박스: 거래소에서 멈춘 요청

리포트의 `attack.exchangeNotForwarded`를 연다.

> 보유자가 EIP-712 요청에 서명하면 제출 블록부터 거래소 시계가 시작됩니다.
> 거래소는 자기 토큰을 보유자 명의 에스크로로 전달하거나 자기 로그의 거절 기록을 증명해야 합니다.
> 전달 기한과 챌린지 응답창을 모두 넘긴 이 장면은 거래소 UNANSWERED입니다.
> 운영사 잠금이 생성되지 않았으므로 운영사 시계는 아직 시작하지 않았습니다.

JSON의 `report.inbox`, `report.requestId`를 아래 인수로 사용한다.

```bash
npm run verify -- --inbox <INBOX_ADDRESS> --request <REQUEST_ID> --rpc http://127.0.0.1:8611
```

`exchange.hop = OBLIGATION_UNMET`, `operator.hop = NOT_DUE`, 기관 접속 0회를 보여준다.
위반이 있는 명령의 종료 코드 1은 예상 결과다. 전달된 요청은 `--include-escrow`로 이후 홉을 연결할 수 있다.

## 2:40–3:40 · 에스크로: 반환과 잠금 유지의 차이

리포트의 `attack.redeemSilent`, `attack.courierSilent`, `honest.redeemDelivered`, `honest.disputeHoldsLock`을 보여준다.

> 직접 잠금 또는 인박스 전달이 운영사 시계를 시작합니다. 운영사 무응답을 finalize하면 토큰을 반환합니다.
> 인계를 증명한 뒤 인도 기관이 무응답이면 STALLED로 잠금을 유지합니다.
> 인도 기관 로그의 인도 주장, 보유자 확인 또는 이의 기간 경과가 소각 조건입니다.
> 보유자가 이의를 제기하면 잠금이 유지됩니다. 실제 금 인도를 증명했다는 뜻은 아닙니다.

```bash
# out/attack.courierSilent.json의 report.escrow / report.lockId
npm run verify -- --escrow <ESCROW_ADDRESS> --lock <LOCK_ID> --rpc http://127.0.0.1:8611
```

공개 이벤트 재구성, 홉별 판정, 토큰 잔액을 보여준다. 오래된 인도 앵커를 늦게 증명해도
보유자는 증명 수락 블록부터 전체 이의 기간을 갖는다.

## 3:40–4:20 · 공개 증거와 재현

```bash
npm run check:deployment
npm run check:escrow -- sepolia # SEPOLIA_RPC_URL 설정 필요, 키는 불필요
```

> 기존 Sepolia·Hoodi 로그의 chainId, 코드 존재, 등록 서비스·서명자·프로필을 공개 RPC에서 되읽습니다.
> 기존 검사기는 로컬 빌드와 런타임 해시까지 비교하지는 않습니다.
> 새 deploy:escrow 도구는 로그·토큰·에스크로·인박스와 거래소·운영사·인도 기관 프로필을 별도 기록합니다.
> check:escrow는 그 기록의 불변 값과 런타임 코드 해시를 다시 대조합니다.

신규 로컬 배포 재현 명령은 README를 따른다. RPC 장애는 검증 실패로 보여준다.

## 4:20–5:00 · 보증 범위

> 준비금, 물리적 인도, 제한 사유의 진실성은 증명하지 않습니다.
> 판단 결과와 사유는 비공개 다이제스트지만 주소·수량·반환·소각은 공개입니다.
> STALLED와 DISPUTED에는 관리자 강제 해제 경로가 없고 오프체인 해결이 필요합니다.
> 기관이 사라져도 남는 공개 기록으로 어느 구간이 멈췄는지 확인하는 것이 이번 구현입니다.

녹화 전에는 실제 실행 결과, 리포트, 발표 PDF가 같은 커밋 기준인지 확인한다.
화면에 개인키·환경 파일·개인정보를 노출하지 않는다. 영상 녹화 자체는 별도 제출 작업이다.
