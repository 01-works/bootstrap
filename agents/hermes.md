# Hermes

Homebrew cask가 없어서 직접 설치한다. 새 기기에서의 설치 방법은 아직 기록하지 않았다.

## 지금 Mac mini에서 확인된 것 (2026-10-07)

| 항목 | 위치 |
|---|---|
| 본체 | `~/.hermes/` (약 4.1GB, 설정·DB·세션·저장소 포함) |
| 앱 | `/Applications/Hermes.app` |
| 명령어 | `~/.local/bin/hermes`, `assistant`, `developer`, `hermes-dashboard-launchd`, `hermes-remote-info` |
| 로그인 시 자동 실행 | `~/Library/LaunchAgents/ai.hermes.gateway-assistant.plist`, `local.hermes.dashboard.plist` |

## 의존하는 것

지우면 Hermes가 멈춘다.

| 의존 | 이유 |
|---|---|
| `brew "node"` | 대시보드 스크립트가 `/opt/homebrew/bin/node`로 실행된다 |
| `brew "ffmpeg"` | 음성 합성·받아쓰기 |
| `~/.local/share/uv/python/cpython-3.11-*` | Hermes 가상환경의 Python이 여기를 가리킨다 |
| Tailscale | 대시보드를 Tailscale 주소로 연다 |

## 채울 것

- [ ] 새 기기에서 설치하는 방법
- [ ] 로그인·프로필(`assistant`, `developer`) 설정 방법
- [ ] 저장소에 둘 설정이 있나 (`~/.hermes/`는 인증·DB·세션이 섞여 있어서 통째로는 넣지 않는다)
