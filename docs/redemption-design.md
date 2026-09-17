# 금 RWA 상환 확장 설계

2026-09-17 · 구현 사양 · **에스크로·인박스 Sepolia 배포 완료** · [주소와 검증](public-deployment.md)

기준은 작업 폴더의 「BlockNotice_금 RWA 상환 기획안」 §9·§10과 원본 저장소 커밋 `39139b9`다.
기획안에서 출발해 이의 기간·인계 기한·토큰 전송 검사를 보완했다. 마지막 절에 반영한 결정과 남은 한계를 적었다.
현재 구현은 해커톤 데모이며 외부 보안 감사나 실물 상환 운영 검증을 거친 배포물이 아니다.

## 목적과 범위

금 RWA의 잠금 이후 운영사 판단·인계·인도 주장이 어느 주체의 기한 안에 기록됐는지 검증한다.
1차 대상은 자기 키로 잠글 수 있는 보유자·기관이다. 실제 준비금, 물리적 인도, 제한 사유의 진실성,
상환 적격성 판단의 타당성, 법적 강제력은 보증하지 않는다.

| 구성 | 역할 | 이번 제출본 |
|---|---|---|
| `BlockNoticeLog` | 기관별 append-only 로그·공개 루트 | 기존 구현·배포 유지 |
| `RedemptionEscrow` | 잠금, 운영사·인도 기관의 두 시계, 반환·소각 | 구현·Foundry 테스트 |
| `MockGold` | 18 decimals, 최소 ERC-20, 데모용 mint·burn | 구현·로컬 실행 |
| `RedemptionInbox` | 거래소 지갑 이용자의 서명 요청·거래소 시계 | 구현·Foundry 테스트 |
| 오프체인 검증기 | 이벤트로 홉별 판정, 원문 개봉은 별도 검사 | `src/escrow-verify.ts`, 기존 검증 경로 유지 |

신규 Solidity는 0.8.28이며 외부 의존성을 추가하지 않는다. 기존 로그·`deployments.json`·
`demo-exchange` 식별자와 `src/scenario.ts`는 유지한다. 운영사와 인도 기관은 별도 서비스를 사용한다.

## 세 시계

| 홉 | 시작 블록 | 요구 기록 | 무응답 확정 후 |
|---|---|---|---|
| 거래소 | 서명 요청의 인박스 제출 | 인박스가 생성한 잠금 또는 거절 기록 | 거래소 `UNANSWERED`, 운영사 시계 미시작 |
| 운영사 | 토큰 잠금 | 판단 기록, 승인 시 인계 기록 | 판단 챌린지 `UNANSWERED`, 토큰 반환 |
| 인도 기관 | 인계 리프의 앵커 | 자기 로그의 인도 주장 | 인도 기관 `UNANSWERED`, `STALLED`, 잠금 유지 |

판단이 기록됐지만 인계가 없으면 인계 기한 후 `reclaim`한다. 이는 운영사 무응답 챌린지와 다른 경로다.
`UNANSWERED`는 응답창이 지난 뒤 누구나 호출할 수 있는 `finalize`에서 확정한다.

## 생성자와 불변 프로필

| 이름 | 타입 | 값·의미 |
|---|---|---|
| `log` | `IBlockNoticeLog` | 읽기 전용 로그 참조 |
| `token` | `IBurnableERC20` | 데모 MockGold, `burn(uint256)` |
| `operatorServiceId` | `bytes32` | 판단·인계 로그 |
| `courierServiceId` | `bytes32` | 인도 로그 |
| `decisionBlocks` | `uint64` | 잠금 → 판단, 데모 20 |
| `handoffBlocks` | `uint64` | 잠금 → 인계, 데모 40 |
| `courierBlocks` | `uint64` | 인계 앵커 → 인도, 데모 60 |
| `responseBlocks` | `uint64` | 챌린지 → 응답, 데모 30 |
| `disputeBlocks` | `uint64` | 인도 증명 수락 블록 → 이의, 데모 30 |
| `profileHash` | `bytes32` | 아래 필드 전체의 해시 |

```solidity
keccak256(abi.encode(
    block.chainid, address(this), log, token,
    operatorServiceId, courierServiceId,
    decisionBlocks, handoffBlocks, courierBlocks, responseBlocks, disputeBlocks
))
```

