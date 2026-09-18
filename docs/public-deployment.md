# Sepolia 공개 배포

2026-09-17 · chainId **11155111** · 구현 커밋 `8022b41`의 계약을 배포했다.
전용 테스트넷 지갑: `0xD82DEbb00A73aC657eB9F56e2e2c861A29b0a7c6`.
기존 BlockNoticeLog를 재사용하고 새 토큰·에스크로·인박스와 세 서비스를 배포·등록했다.

> **세 역할은 이 배포에서 한 계정이다.** 운영사·인도 기관·거래소는 serviceId가 서로 다르지만
> operator·signer 주소는 위 지갑 하나다(`escrow-deployments.json`의 `commonControl: true`,
> `controlDisclosure`). 가스와 운영 편의 때문이며, **이 인스턴스만으로는 세 주체의 실제 분리를
> 보인 것이 아니다.** 역할 분리는 로컬 시나리오에서 서로 다른 계정으로 재현한다(README 한계 17번).

| 계약 | Sepolia 주소 | 배포 블록 |
|---|---|---|
| 기존 BlockNoticeLog | [0xa4d46da2bc8bd6c113e254424be1e78002af5504](https://sepolia.etherscan.io/address/0xa4d46da2bc8bd6c113e254424be1e78002af5504) | 11699494 |
| MockGold | [0xb3a791fbb0a2f5001375dd32b6fb621837955b1a](https://sepolia.etherscan.io/address/0xb3a791fbb0a2f5001375dd32b6fb621837955b1a) | 11723830 |
| RedemptionEscrow | [0x8c8cbf50a91ce2c6d0746d0c4745d3a8b8f7778c](https://sepolia.etherscan.io/address/0x8c8cbf50a91ce2c6d0746d0c4745d3a8b8f7778c) | 11723834 |
| RedemptionInbox | [0x870238b0be5d5835ff47de3510875c996c01bb5d](https://sepolia.etherscan.io/address/0x870238b0be5d5835ff47de3510875c996c01bb5d) | 11723835 |

토큰·서비스 등록 3건·에스크로·인박스의 총 6개 트랜잭션이 성공했다.
트랜잭션 해시, 서비스 ID, 프로필과 런타임 해시는 [escrow-deployments.json](../escrow-deployments.json)에 있다.
이번 배포에서 **0.005862233863798584 Sepolia ETH**를 사용했고, 직후 잔액은 **0.044137766136201416 ETH**였다.

## 검증

`npm run check:escrow -- sepolia`는 공개 RPC에서 체인 ID, 각 계약 코드·트랜잭션 영수증,
서비스 소유자·서명자·기한, 모든 불변 값과 재계산한 프로필 해시를 대조해 통과했다.

신규 계약 3개는 별도로 Sourcify에서 **exact_match** 소스 검증을 받았다.
아래는 조회 API 주소이며 `match`·`creationMatch`·`runtimeMatch`가 모두 `exact_match`로 나온다.
등록 당시의 작업(job) 주소가 아니라 지금도 같은 답을 주는 주소다.

| 계약 | Sourcify 조회 |
|---|---|
| MockGold | [11155111 / 0xb3a791fb…](https://sourcify.dev/server/v2/contract/11155111/0xb3a791fbb0a2f5001375dd32b6fb621837955b1a) |
| RedemptionEscrow | [11155111 / 0x8c8cbf50…](https://sourcify.dev/server/v2/contract/11155111/0x8c8cbf50a91ce2c6d0746d0c4745d3a8b8f7778c) |
| RedemptionInbox | [11155111 / 0x870238b0…](https://sourcify.dev/server/v2/contract/11155111/0x870238b0be5d5835ff47de3510875c996c01bb5d) |

소스 검증은 보안 감사가 아니다. 컴파일된 바이트코드가 공개된 소스와 같다는 것만 말한다.

읽기 전용 재검증에는 개인키가 필요 없다. Node·Foundry 설치 후 다음을 실행한다.

```bash
forge build
# .env에 SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com 설정
npm run check:escrow -- sepolia
```

기록된 완료 배포를 같은 명령으로 다시 배포하지 않는다. 배포 도구는 같은 네트워크의 완료 기록이 있으면 거부한다.

## 시연 범위

MockGold는 누구나 발행 가능한 데모 토큰이며 실물 금을 담보하지 않는다. 운영사·인도 기관·거래소 서비스는
별도 ID지만 이번 배포에서는 같은 지갑이 통제한다. 고정 기한은 에스크로 20/40/60/30/30블록,
인박스 20/30블록이다. 이번 공개 기록은 배포와 등록이다. README의 30개 가속 시나리오는 로컬 실행이며,
공개망에서 실물 상환이나 30개 전체 시나리오를 실행했다는 뜻이 아니다.

개인키는 gitignore 대상인 로컬 `.env`에만 보관하며 저장소·배포 기록·출력에 포함하지 않았다.
