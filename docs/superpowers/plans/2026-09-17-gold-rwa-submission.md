# 금 RWA 상환 제출본 작업 계획

> 실행: 이 세션에서 순서대로 수행한다. 사용자 확정 범위는 제출 전 문구·README·에스크로 설계 정리다.

**목표:** 기존 실행 결과를 재현하면서 금 RWA 상환의 문제·대상·확장 설계를 제출 자료에 반영한다.

**구조:** 기존 BlockNoticeLog와 영수증 검증 경로를 유지한다. 신규 에스크로와 인박스는 별도 설계 문서로 설명하고 실행 기능과 구분한다.

**기술:** Solidity 0.8.28, Foundry, TypeScript, viem, 정적 HTML.

**명세:** 작업 폴더의 `BlockNotice_금 RWA 상환 기획안.md` §4·§6·§9·§10. 원본 기준 커밋 `39139b9`.

## 공통 제약

- `contracts/src/BlockNoticeLog.sol`, `deployments.json`, 기존 serviceId `demo-exchange` 유지.
- 결과 코드 ALLOW / DENY / DEFER와 사유 분류는 신규 상환 설계에서 공개하지 않는다.
- `src/scenario.ts`와 정책 입력 필드·판정 로직은 유지한다.
- 에스크로 구현·배포·신규 시나리오를 완료했다고 표기하지 않는다.
- 최초 범위에서 인박스는 2순위 설계였다. 후속 요청으로 에스크로·인박스 개발까지 확대했으며 최신 상태는 `2026-09-17-redemption-implementation.md`를 따른다.

## 1. 실행 환경과 기준 결과

- [x] 격리된 복제본 `blocknotice`, 브랜치 `feat/gold-rwa-submission`에서 작업.
- [x] 잠금 파일로 npm 의존성을 설치하고 작업 폴더에 Foundry를 준비.
- [x] Windows Anvil 실행 파일 탐색 문제를 재현하고 필요한 경우 최소 수정.
- [x] `forge test`, `npm test`, `npm run demo`의 결과를 기록.

## 2. 제출용 문구와 설계

- [x] `src/policy.ts`: 통지문 4곳을 상환으로 변경. R3는 일일 상환 한도.
- [x] `src/report.ts`: 문제 설명을 상환으로 변경, 장면 수를 실제 결과에서 표시.
- [x] `README.md`: §1 대상, §4 보증 범위, §5 두 홉 상태 기계, §7 델타, §8 실측 수치, §10 한계.
- [x] `docs/redemption-design.md`: 생성자·리프·기한·상태·검증기·인박스·구현 전 검토 항목.
- [x] `DEMO.md`, `deck/pitch.html`: 현재 실행 가능한 데모와 상환 확장 설계를 구분. 오래된 수치·주소도 저장소 기록과 일치시킴.
- [x] 기존 피치 PDF를 새 HTML과 혼동하지 않도록 버전 상태를 명시.

## 3. 검증과 인계

- [x] `npm run test:all`, `npm run demo` 실행 결과 확인.
- [x] `git diff --check`, 원본 로그·배포 파일 변경 여부 확인.
- [x] 실행 보고서와 남은 구현 항목을 `docs/submission-status.md`에 기록.
- [x] 로컬 파일 링크와 검증 결과를 사용자에게 전달.
