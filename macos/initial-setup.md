# 새 Mac 체크리스트

고를 것 없이 아래 값 그대로 진행한다. 로그인·권한은 기기마다 새로 하고 다른 기기에서 복사하지 않는다.

## 1. 첫 부팅 (설정 도우미)

- [ ] 언어·지역: 한국어, 대한민국
- [ ] Wi-Fi 또는 이더넷 연결
- [ ] Apple 계정 로그인
- [ ] FileVault: 노트북은 켜고 복구 키를 Apple 계정에 보관. 늘 켜두는 데스크톱은 켜지 않는다(정전 뒤 혼자 로그인까지 되도록 bootstrap이 자동 로그인을 켠다)
- [ ] 위치 서비스 켬, 분석 정보 공유 끔
- [ ] Touch ID: 지원 키보드가 있으면 등록
- [ ] 데스크톱에 들어오면 소프트웨어 업데이트 최신으로

## 2. 한 줄 설치

[README](../README.md#새-mac에서)의 한 줄을 터미널에 붙여 넣는다. 처음에 관리자 비밀번호를 한 번 묻고, 끝날 때 GitHub 로그인 코드를 클립보드에 복사해 브라우저를 연다. 데스크톱은 마지막에 자동 로그인을 켜면서 로그인 비밀번호를 한 번 더 묻는다.

## 3. 로그인

설치가 끝나면 로그인할 앱이 열린다. 다시 설치를 돌릴 필요는 없다.

- [ ] 터미널에서 `claude`, `codex`를 한 번씩 실행해 로그인 (`vercel login`, `cloudflared tunnel login`은 쓸 때)
- [ ] Claude 앱, ChatGPT 앱, Tailscale 앱 로그인. Tailscale은 설정에서 로그인 시 실행을 켠다
- [ ] Chrome Beta(에이전트 전용 창)에서 에이전트가 쓸 서비스 로그인 ([브라우저 작업](../agents/browser.md)). Dock 아이콘으로 새로 띄운 Chrome Beta는 전용 프로필이 아니니 열려 있는 창을 쓴다. 노트북에서 창이 없으면 `launchctl kickstart gui/$(id -u)/local.bootstrap.agent-chrome`

## 4. 화면 설정

새 터미널에서 `./bootstrap.sh doctor`를 실행하면 실패·대기 항목과 함께 아래 "직접 확인할 것"이 나온다.

- [ ] iCloud 사진·메시지 끄기: 시스템 설정 > Apple 계정 > iCloud
- [ ] 디스플레이: 시스템 설정 > 디스플레이에서 가장 작은 배율("더 많은 공간")
- [ ] 로그아웃했다가 다시 로그인 (다크 모드·세 손가락 드래그 반영, [확인 방법](system-settings.md#세-손가락-드래그))

늘 켜두는 기기(데스크톱)만:

- [ ] 원격 로그인·화면 공유 켜기: 시스템 설정 > 일반 > 공유. 외부에서는 Tailscale을 켠 기기에서 `vnc://<이 기기 Tailscale 이름>`으로 접속 ([원격 접속](system-settings.md#원격-접속))
- [ ] Tailscale 관리 콘솔 Machines에서 이 기기 Disable key expiry. 그대로 두면 180일 뒤 밖에서 붙을 수 없다
- [ ] Computer Use: Claude 앱 설정 > 이 컴퓨터에서 켜고, ChatGPT 앱 Plugins > Computer Use를 설치한다. 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용·화면 녹음에서 Claude와 Codex Computer Use를 허용한다 ([Computer Use](../agents/computer-use.md))

doctor가 실패·수동 작업 대기 없이 끝나고 위 항목을 처리했으면 완료다. 막혔던 부분은 이 문서나 스크립트에 반영한다.
