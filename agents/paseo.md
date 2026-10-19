# Paseo

AI 코딩 에이전트를 돌리는 데몬과 앱.

## 설치

`Brewfile`의 `cask "paseo"`. 앱은 `/Applications/Paseo.app`, CLI는 Apple Silicon의 `/opt/homebrew/bin/paseo`, Intel의 `/usr/local/bin/paseo`에 링크된다. 데몬은 앱 안에 들어 있고, 앱과 별개로 실행된다. 앱은 데몬에 붙어서 보는 화면이다. 앱을 Homebrew 밖에서 설치한 기기(직접 받은 경우)는 이 링크가 없을 수 있어, `paseo` 단계가 `paseo` 명령이 없으면 앱 안의 CLI를 `~/.local/bin/paseo`에 연결한다.

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

자동 갱신([변경 전파](../README.md#변경-전파))은 `agents/paseo-profiles.json`이 바뀐 커밋을 받으면 `--update`까지 실행한다. 그래서 기본값을 고쳐 push하면 모든 기기의 기존 프로필이 함께 바뀐다.

`doctor`는 프로필·도구 설정의 누락·차이를 경고만 하고, 사용자 스킬 연결 누락·충돌은 실패로 표시한다. 스킬만 설치하거나 검사하려면 `node scripts/agent-skills.mjs` 또는 `node scripts/agent-skills.mjs --check`를 쓴다. 자동 갱신을 끈 기기는 기본값을 바꾼 뒤 위 `--update` 명령으로 갱신한다. 모델과 추론 옵션이 해당 기기에서 지원되는지는 Paseo 모델 선택기에서 확인한다.

공식 문서: [프로필](https://paseo.sh/docs/agent-profiles.md), [설정과 reload](https://paseo.sh/docs/configuration.md).

## 플러그인

모든 기기에 설치하는 기본 플러그인과 그 버전. 원본은 [paseo-plugins.json](paseo-plugins.json)이다. 직접 만든 플러그인의 코드·개발·CI는 [01-works/paseo-plugin](https://github.com/01-works/paseo-plugin)에서 관리하고, 어느 버전을 모든 기기에 깔지는 이 저장소가 정한다.

| 플러그인 | 기능 | 소스 | 버전 |
|---|---|---|---|
| mac-monitor | 시스템 지표·상위 앱·프로세스 종료·정리 검사 | `github:01-works/paseo-plugin:mac-monitor` | `ref` (커밋) |
| agent-list | 현재 워크스페이스의 에이전트 목록·검색·대화 이동·닫기·오래된 대화 정리 | `github:01-works/paseo-plugin:agent-list` | `ref` (커밋) |
| ZeroSub | Claude·ChatGPT 구독 계정 선택·한도 도달 시 전환 (Kapybara 배포) | `kapybara-org/zerosub` (Paseo 레지스트리) | `version` |

`paseo` 단계가 하는 일:

- 플러그인 사용(`pluginsEnabled`, 앱의 Enable plugins)이 꺼져 있으면 켠다. bootstrap 기기는 이 목록의 플러그인을 쓰기로 이미 정한 기기로 본다.
- 없는 플러그인을 설치하고, 자체 플러그인은 목록의 커밋으로 맞춘다(올리기·내리기 모두). 목록에 있는 플러그인을 기기에서 지우면 다음에 이 단계가 돌 때 다시 설치된다. 빼려면 목록에서 뺀다.
- 레지스트리 플러그인은 레지스트리가 검토한 버전만 받을 수 있다. 그 버전이 목록의 `version`과 같을 때만 갱신하고, 다르면 유지하고 알린다. 내릴 수는 없어서, 새 기기에 목록보다 새 검토 버전이 들어오면 목록을 올릴 때까지 `doctor`가 경고한다.
- 목록에서 뺀 플러그인은 기기에서 지우지 않는다. 필요하면 `paseo plugin remove <id>`.
- 맞춘 뒤 목록을 다시 읽어, 버전이 맞지 않거나 이번에 설치·갱신한 플러그인이 실행되지 않으면 실패로 남긴다(자동 갱신 알림·재시도 대상).
- 폴더에서 설치한 플러그인(개발 중)과 다른 소스에서 설치한 플러그인은 그대로 두고 알리기만 한다. 꺼 둔 플러그인도 켜지 않는다.
- 설치·갱신은 실행 중인 데몬이 한다. 데몬이 꺼져 있으면 이 기기에서 마지막으로 맞춘 기록만 본다. 그 뒤 목록이 바뀌었으면 데몬을 잠시 켜서 맞추고 다시 끈다. 기록은 `~/.local/state/bootstrap/paseo-plugins/`.

`doctor`는 설치 누락, 버전 차이, 꺼짐, 실행 안 됨, 다른 소스를 경고한다. 개발 중인 폴더 설치는 표시만 한다.

### 새 버전 배포

플러그인 코드는 샌드박스 없이 데몬 권한으로 실행된다. paseo-plugin의 main에 merge해도 바로 퍼지지 않고, 이 저장소의 버전을 올려야 모든 기기에 간다.

1. paseo-plugin에서 PR을 merge하고 CI 통과를 확인한다.
2. 버전을 올린다. 자체 플러그인은 main에서 그 플러그인 폴더를 마지막으로 바꾼 커밋으로 바꾼다. 그 커밋에 CI 기록이 없거나, 끝나지 않았거나, 실패가 있으면 건너뛴다(`gh` 로그인 필요). 다른 플러그인만 바뀐 커밋으로는 올리지 않으므로 불필요한 재설치가 없다. 레지스트리 플러그인은 이 기기에서 본 검토 버전으로 바꾼다.

   ```sh
   node scripts/paseo-plugins.mjs --bump
   git diff agents/paseo-plugins.json
   ```

3. 커밋·push하면 [자동 갱신](../README.md#변경-전파)이 모든 기기에서 `paseo` 단계를 실행해 버전을 맞춘다. 되돌릴 때는 그 커밋을 revert한다.

### 플러그인 개발

개발 중에는 폴더에서 설치한다. 폴더 설치는 bootstrap이 건드리지 않는다. 절차는 [paseo-plugin의 개발 안내](https://github.com/01-works/paseo-plugin#개발).

플러그인의 요구 Paseo 버전(`paseo-plugin.json`의 `requirements.paseo`)을 넘는 Paseo 업데이트가 나오면 모든 기기에서 함께 멈출 수 있다. Paseo를 올리기 전에 paseo-plugin에서 요구 버전을 올리고 위 절차로 배포한다. ZeroSub의 계정 로그인·전환 설정은 [ZeroSub 안내](https://github.com/01-works/paseo-plugin/blob/main/docs/plugins/zerosub.md).

## 새 기기에서

`paseo` 단계가 설정이 없으면 앱의 첫 실행 화면 대신 공식 CLI로 첫 설정을 하고 데몬을 띄운다: `paseo onboard --relay --voice disable`. 고정값은 원격(릴레이) 연결 켬, 음성 기능 끔이다. 이어서 같은 단계에서 프로필과 Paseo 도구 설정까지 끝난다. 다른 기기(노트북·휴대폰)의 앱은 데스크톱 데몬에서 `paseo daemon pair`로 받은 연결 링크로 붙는다(릴레이). 에이전트는 같은 링크를 `paseo --host '<링크>' ls`처럼 CLI에 준다. 링크는 데몬 접속 권한 자체라 저장소·공유 문서에 넣지 않는다. 노트북 데몬은 다른 기기에 페어링하지 않는다 ([원격 접속](../macos/system-settings.md#원격-접속)).

늘 켜두는 기기(배터리 없음)는 LaunchAgent `local.bootstrap.paseo`가 로그인할 때 `paseo daemon start`를 실행한다. 이미 실행 중이면 아무것도 하지 않는다. 노트북은 앱을 열 때 데몬이 함께 뜬다. 데스크톱에서 끄려면 `launchctl bootout gui/$(id -u)/local.bootstrap.paseo` 후 `~/Library/LaunchAgents/local.bootstrap.paseo.plist`를 지운다. 설치한 스킬이 현재 세션에 보이지 않으면 새 에이전트를 연다.

작업자의 브라우저 작업은 [브라우저 작업](browser.md)의 운영 규칙(공유 연결, own 탭, 순서대로 조작)을, 네이티브 GUI 작업은 [기기 GUI 작업](computer-use.md)을 따른다. Paseo 작업자의 Computer Use 지원은 확인되지 않았으므로 GUI 작업을 기본으로 배정하지 않는다.
