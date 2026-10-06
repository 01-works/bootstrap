# Mac mini (M4)

지금의 메인 개발기. 프로필: `main`.

## 사양

| 항목 | 값 |
|---|---|
| 모델 | Mac mini, Mac16,10 |
| 칩 | Apple M4 |
| 메모리 | 16GB |
| 저장 공간 | 256GB |
| macOS | 26.5.1 (2026-10-06 기준) |

## 역할

늘 켜두고 원격으로도 붙는 기기. 그래서 이렇게 설정되어 있다.

| 설정 | 값 | 자동화 |
|---|---|---|
| 잠자기 / 디스플레이 잠자기 | 끔 | `power` 단계 |
| 네트워크로 깨우기 | 켬 | `power` 단계 |
| 원격 로그인 (SSH) | 켬 | 손으로 (시스템 설정 > 일반 > 공유), `power` 단계가 확인 |
| 화면 공유 | 켬 | 손으로, `power` 단계가 확인 |
| Tailscale, mosh | 설치 | `Brewfile` |
| FileVault | 켬 | 손으로 ([initial-setup.md](../macos/initial-setup.md)) |

정전 후 자동으로 켜지는 설정(`pmset autorestart`)은 꺼져 있다. 켜더라도 FileVault 잠금을 풀어야 원격으로 쓸 수 있으므로, 재부팅 후 원격으로 잠금 해제가 되는지 한 번 확인해 둘 것.

## 겪은 문제

- 메모리 16GB와 저장 공간 256GB가 둘 다 부족하다 (수치는 [buying-guide.md](buying-guide.md)). 다음 기기는 둘 다 올릴 것.
