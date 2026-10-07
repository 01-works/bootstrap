# Paseo

AI 코딩 에이전트를 돌리는 데몬과 앱.

## 설치

`Brewfile.main`의 `cask "paseo"`. 앱은 `/Applications/Paseo.app`, CLI는 `/opt/homebrew/bin/paseo`에 링크된다. 앱이 데몬을 함께 띄우므로 따로 설치할 것은 없다.

앱 없이 서버에서 CLI와 데몬만 쓸 때는 공식 문서의 npm 패키지(`@getpaseo/cli`)를 쓴다 ([공식 문서](https://paseo.sh/docs)).

## 설정

- `~/.paseo/`: 데몬 설정, 키, 에이전트 기록, 로그가 섞여 있어서 저장소에 넣지 않는다.
- 스킬: Paseo가 `~/.claude/skills/paseo*`(Claude Code)와 `~/.agents/skills/paseo*`에 설치한다. 각 폴더의 `.paseo-managed-files.json`이 Paseo가 관리한다는 표시다. 저장소에 넣지 않는다.

## 새 기기에서

앱을 실행하고 안내에 따라 데몬을 설정한다.
