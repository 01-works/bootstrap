# 시스템 설정

기본값과 다르게 쓰는 설정만 적는다. 자동화된 것은 [scripts/steps/30-macos.sh](../scripts/steps/30-macos.sh)와 [35-power.sh](../scripts/steps/35-power.sh).

| 설정 | 값 | 이유 | 자동화 |
|---|---|---|---|
| 키 반복 속도 | 빠르게 (`KeyRepeat 2`) | 터미널에서 커서 이동 | `macos` |
| 키 반복 시작 | 짧게 (`InitialKeyRepeat 15`) | 〃 | `macos` |
| 화면 모드 | 다크 | | `macos` |
| Dock 아이콘 크기 | 42 | | `macos` |
| 잠자기, 화면 잠자기 | 끔 | 늘 켜두는 기기 | `power` (main만) |
| 네트워크로 깨우기 | 켬 | 원격에서 깨우기 | `power` (main만) |
| 원격 로그인, 화면 공유 | 켬 | 원격 작업 | 손으로, `power`가 확인 |
| FileVault | 켬 | | 손으로 |

## 바꾸고 싶을 때

1. 시스템 설정에서 직접 바꿔 본다.
2. 어떤 값이 바뀌었는지 찾는다: 바꾸기 전후로 `defaults read > before.txt`, `defaults read > after.txt` 하고 `diff`.
3. `30-macos.sh`에 `set_default` 한 줄을 추가하고 이 표에도 적는다.

`30-macos.sh` 아래쪽에 아직 쓰지 않는 후보 설정이 주석으로 있다 (확장자 항상 보기, Finder 경로 막대 등).
