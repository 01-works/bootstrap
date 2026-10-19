# 첫 부팅

자동화할 수 없는 것들. 끝나면 [README](../README.md)의 터미널 단계로 넘어간다.

## 설정 도우미

- [ ] 언어·지역: 한국어, 대한민국
- [ ] Wi-Fi 또는 이더넷 연결
- [ ] Apple 계정 로그인
- [ ] FileVault 켜기. 복구 키를 Apple 계정에 맡길지 따로 보관할지 정하기
- [ ] 위치 서비스, 분석 정보 공유: 원하는 대로
- [ ] Touch ID (해당 키보드가 있을 때)

## 데스크톱에 들어와서

- [ ] 소프트웨어 업데이트 최신으로
- [ ] 컴퓨터 이름: 시스템 설정 > 일반 > 정보 (SSH·Tailscale에서 이 이름으로 보인다)
- [ ] 늘 켜두는 기기라면: 시스템 설정 > 일반 > 공유에서 원격 로그인, 화면 공유 켜기 ([system-settings.md](system-settings.md))

## bootstrap 이후

로그인·권한은 기기마다 새로 한다. 다른 기기에서 복사하지 않는다.

- [ ] `auth` 단계가 마지막에 보여 주는 로그인 목록 처리
- [ ] Paseo 앱에서 데몬 초기 설정 후 `./bootstrap.sh --only paseo`
- [ ] 에이전트 Chrome(Chrome Beta)에서 에이전트가 쓸 서비스에 로그인 ([브라우저 작업](../agents/browser.md)). 노트북은 먼저 `launchctl kickstart gui/$(id -u)/local.bootstrap.agent-chrome`
- [ ] 노트북에서도 Paseo를 로그인 시 띄우고 싶으면 시스템 설정 > 일반 > 로그인 항목에 Paseo 추가 (데스크톱은 자동)
- [ ] 개인 Chrome 설정이 대기로 남았다면 Chrome을 종료하고 `./bootstrap.sh --only browser`. 개인 Chrome은 요청할 때만 연결되며, 그때 뜨는 허용 창은 직접 승인
- [ ] 네이티브 GUI 작업이 필요하면 [Computer Use 활성화·권한 설정](../agents/computer-use.md)
- [ ] 새 터미널에서 `./bootstrap.sh doctor`: 실패·수동 작업 대기 없이 완료 확인
- [ ] 로그아웃했다가 다시 로그인 (다크 모드 같은 시스템 설정 완전 반영)
- [ ] 트랙패드가 있다면 세 손가락 드래그 동작 확인 ([설정·미반영 시 확인 방법](system-settings.md#세-손가락-드래그))
- [ ] 이번에 막혔던 부분을 이 문서나 스크립트에 반영