생성자는 `getService(id).exists`, 서로 다른 serviceId, 실제 컨트랙트인 log·token,
양수 기한, `handoffBlocks >= decisionBlocks`와 생성 시점 기한 합계의 uint64 범위를 검사한다.
기한은 법적 기간이 아닌 Anvil 시연용 블록 수다. 기존 `demo-sla-v1`의 판단·응답 간격과 일치한다.
기존 로그의 서비스 프로필과 신규 에스크로의 프로필은 별도 값이다. 기존 프로필 해시를 변경하거나
등록만으로 신규 다섯 기한이 검증된다고 가정하지 않는다.

## 결과 비공개와 리프 호환

결과 코드 ALLOW / DENY / DEFER 및 사유 분류를 체인에 평문으로 올리지 않는다.
보유자는 암호화 전달된 원문과 salt로 다이제스트를 개봉한다.

```solidity
lockId = keccak256(abi.encode(
    block.chainid, address(this), holder, requestHash, nonces[holder]++
));
leaf = log.decisionLeaf(key, digest);
// H(0x00 || keccak256(abi.encode(uint8(2), key, digest)))
```

| 기록 | 서비스 | key | digest |
|---|---|---|---|
| 판단 | 운영사 | `lockId` | `keccak256(abi.encode(outcome, category, reasonCommit, salt))` |
| 인계 | 운영사 | `keccak256(abi.encode(uint8(3), lockId))` | `keccak256(abi.encode(courierServiceId, handoffCommit, salt))` |
| 인도 | 인도 기관 | `keccak256(abi.encode(uint8(4), lockId))` | `keccak256(abi.encode(deliveryCommit, salt))` |

오프체인 인코딩에서 outcome은 `uint8`, category·reasonCommit·각 commit·salt·serviceId는 `bytes32`다.

키의 태그로 판단·인계·인도를 분리한다. `lockId`가 기존 DEC 리프의 `acceptedDigest` 자리를 차지한다.
다른 lockId의 판단, 인계 리프를 판단으로 제시하는 증명, 운영사 로그로 제시한 인도 증명은 수락하지 않는다.
인도 주장은 별도의 서명 인수가 아니라 인도 기관 서비스의 등록된 운영자가 보낸 append 트랜잭션에 귀속된다.

DENY는 인계하지 않는 것으로 표현한다. DEFER도 별도 상태가 없으며 인계 기한 안에 검토를 끝내야 한다.
반환 사유의 구분은 감추지만, **보유자·수량·소각·반환 자체는 공개**된다.

## 저장 구조와 기한

```solidity
enum State {
    NONE, LOCKED, OP_CHALLENGED, DECIDED, HANDED_OFF,
    COURIER_CHALLENGED, DELIVERED, BURNED, RETURNED, STALLED, DISPUTED
}
struct Lock {
    address holder;
    uint128 amount;
    bytes32 requestHash;
    uint64 lockBlock;
    uint64 handoffAnchorBlock;
    uint64 deliveryAnchorBlock;
    uint64 deliveryProvenBlock;
    uint64 responseDueBlock;
    State state;
}
mapping(bytes32 => Lock) public locks;
mapping(address => uint256) public nonces;
```

조회식은 `decisionDue = lockBlock + decisionBlocks`, `handoffDue = lockBlock + handoffBlocks`,
`courierDue = handoffAnchorBlock + courierBlocks`, `disputeDue = deliveryProvenBlock + disputeBlocks`다.
응답·이의는 `block.number <= due`까지, 챌린지·확정·기한 후 소각·회수는 `block.number > due`부터다.

## 함수와 상태 전이

모든 증명 함수의 공통 인수는 `(lockId, digest, index, root, siblings)`다.

