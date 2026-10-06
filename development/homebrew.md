# Homebrew

설치 목록은 Brewfile이 기준이다.

- [`Brewfile`](../Brewfile): 모든 기기 공통 (기본 CLI, 원격 접속)
- [`Brewfile.main`](../Brewfile.main): 메인 개발기 추가분 (런타임, 컨테이너, 에이전트, 앱, App Store 앱, VS Code 확장 등)

## 추가·삭제

```sh
brew install <이름>              # 설치하고
# Brewfile(.main)에 한 줄 추가
./bootstrap.sh snapshot         # 빠진 게 없는지 확인
```

지울 때는 `brew uninstall` 후 Brewfile에서도 지운다.

## 동작 방식

- `homebrew` 단계는 `brew bundle --no-upgrade`로 설치한다. 이미 깔린 건 업그레이드하지 않으므로 다시 실행해도 아무것도 바뀌지 않는다. 업그레이드는 따로 `brew upgrade`.
- 한 항목이 실패해도 다음 단계로 넘어간다. 빠진 항목은 `doctor`가 보여준다.
- `trusted: true`는 Homebrew 공식이 아닌 tap의 항목을 설치하도록 허용하는 표시다.
- 설치 순서: tap → brew/cask → mas, cargo, uv, vscode. 그래서 `cargo` 항목은 `brew "rust"`가 깔린 뒤에 처리된다.

## 기존 앱 옮기기

Brewfile에 있는 앱을 이미 직접 설치해 둔 기기에서는 `brew bundle`이 "이미 앱이 있다"며 실패한다. Homebrew 관리로 옮기려면:

```sh
brew install --cask --adopt <이름>
```

설치된 앱과 버전이 달라서 adopt가 안 되면, 앱을 종료한 뒤 `--force`로 덮어쓴다. 앱 데이터(`~/Library`)는 그대로 남는다.

지금 Mac mini에서 아직 옮기지 않은 앱 (2026-10-06): ChatGPT, Claude, Discord, Figma, Google Chrome, Paseo, Rectangle, Tailscale, Visual Studio Code. App Store 앱(KakaoTalk, Numbers Creator Studio)은 이미 App Store 관리라서 그대로 된다.
