# Paseo

AI 코딩 에이전트를 돌리는 데몬과 앱.

## 설치

`Brewfile.main`의 `cask "paseo"`. 앱은 `/Applications/Paseo.app`, CLI는 `/opt/homebrew/bin/paseo`에 링크된다.

지금 Mac mini는 앱을 직접 설치했고, CLI는 `~/.local/bin/paseo`로 링크되어 있다 (2026-10-06). Homebrew로 옮기려면 [homebrew.md](../development/homebrew.md)의 "기존 앱 옮기기" 참고.

## 설정

- `~/.paseo/`: 데몬 설정, 키, 에이전트 기록, 로그가 섞여 있어서 저장소에 넣지 않는다.
- `~/.claude/skills/paseo-*`: Paseo가 설치하는 Claude Code 스킬. Paseo가 관리하게 둔다.

## 새 기기에서

앱을 실행하고 안내에 따라 데몬을 설정한다.
