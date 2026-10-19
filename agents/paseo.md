# Paseo

AI 코딩 에이전트를 돌리는 데몬과 앱.

## 설치

`Brewfile`의 `cask "paseo"`. 앱은 `/Applications/Paseo.app`, CLI는 `/opt/homebrew/bin/paseo`에 링크된다. 앱이 데몬을 함께 띄우므로 따로 설치할 것은 없다.

앱 없이 서버에서 CLI와 데몬만 쓸 때는 공식 문서의 npm 패키지(`@getpaseo/cli`)를 쓴다 ([공식 문서](https://paseo.sh/docs)).

## 설정

- `~/.paseo/`: 데몬 설정, 키, 에이전트 기록, 로그가 섞여 있어서 저장소에 넣지 않는다.
- 예외적으로 공유할 프로필의 기본값만 [paseo-profiles.json](paseo-profiles.json)에 보관한다. `config.json` 전체를 복사하거나 링크하지 않는다.
- 에이전트에 Paseo 도구를 제공하는 설정(`daemon.mcp.injectIntoAgents`, 앱의 Enable Paseo tools)은 `paseo` 단계가 켠다. Supervisor가 작업자를 만들 때 필요하다.
- 기본 스킬: Paseo가 `~/.claude/skills/paseo*`(Claude Code)와 `~/.agents/skills/paseo*`에 설치한다. 각 폴더의 `.paseo-managed-files.json`이 Paseo가 관리한다는 표시다. 저장소에 넣지 않는다.
- 사용자 스킬: [yw-supervisor](skills/yw-supervisor/SKILL.md)는 이 저장소에서 관리한다. `paseo` 단계가 같은 원본 폴더를 `~/.agents/skills/yw-supervisor`와 `~/.claude/skills/yw-supervisor`에 연결한다. `~/.codex/skills`에는 중복 설치하지 않는다. 다른 내용의 같은 이름 스킬이나 Codex 중복 경로가 있으면 덮어쓰지 않고 중단한다.

## 프로필

중요한 판단과 시각적 완성도가 중요한 UI 구현은 Opus 5.5에, 작업량이 많은 일반 구현·테스트·일상 리뷰는 GPT-6.1 Sol에 맡긴다. Opus 한도 소진·접속 불가 시에만 Astra 대체 프로필을 선택한다.

| 프로필 | 기본 모델 | 추론 | 모드 |
|---|---|---|---|
| Supervisor | Claude Opus 5.5 | high | auto |
| Supervisor (Astra) | GPT-6 Astra | high | auto-review |
| Builder | GPT-6.1 Sol | high | auto-review |
| Frontend Builder | Claude Opus 5.5 | high | auto |
| Reviewer | GPT-6.1 Sol | xhigh | auto-review + plan |
| Architect | Claude Opus 5.5 | xhigh | plan |
| Architect (Astra) | GPT-6 Astra | xhigh | auto-review + plan |
| Deep Reviewer | Claude Opus 5.5 | xhigh | plan |
| Deep Reviewer (Astra) | GPT-6 Astra | xhigh | auto-review + plan |

- Supervisor는 여러 작업·프로젝트의 우선순위·의존성·할당·진행·검증·완료를 관리한다. 직접 구현하지 않고 탐색·수정·테스트·통합은 작업자에게 맡긴다.
- 기본 흐름: Builder 구현 → 새 Reviewer 세션에서 독립 리뷰 → Supervisor가 결과 확인. 중요한 변경에는 새 Deep Reviewer 세션을 추가한다.
- 같은 모델이 작성했더라도 독립 리뷰가 가능하다. 리뷰에는 요구사항·diff·관련 코드·검증 결과를 전달하고, 지적은 코드 근거·발생 조건·영향·재현 방법으로 검증한다.
- Astra 프로필과 notes는 선택 지침이며 자동 장애 전환 기능이 아니다. Supervisor를 인계할 때 모든 작업의 상태·의존성·workspace·agent ID·결정·검증·남은 조치를 전달한다. 단순히 작업이 어렵다는 이유로 대체하지 않는다.
- 프로필 변경은 이후 선택에 적용된다. 이미 실행 중인 에이전트의 모델은 바뀌지 않는다.

## 총괄 운영 스킬

Paseo에서 Supervisor 프로필로 새 대화를 열고 다음처럼 요청한다.

> yw-supervisor 스킬로 다음 작업들을 총괄해줘: A 프로젝트의 새 화면, B 프로젝트의 API 수정, C 프로젝트의 회귀 조사. 직접 구현하지 말고 적절한 작업자에게 할당하고 진행·검증·완료를 관리해줘.

프로필 선택만으로 스킬이 실행되지는 않는다. 스킬이 실제 작업 지시를 작업자의 `initialPrompt`에 전달한다. Paseo 도구가 보이지 않으면 `./bootstrap.sh --only paseo` 후 새 에이전트를 연다. CLI로도 운영할 수 있다.

스킬은 작업 기록을 `${XDG_STATE_HOME:-$HOME/.local/state}/yw-supervisor/<관리 세션 ID>/tasks.md`에 남기고 완료 알림에 따라 다음 조치를 진행한다. 실행 중인 작업을 반복 조회하거나 요청하지 않은 상시 감시를 만들지 않는다. 재개·인계 때 기록과 실제 상태를 대조하고 기존 작업자를 중복 생성하지 않는다. 기존 자식의 자동 알림 수신자가 새 감독자로 바뀌는 것은 아니므로 인계 시 후속 보고 경로도 정한다.

Frontend Builder는 새 화면·레이아웃·타이포그래피·모션처럼 시각적 선택이 중요한 작업에 사용한다. API 연결·상태 관리·확정된 디자인의 단순 수정은 Builder가 기본이다. Opus를 쓸 수 없고 중요한 시각적 선택이 남았다면 Architect (Astra)가 방향·완료 기준을 정하고 Builder가 구현한다. 같은 파일을 동시에 수정하지 않도록 독립 worktree 또는 순차 작업으로 배정한다. UI 완료 근거에는 실제 브라우저에서 확인한 렌더링·반응형·키보드 조작·주요 흐름이 포함되어야 한다.

이 배정은 사용자 선호를 반영한 초기 운영 기준이며, Opus가 모든 프론트엔드에서 Sol보다 우수하다는 비교 결과를 뜻하지 않는다. [Anthropic의 Opus 5.5 가이드](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#frontend-design-defaults)도 구체적인 디자인 방향이 없으면 기본 스타일로 흐른다고 설명한다. 기존 디자인 시스템과 참고 화면을 함께 전달하고 결과로 배정을 조정한다.

## 설치와 갱신

`paseo` 단계는 먼저 사용자 스킬을 연결하고, `$PASEO_HOME/config.json`(기본 `~/.paseo/config.json`)의 `daemon.agentProfiles`에 없는 프로필만 추가하며, 꺼져 있으면 Paseo 도구 제공을 켠다. 이름 또는 ID가 일치하는 기존 프로필과 개인 프로필은 유지한다. 예전 `Cross Reviewer`는 `Deep Reviewer`의 이전 이름으로 인식한다. Paseo 설정이 아직 없어도 스킬은 연결된다.

```sh
./bootstrap.sh --only paseo --dry-run
./bootstrap.sh --only paseo
```

기존 프로필에도 저장소의 최신 모델·모드·추론·notes를 반영하려면 명시적으로 갱신한다. ID·아이콘·색상은 유지하고, 이전 제공자의 기능 설정은 교체한다. 이때 `Cross Reviewer`도 `Deep Reviewer`로 이름을 바꾼다.

```sh
node scripts/paseo-profiles.mjs --update --dry-run
node scripts/paseo-profiles.mjs --update
```

변경 전 전체 설정을 `~/.local/state/bootstrap/backup/paseo-*/config.json`에 권한 600으로 백업한다(`XDG_STATE_HOME` 지정 시 해당 경로 사용). Paseo CLI가 설정을 검증·저장하고 실행 중인 데몬에 reload한다. 재시작은 하지 않는다. CLI가 `saved; not applied`를 보고하면 다음 데몬 시작 때 적용되며, reload 실패 시 원인을 해결한 뒤 `paseo reload`한다.

`doctor`는 프로필·도구 설정의 누락·차이를 경고만 하고, 사용자 스킬 연결 누락·충돌은 실패로 표시한다. 스킬만 설치하거나 검사하려면 `node scripts/agent-skills.mjs` 또는 `node scripts/agent-skills.mjs --check`를 쓴다. 기본값의 모델 ID를 바꿨을 때 기존 기기는 위 `--update` 명령으로 갱신한다. 모델과 추론 옵션이 해당 기기에서 지원되는지는 Paseo 모델 선택기에서 확인한다.

공식 문서: [프로필](https://paseo.sh/docs/agent-profiles.md), [설정과 reload](https://paseo.sh/docs/configuration.md).

## 새 기기에서

앱을 실행하고 안내에 따라 데몬을 설정한 뒤 `./bootstrap.sh --only paseo`를 실행한다. 아직 설정 파일이 없으면 bootstrap은 프로필 설치를 건너뛰고 이 순서를 안내한다. 설치한 스킬이 현재 세션에 보이지 않으면 새 에이전트를 연다.

작업자의 브라우저 작업은 [브라우저 작업](browser.md)의 운영 규칙(공유 연결, own 탭, 순서대로 조작)을, 네이티브 GUI 작업은 [기기 GUI 작업](computer-use.md)을 따른다. Paseo 작업자의 Computer Use 지원은 확인되지 않았으므로 GUI 작업을 기본으로 배정하지 않는다.
