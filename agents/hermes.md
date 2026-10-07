# Hermes

Nous Research의 에이전트. Homebrew 설치는 공식 미지원이라 공식 설치 스크립트로 직접 설치한다.

## 새 기기에서

[공식 설치 문서](https://hermes-agent.nousresearch.com/docs/getting-started/installation)를 따른다 (2026-10-07 확인).

- 설치 스크립트가 소스를 `~/.hermes/hermes-agent`에 받고, 전용 uv, Python, Node, ripgrep, FFmpeg, 브라우저 도구까지 스스로 설치한다.
- 설치 후 `source ~/.zshrc`를 안내한다. `.zshrc`는 이 저장소 파일에 링크되어 있으므로 바뀐 줄은 `git diff`로 확인하고 필요한 것만 남긴다.
- 설정은 `hermes setup`. 데스크톱 앱이 필요하면 `hermes desktop`.

## 지금 Mac mini에서 확인된 것 (2026-10-07)

| 항목 | 위치 |
|---|---|
| 본체 | `~/.hermes/` (약 4.1GB, 설정·DB·세션·저장소 포함) |
| 앱 | `/Applications/Hermes.app` |
| 명령어 | `~/.local/bin/hermes`, `assistant`, `developer`, `hermes-dashboard-launchd`, `hermes-remote-info` |
| 로그인 시 자동 실행 | `~/Library/LaunchAgents/ai.hermes.gateway-assistant.plist`, `local.hermes.dashboard.plist` |

## 의존하는 것

지금 Mac의 Hermes(2026-06 설치)는 아래를 쓴다. 지우면 멈춘다. 새 설치 스크립트로 다시 설치하면 Node·FFmpeg를 스스로 갖추므로 brew `node`·`ffmpeg`가 필요 없을 수 있다.

| 의존 | 이유 |
|---|---|
| `brew "node"` | 대시보드 스크립트가 `/opt/homebrew/bin/node`로 실행된다 |
| `brew "ffmpeg"` | 음성 합성·받아쓰기 |
| `~/.local/share/uv/python/cpython-3.11-*` | Hermes 가상환경의 Python이 여기를 가리킨다 |
| Tailscale | 대시보드를 Tailscale 주소로 연다 |

## 채울 것

- [ ] 프로필(`assistant`, `developer`) 설정 방법
- [ ] 저장소에 둘 설정이 있나 (`~/.hermes/`는 인증·DB·세션이 섞여 있어서 통째로는 넣지 않는다)