| 함수 | 호출자 | 허용 상태 | 검사·효과 |
|---|---|---|---|
| `lock(amount, requestHash)` | 보유자 | 신규 | 양수 수량, transferFrom 성공 → `LOCKED` |
| `lockFor(holder, amount, requestHash)` | 납부자 | 신규 | 호출자 토큰으로 잠금, 보유자에게 반환·이의·수령 확인 권한 부여 |
| `proveDecision` | 누구나 | `LOCKED`, `OP_CHALLENGED` | 운영사 포함증명, 챌린지 중 응답창 확인 → `DECIDED` |
| `proveHandoff` | 누구나 | `DECIDED` | 인계 기한 이내 제출 + 운영사 포함증명 → `HANDED_OFF` |
| `proveDelivery` | 누구나 | `HANDED_OFF`, `COURIER_CHALLENGED` | 인도 기관 포함증명, 챌린지 중 응답창 확인 → `DELIVERED` |
| `challenge(lockId)` | 보유자 | `LOCKED`, `HANDED_OFF` | 해당 홉 기한 경과 → 해당 챌린지 상태 |
| `finalize(lockId)` | 누구나 | 두 챌린지 상태 | 응답창 경과 → 운영사는 `RETURNED`, 인도 기관은 `STALLED` |
| `reclaim(lockId)` | 보유자 | `DECIDED` | 인계 기한 경과 → 토큰 반환, `RETURNED` |
| `acknowledge(lockId)` | 보유자 | `DELIVERED`, `DISPUTED` | 수령 확인 → 소각, `BURNED` |
| `dispute(lockId)` | 보유자 | `DELIVERED` | 이의 기간 안 → `DISPUTED`, 잠금 유지 |
| `burn(lockId)` | 누구나 | `DELIVERED` | 이의 기간 경과 → 소각, `BURNED` |

