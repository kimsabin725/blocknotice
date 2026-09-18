# 구현·제출 자료 현황

2026-09-17 · [kimsabin725/blocknotice](https://github.com/kimsabin725/blocknotice) `39139b9`에서 확장.
개발은 포크 [tnwjd023-boop/BlockNotice_GoldRWA](https://github.com/tnwjd023-boop/BlockNotice_GoldRWA)에서 진행했고,
**2026-09-18 원본 저장소 `main`에 병합했다**(`beb4c5d`). 제출 대상은 원본 저장소다.
최초 문서 정리 범위에서 사용자 요청에 따라 **에스크로·인박스 전체 개발**로 확대했다.

## 구현

| 구성 | 결과 |
|---|---|
| `RedemptionEscrow` | 직접 잠금·대리 잠금, 운영사·인도 기관 시계, 반환·소각·이의 |
| `RedemptionInbox` | EIP-712 요청, 거래소 원자적 전달, 거절 포함증명, 챌린지·무응답 |
| 독립 검증 | 한 블록에 조회 고정, 서비스 로그와 상태 전이 재구성, 홉별 판정, 인박스→에스크로 연결 |
| CLI | 기존 번들 검증 + `verify --escrow` + `verify --inbox --include-escrow` |
| 배포 도구 | 명시적 네트워크·chainId 확인, 별도 기록·트랜잭션 저널, 재배포 충돌 방지 |
| 배포 대조 | 읽기 전용 서비스·불변 값·프로필·영수증·런타임 해시 검사 |
| 제출 자료 | [README](../README.md), [상세 사양](redemption-design.md), [5분 대본](../DEMO.md), [12장 PDF](../deck/BlockNotice_GoldRWA_pitch.pdf) |
| 재현 | 기존 18 + 상환·인박스 12 = 30개, 단일 HTML 리포트, GitHub Actions 워크플로 |

기존 `BlockNoticeLog.sol`, `deployments.json`, `src/profile.ts`, `src/deploy.ts`, `src/scenario.ts`,
`package-lock.json`은 원본을 유지했다. 기존 PDF는 역사 자료이며 최신 상환 PDF를 제출용으로 사용한다.
`out/` 증거·리포트와 로컬 도구·의존성은 커밋하지 않는다.

## 검증

환경: Windows, Node 22.23.2, Foundry 1.8.3, Solidity 0.8.28.
최종 개수는 README §8과 명령 출력이 기준이다.

- Solidity 107개: 기존 로그 32 + 에스크로 39 + 인박스 36. 각 퍼즈 테스트 256회.
- TypeScript 단위·실제 Anvil 통합 테스트, `tsc --noEmit` 검증.
- 실제 체인 데모 30개 기대 판정 일치. 공격 20개, 정상 10개 오탐 0.
- 새 로컬 배포와 인박스 포함 대조 완료. 이후 전용 지갑으로 Sepolia 공개 배포·대조도 완료했다. [공개 배포 기록](public-deployment.md) 참조.
- 기존 Sepolia·Hoodi 로그 대조: 각 5개 검사, 런타임 8,056바이트.
- PDF 12장 번호·영역 넘침 검사와 주요 슬라이드 육안 확인.

계약 리뷰는 토큰 납부자·보유자 권한, EIP-712 도메인·재사용, 원자적 전달과 승인 정리,
기한·거절 포함증명·재진입을 확인했다. 검증기 리뷰에서 발견한 모순된 증거·미래 이벤트·필수 반환 이벤트 누락과
잘못된 전달 잠금 연결을 보완했다. 잠금 도우미는 사전 nonce 예측 대신 실제 영수증의 잠금 ID를 사용한다.

## 남은 운영·제출 단계

실물 상환 운영 검증과 외부 보안 감사는 수행하지 않았다.
데모 영상은 2026-09-18 녹화했다(2분 48초). 뒷부분 78초는 대본 낭독이 아니라
`forge test`·공개 RPC 대조·시나리오 리포트·Sepolia 익스플로러를 실제로 띄운 화면 녹화다.
MockGold는 누구나 발행 가능한 데모 토큰이다. 세 서비스의 배포 도구는 한 지갑이 통제하는 구성임을 기록한다.
실물 준비금·물리적 인도·거절 사유의 진실성은 보증하지 않는다. STALLED·DISPUTED에는 관리자 임의 해제 경로가 없다.
