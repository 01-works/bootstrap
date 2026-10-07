# Mac mini (M4)

지금의 메인 개발기. 프로필: `main`. 이 기기에만 해당하는 사실은 이 문서에만 적는다.

## 사양

| 항목 | 값 |
|---|---|
| 모델 | Mac mini, Mac16,10 |
| 칩 | Apple M4 |
| 메모리 | 16GB |
| 저장 공간 | 256GB |
| macOS | 26.5.1 (2026-10-06 기준) |

## 역할

늘 켜두고 원격으로도 붙는 기기. 전원·원격 접속 설정은 [macos/system-settings.md](../macos/system-settings.md) (`main` 프로필의 `power` 단계).

정전 후 자동으로 켜지는 설정(`pmset autorestart`)은 꺼져 있다. 켜더라도 FileVault 잠금을 풀어야 원격으로 쓸 수 있으므로, 재부팅 후 원격으로 잠금 해제가 되는지 한 번 확인해 둘 것.

## 겪은 문제

- 메모리 16GB와 저장 공간 256GB가 둘 다 부족하다 (수치는 [buying-guide.md](buying-guide.md)). 다음 기기는 둘 다 올릴 것.

## 이 기기에만 있는 것

저장소 설정에는 넣지 않고 이 기기에서만 쓰는 것. `./bootstrap.sh snapshot`에 "Brewfile에 없음"으로 나와도 지우지 않는다.

- Hermes가 쓰는 것: Homebrew `node`, `ffmpeg`, `ripgrep`, `~/.local/share/uv`의 Python 3.11
- gws (googleworkspace-cli)
- 앱: Chrome, VS Code, Figma, Discord, KakaoTalk, Numbers Creator Studio, Rectangle (직접 설치), LibreOffice (Homebrew)
- `~/.zshrc.local`: `vscode` 별칭
- `~/.ssh/config`: colima·conductor 설정과 github.com용 키 지정이 들어 있다. git은 https라 그 키는 쓰이지 않는다.

## Homebrew로 옮기지 않은 앱 (2026-10-07)

Brewfile에 있지만 이 기기에서는 직접 설치한 채로 둔 앱. 셋 다 스스로 업데이트한다. `doctor`가 "빠진 항목"으로 보여 주는 이유가 이것이다. 옮기는 방법은 [development/homebrew.md](../development/homebrew.md)의 "기존 앱 옮기기".

| 앱 | 옮기지 않은 이유 |
|---|---|
| ChatGPT | cask 다운로드가 일시적으로 실패했다 (하루쯤 뒤 다시) |
| Paseo | 지금 에이전트를 돌리는 데몬이라 다시 설치하면 작업이 끊긴다 |
| Tailscale | 다시 설치하려면 관리자 비밀번호가 필요하다 |
