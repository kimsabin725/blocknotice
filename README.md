# BlockNotice

**거절된 출금은 트랜잭션이 되지 않습니다. 그래서 기록이 기관 쪽에만 남습니다.**
BlockNotice는 승인·거절·보류 판단의 서명 영수증을 요청자에게 돌려주고, 기관이 서명한 접수 약속에 대한
기록 의무가 지켜졌는지를 **기관 서버 없이** 확인합니다.

> 설계·구현 진행 중인 해커톤 프로젝트입니다(TRUST404 트랙 3). 성능·고객 도입이 완료됐다는 보고가 아닙니다.

## 지금 되는 것 (2026-09-13, 1~2일차)

```bash
npm install
forge install foundry-rs/forge-std --no-git   # 최초 1회
forge build

npm run issue -- --case screening        # 합성 거절 1건 발행 → out/bundle-screening.json
npm run verify -- out/bundle-screening.json
npm run test:all                         # 컨트랙트 28개 + TS 39개
```

`npm run test:all`은 로컬 체인(anvil)을 띄워 컨트랙트를 배포하고, 로그를 **이벤트만으로 다시 세워**
컨트랙트가 보고한 루트와 일치하는지까지 확인합니다.

`issue`는 기관 시뮬레이터가 정책을 실행해 DENY/DEFER/ALLOW 영수증을 만들고, 요청자가 받는 묶음을 파일로 씁니다.
`verify`는 그 파일과(2일차부터는 공개 로그 루트와)만으로 판정합니다 — 기관 서버 접속 0회.

판정은 통과/실패로 뭉치지 않고 다섯으로 나옵니다:

| 상태 | 뜻 |
|---|---|
| 확인됨 CONFIRMED | 서명·바인딩·포함증명 등으로 확인됨 |
| 기한 미도래 NOT_DUE | 아직 의무 이행 기한 전 |
| 의무 미이행 OBLIGATION_UNMET | 서명한 의무가 지켜지지 않음 |
| 검증 불가 UNVERIFIABLE | 자료가 없어 판단할 수 없음(위반 아님) |
| 범위 밖 OUT_OF_SCOPE | 이 도구가 보증하지 않는 사실 |

앵커 상태도 `SIGNED_PENDING_ANCHOR`(서명만 받음)와 `ANCHORED`(공개 로그에 확정)로 구분합니다.

## 확인하는 것 / 확인하지 못하는 것

확인하는 것
1. **기록 무결성** — 보유한 영수증의 서명과 공개 커밋이 일치하는가.
2. **접수 책임** — 기관이 서명한 접수 약속의 기록 기한이 지켜졌는가.
3. **독립 제출** — 영수증을 못 받아도 요청자가 자기 제출 사실을 공개 경로에 남길 수 있는가(2일차 컨트랙트).

확인하지 못하는 것
1. **비공개 사유의 진실성** — 커밋은 교체를 탐지할 뿐, 내용이 참인지는 모릅니다.
2. **기관이 아무에게도 알리지 않은 판단** — 존재 자체를 발견하지 못합니다.
3. **오프체인 전달** — 요청자가 실제로 보냈는지는 어떤 컨트랙트도 증명하지 못합니다. 영수증 없는 공개 제출은
   위반이 아니라 중립 상태(PUBLIC_NOTICE)로 표시합니다.

## 공개 로그 컨트랙트 (`contracts/src/BlockNoticeLog.sol`)

컨트랙트는 **해시만** 저장합니다. 요청 내용도, 통지문도, 비공개 사유도 모릅니다.
루트는 제출받지 않고 **컨트랙트가 직접 계산**합니다 — 기관이 자기가 만들지 않은 트리의 루트를 올릴 수 없습니다.

| 함수 | 하는 일 |
|---|---|
| `registerService` | 기관 로그 등록. 마감 프로필 해시를 고정 |
| `appendBatch` | 리프 해시를 순서대로 추가, 루트 재계산 (운영자만) |
| `postNotice` | 영수증을 못 받은 요청자의 **중립** 공개 제출 — 위반 주장이 아님 |
| `challengeAccepted` | **기관이 서명한** 접수 영수증의 기한이 지났을 때만 증빙 요구 개시 |
| `respond` | 포함증명으로 응답. 늦게 기록된 경우 `late` 플래그가 남음 |
| `finalize` | 기한 내 무응답을 온체인 `UNANSWERED`로 확정 |