상태도는 [README §5](../README.md#5-상태-기계)에 있다. `RETURNED`·`BURNED`는 종료 상태다.
`STALLED`의 자동 해제 경로는 없다. `DISPUTED`는 보유자의 `acknowledge`로만 소각할 수 있다.

포함증명은 기존 로그의 `respond`와 같은 깊이 32의 순서 보존 머클 증명이다.
`rootInfo(serviceId, root).blockNumber != 0`, `index < size`, `siblings.length == 32`를 확인하고,
`H(0x01 || left || right)`로 계산한 루트가 일치해야 한다. 앵커 블록은 해당 `rootInfo.blockNumber`다.
`late`는 해당 증명의 앵커가 그 홉의 기한보다 늦은지를 표시하며 최종 판정과 별도로 남긴다.
토큰 반환·소각 전에 상태를 변경하는 checks-effects-interactions와 전체 변경 함수에 재진입 잠금을 적용한다.
입금은 에스크로 잔액 증가, 반환은 양쪽 잔액 변화, 소각은 에스크로 잔액·공급량 감소를 정확한 수량과 대조한다.
실패 시 상태·nonce·토큰 변경은 모두 롤백한다. 수수료 차감·리베이스·비표준 ERC-20은 지원 대상이 아니다.

## 이벤트·에러와 독립 검증

구현 이벤트:

- `Locked(lockId, holder, amount, requestHash)`
- `DecisionProven(lockId, leaf, root, index, late)` 및 동일 증명 필드의 `HandoffProven`, `DeliveryProven`
- `ChallengeOpened(lockId, hop, responseDueBlock)`, `ChallengeUnanswered(lockId, hop)`
- `Returned(lockId)`, `Disputed(lockId)`, `Burned(lockId, byAck)`

구현 에러: `ZeroAmount`, `UnknownLock`, `WrongState`, `NotHolder`, `NotYetDue`, `ResponseWindowOver`,
`ResponseWindowOpen`, `DisputeWindowOver`, `UnknownRoot`, `IndexOutOfRange`, `BadProofLength`,
`BadInclusionProof`, `UnknownService`, `BadProfile`, `BadAnchorOrder`, `HandoffWindowOver`,
`TokenTransferFailed`, `UnsupportedToken`, `ReentrantCall`.

체인에 고정된 프로필·서비스를 신뢰 기준으로 읽고, 에스크로 이벤트와 두 서비스의 `Appended` 이벤트로
타임라인을 재구성한다. 기관 API는 호출하지 않는다. 이벤트의 블록 번호와 호출 순서까지 보존한다.
`Returned` 이전 `ChallengeUnanswered` 유무로 `finalize` 반환과 `reclaim` 반환을 구분한다.

| 상태·근거 | 운영사 홉 | 인도 기관 홉 |
|---|---|---|
| `LOCKED`, 판단 기한 전 | `NOT_DUE` | 미시작 |
| `OP_CHALLENGED`, 응답창 중 | `NOT_DUE` | 미시작 |
| `RETURNED`, 운영사 `ChallengeUnanswered` 있음 | `OBLIGATION_UNMET` | 미시작 |
| `DECIDED` / `RETURNED` via reclaim | 기록 `CONFIRMED`, 판단의 타당성 `OUT_OF_SCOPE` | 미시작 |
| `HANDED_OFF`, 인도 기한 전 | `CONFIRMED` | `NOT_DUE` |
| `COURIER_CHALLENGED`, 응답창 중 | `CONFIRMED` | `NOT_DUE` |
| `STALLED` | `CONFIRMED` | `OBLIGATION_UNMET` |
| `DELIVERED`, `BURNED` | `CONFIRMED` | 기록 `CONFIRMED`, 실제 인도 `OUT_OF_SCOPE` |
| `DISPUTED` | `CONFIRMED` | 기록 `CONFIRMED`, 분쟁 `OUT_OF_SCOPE` |
| 원문 없음 | 개봉 검사만 `UNVERIFIABLE` | 기록 증명 판정은 유지 |

기한만 지났지만 챌린지가 열리지 않았거나 아직 `finalize`가 없다면 무응답 확정으로 표시하지 않는다.
기한 전·응답창 중만 `NOT_DUE`이며, 그 밖의 미확정 의무 판정은 `UNVERIFIABLE`과 필요한 다음 호출을 표시하는
방식으로 판정한다. 검사 id는 `operator.hop`, `courier.hop`이며 온체인 상태와 이벤트 재구성이 불일치해도 `UNVERIFIABLE`이다.
원문 부재가 유효한 온체인 기록을 지우거나 위반을 만들어서는 안 된다.

## 상환 검증 시나리오

| 시나리오 | 기대 결과 |
|---|---|
| `attack.redeemSilent` | 운영사 무응답 확정, 토큰 반환 |
| `attack.redeemAnswerWithOtherLock` | 다른 lockId 증명 거부 |
| `attack.redeemEarlyChallenge` | `NotYetDue` |
| `attack.burnWithoutDelivery` | `WrongState` |
| `attack.deliveryFromOperatorLog` | 인도 기관 서비스와 일치하지 않는 증명 거부 |
| `attack.reclaimAfterHandoff` | `WrongState` |
| `attack.courierSilent` | 운영사 확인, 인도 기관 무응답, `STALLED` |
| `honest.redeemDenied` | 판단 기록 후 인계 없음, 기한 후 반환, 오탐 없음 |
| `honest.redeemDelivered` | 인도 기록과 이의 기간 후 소각 |
| `honest.lateButRecorded` | 응답창 내 늦은 판단, `late`, 위반 확정 아님 |
| `honest.disputeHoldsLock` | `DISPUTED`, 일반 burn 거부, 분쟁 범위 밖 |
| `attack.exchangeNotForwarded` | 거래소 무응답, 운영사 시계 미시작 |

Foundry에서는 수량·이벤트, 다른 lockId, 태그 분리, 잘못된 서비스, 보유자 권한, 각 기한의 경계 블록,
응답창 후 거부, 반환 잔액, 소각 잔액, 이의 후 ACK, 프로필 도메인 분리, 레퍼런스 트리 퍼즈를 검사한다.
위 12개 상환·인박스 시나리오는 `npm run demo`에 포함한다. 에스크로 가스는
`forge test --gas-report --match-contract RedemptionEscrowTest`로 측정한다. 최신 합계와 실측값은 README §8에 둔다.

## 거래소 인박스

생성자 `(log, escrow, forwardBlocks, responseBlocks)`는 데모에서 20·30블록을 사용한다.
`profileHash = keccak256(abi.encode(chainId, inbox, log, escrow, forwardBlocks, responseBlocks))`이며,
토큰은 고정된 에스크로의 토큰이다. 인박스와 에스크로의 로그가 일치해야 한다.

EIP-712 도메인은 name `RedemptionInbox`, version `1`, chainId, verifyingContract다.
서명 구조체는 다음과 같다.

```text
Request(address holder,bytes32 exchangeServiceId,uint128 amount,bytes32 requestHash,uint256 nonce,uint64 expiresAtBlock)
```

`submit(request, signature)`은 누구나 전달할 수 있지만 보유자 서명, 등록 거래소, 양수 수량,
만료 블록과 보유자별 nonce 재사용을 검사한다. `requestId`는 EIP-712 다이제스트다.
제출 시 거래소 운영자와 블록을 저장한다. 원문의 단순 해시와 서명 요청 식별자를 혼동하지 않는다.

| 함수 | 권한·전이 |
|---|---|
| `forward(requestId)` | 저장된 거래소 운영자만. 거래소 → 인박스 → 에스크로 전송을 한 트랜잭션으로 실행, `FORWARDED` |
| `proveRejection(id,digest,index,root,siblings)` | 누구나. 거래소 로그의 해당 요청 거절 포함증명, `REJECTED` |
| `challenge(requestId)` | 보유자만. 제출+forwardBlocks 경과 후 `SUBMITTED` → `CHALLENGED` |
| `finalize(requestId)` | 누구나. 응답창 경과 후 `CHALLENGED` → `UNANSWERED` |

전달은 거래소가 인박스에 승인한 자기 토큰을 사용한다. 인박스는 정확한 수량만 에스크로에 승인하고
`lockFor(holder, amount, requestHash)`를 호출한 뒤 승인을 지운다. 반환·이의·수령 확인 권한은 보유자에게 있다.
일부 전송이나 잠금이 실패하면 전체 전달이 되돌아간다. 제3자가 직접 만든 선물 잠금은 요청을 완료시키지 않는다.
인박스가 원자적으로 생성하고 저장한 `lockId`만 연결된다.

거절 키는 `keccak256(abi.encode(uint8(5), requestId))`이며 기존 DEC 리프 인코딩을 사용한다.
앵커는 제출 블록 이후여야 한다. 최초 기한 후 제출된 전달·거절에는 `late`를 남기며,
챌린지 이후에는 응답 기한까지만 허용한다. `UNANSWERED`는 종결 상태다.
전달되지 않은 요청은 운영사 시계를 시작하지 않는다.

`src/inbox-verify.ts`는 한 블록에 조회를 고정하고 제출·전달·거절·챌린지를 재구성해 저장 상태와 대조한다.
전달 이후 운영사·인도 기관 판정은 `verify --inbox ... --include-escrow`로 연결한다.
거래소 밖의 서명키가 필요하며 passkey 검증·paymaster는 이번 범위에 없다.

## 설계 검토와 반영

1. **이의 기간 보장:** `deliveryProvenBlock`을 추가했다. 오래된 인도 앵커를 늦게 증명해도 수락 블록부터
   30블록의 이의 기간을 전부 보장한다. 앵커 블록은 인도 기한 지각 판단에 별도로 사용한다.
2. **인계·회수 경쟁 제거:** `proveHandoff` 제출은 `block.number <= handoffDue`까지만 허용한다.
   이후에는 늦은 증명으로 회수를 막을 수 없다. `reclaim`은 로그 전체의 부재를 증명하는 함수가 아니다.
   운영사는 에스크로가 `HANDED_OFF`인 것을 확인한 뒤 실물 지시를 해야 한다.
3. **시간 순서·루트 선택:** 판단·인계 앵커는 잠금 이후, 인도 앵커는 인계 앵커 이후여야 한다.
   시계는 제출자가 선택한 공개 루트 블록을 사용한다. 최초 포함 블록을 강제하지 않으므로 나중 루트 선택은
   더 늦은 앵커로 기록될 수 있다. 인계 증명 제출 기한이 그 이동 범위를 제한하고, 인계 이후 시계는 고정된다.
4. **프로필 신뢰:** 동일 serviceId·0 기한·잘못된 컨트랙트 주소를 거부한다. 별도 배포 검사기는 모든 불변 값과
   서비스 소유자·서명자·런타임 해시를 기록과 대조한다. 서로 다른 serviceId가 경제적 독립성·비공모를 보증하지 않는다.
5. **토큰 신뢰:** 정확한 잔액·공급량 변화와 재진입 방지를 검사하지만, 토큰 구현 자체의 악의를 증명하거나
   업그레이드 가능한 토큰의 미래 동작을 보증하지 않는다. MockGold는 누구나 발행 가능한 시연용이다.
6. **교차 서비스 거부:** 운영사 전용 루트의 인도 증명은 `UnknownRoot`, 알려진 루트에 잘못된 리프를 제시하면
   `BadInclusionProof`다. 원 기획의 단일 에러 기대값을 실제 검증 순서에 맞췄다.
7. **남은 외부 확인:** 대회 제출 후 커밋 반영 여부는 별도다. 전용 테스트넷 지갑으로 Sepolia 배포를 완료했다.
   실물 상환 운영·법적 집행 검증이나 외부 보안 감사를 마쳤다는 주장은 하지 않는다.