`challengeAccepted`는 기관 자신의 서명을 요구하므로 **없던 의무를 날조할 수 없고**, `postNotice`는
기관 서명이 없으므로 **위반으로 집계되지 않습니다**. 이 둘의 분리가 이 프로토콜의 핵심입니다.

## 구조

```
요청자 ──서명 요청(EIP-712) + HPKE 봉투──▶ 기관
        ◀── AcceptedReceipt(기록 기한 포함, 기관 서명) ──   REQ 리프 로그 기록
        ◀── DecisionRecord(암호화 전달, 기관 서명) ──        DEC 리프 로그 기록
        ── ACK(선택) ──▶
공개 로그: 순서 보존 append-only 머클 트리(깊이 32), 리프 = H(0x00‖H(타입‖다이제스트))
검증기: 파일 + 공개 로그 루트만으로 위 5분류 출력
```

- 서명: EIP-712 / secp256k1. 도메인에 chainId·verifyingContract·serviceId를 넣어 다른 배포·체인으로 재사용 불가.
- 암호화: HPKE(RFC 9180, DHKEM-X25519 + HKDF-SHA256 + AES-128-GCM). 서명키와 암호화키는 역할이 다릅니다.
- 비공개 사유: `keccak(detail ‖ ruleIds ‖ salt)` 커밋만 영수증에 들어가고, 개봉 자료는 **사건별로** 따로 보관합니다(전역 키 없음).
- 정책(`demo-policy-v1`)은 공개 fixture입니다. 검증기가 선언된 정책·입력으로 재실행해 결과가 재현되는지 봅니다.
  실제 입력의 진실성은 범위 밖입니다.

## 관련 작업과의 위치

Certificate Transparency(RFC 6962/9162)의 append-only 로그·포함증명, SCITT(RFC 9943)의 서명 진술→영수증 구조를
참고했습니다. 와이어 포맷 호환을 주장하지 않습니다. Arbitrum의 강제 포함은 설계상 참고했지만, BlockNotice가
강제하는 것은 **공개 게시와 관측 가능한 응답 절차**이지 외부 기관의 업무 실행이 아닙니다.

게이트 운영자 측 증거(ANAM145 SignTrail, Fireblocks 감사로그 등)가 운영자의 기록을 완성한다면,
BlockNotice는 **피결정자가 보유하는 쪽**의 기록을 다룹니다.

## 진행

- [x] 1일차 — 스키마·EIP-712 서명·커밋·HPKE 고정, 기관 시뮬레이터, 정책 fixture, 독립 검증기 CLI, 테스트 32개
- [x] 2일차 — `appendBatch` 컨트랙트(온체인 루트 계산·포함증명), 이벤트만으로 트리 독립 재구성
- [x] 3일차(선행) — `challengeAccepted` / `postNotice` / `respond` / `finalize` 구현·테스트 완료.
      남은 것은 **공개 테스트넷 배포 증적**뿐입니다.
- [ ] 4일차 — 필수 공격·정상 사례 전체, 한 명령 재현
- [ ] 5일차 — 얇은 화면, ACK
- [ ] 6일차 — README·위협 모델·영상

## 배포 (Ethereum Sepolia, chainId 11155111)

```bash
cp .env.example .env      # DEPLOYER_KEY 채우기
npm run deploy -- sepolia # 배포 + demo-exchange 서비스 등록 → deployments.json
```

Arbitrum Sepolia가 아니라 Sepolia를 쓰는 이유: 이 프로토콜의 판정은 전부 **블록 번호 기한**이고
(`respond` 마감 경계 테스트 포함), Arbitrum의 `block.number`는 L1 블록 번호의 근사치라 그 경계가
흔들립니다. 또 배치 크기별 append 가스를 정직하게 보고하려면 L1 calldata 비용이 섞이지 않아야 합니다.

AI 도구(Claude Code)를 사용해 구현 중이며, 최종 제출 시 주요 AI 생성 부분을 이 문단에 명시합니다.
