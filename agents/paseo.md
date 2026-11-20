# Paseo

AI 코딩 에이전트를 돌리는 데몬과 앱.

## 설치

`Brewfile`의 `cask "paseo"`. 앱은 `/Applications/Paseo.app`, CLI는 Apple Silicon의 `/opt/homebrew/bin/paseo`, Intel의 `/usr/local/bin/paseo`에 링크된다. 데몬은 앱 안에 들어 있고, 앱과 별개로 실행된다. 앱은 데몬에 붙어서 보는 화면이다. 앱을 Homebrew 밖에서 설치한 기기(직접 받은 경우)는 이 링크가 없을 수 있어, `paseo` 단계가 `paseo` 명령이 없으면 앱 안의 CLI를 `~/.local/bin/paseo`에 연결한다.

앱 없이 서버에서 CLI와 데몬만 쓸 때는 공식 문서의 npm 패키지(`@getpaseo/cli`)를 쓴다 ([공식 문서](https://paseo.sh/docs)).

## 설정

- `~/.paseo/`: 데몬 설정, 키, 에이전트 기록, 로그가 섞여 있어서 저장소에 넣지 않는다.
- 예외적으로 공유할 프로필의 기본값만 [paseo-profiles.json](paseo-profiles.json)에 보관한다. `config.json` 전체를 복사하거나 링크하지 않는다.
- 에이전트에 Paseo 도구를 제공하는 설정(`daemon.mcp.injectIntoAgents`, 앱의 Enable Paseo tools)은 `paseo` 단계가 켠다. Supervisor가 작업자를 만들 때 필요하다.
- 머지된 워크스페이스 자동 아카이브(`daemon.autoArchiveAfterMerge`)는 `paseo` 단계가 끈다. 이전에 켜진 기기도 다음 `paseo` 단계(자동 갱신 포함)에서 꺼진다. 병합 뒤 워크스페이스는 수동으로 아카이브한다. 에이전트·workspace 정리 전에는 [archive 전 공통 안전 대조](skills/yw-supervisor/SKILL.md#archive-전-공통-안전-대조)를 따른다.
- 기본 스킬: Paseo가 `~/.claude/skills/paseo*`(Claude Code)와 `~/.agents/skills/paseo*`에 설치한다. 각 폴더의 `.paseo-managed-files.json`이 Paseo가 관리한다는 표시다. 저장소에 넣지 않는다. 데몬은 이미 설치된 스킬만 자동 갱신하고 처음 설치는 앱 설정(Orchestration skills)에서 해야 해서, `paseo` 단계가 하나도 없을 때만 데몬에 설치를 요청한다(`scripts/paseo-skills.mjs`). 앱의 내부 모듈을 쓰므로 Paseo 버전이 바뀌어 실패하면 앱 설정에서 설치한다. 앱에서 스킬을 하나도 고르지 않은 기기는 그대로 둔다. 앱의 제거(Uninstall)만 하면 다음 `paseo` 단계가 다시 설치하므로, 빼려면 선택을 비운다.
- 사용자 스킬: [yw-supervisor](skills/yw-supervisor/SKILL.md), [yw-chief-supervisor](skills/yw-chief-supervisor/SKILL.md), [yw-paseo-cleanup](skills/yw-paseo-cleanup/SKILL.md)은 이 저장소에서 관리한다. `paseo` 단계가 각 스킬의 같은 원본 폴더를 `~/.agents/skills/<스킬 이름>`과 `~/.claude/skills/<스킬 이름>`에 연결한다. `~/.codex/skills`에는 중복 설치하지 않는다. 다른 내용의 같은 이름 스킬이나 Codex 중복 경로가 있으면 덮어쓰지 않고 중단한다.

## Claude API 키와 프로필

### Infisical에서 직접 API 프로필 가져오기

**Paseo API 대체 프로필**은 Infisical의 직접 API 키로 실행하는 Claude·GPT 프로필을 통칭한다. “Paseo API 대체 프로필 가져와 줘”는 Paseo 호스트에 아래 명령으로 이 프로필들을 등록해 달라는 뜻이다.

bootstrap의 `paseo` 단계는 Infisical CLI, Claude Code, Codex CLI가 있으면 로그인과 프로젝트 접근을 확인한 뒤 프로필을 자동 등록한다. 준비되지 않은 기기는 이 등록만 건너뛴다. 자동 갱신을 쓰는 기기에도 같은 조건이 적용된다.

처음 연결할 Mac에서 Infisical CLI를 설치하고 로그인한다. 초기 Paseo 설정을 마친 뒤 bootstrap 저장소 루트에서 다음 명령을 실행한다.

```sh
brew install infisical/get-cli/infisical
infisical login
./bootstrap.sh --only paseo
```

프로필만 직접 가져오려면 `python3 scripts/paseo-api-key.py --infisical`을 실행한다. Infisical Cloud 로그인에는 `default` 프로젝트의 `prod` 환경 `/ai` 경로 읽기 권한이 필요하다.

| 새 에이전트 모델 선택기의 **Profiles** | Infisical 키 이름 |
| --- | --- |
| Claude API (Office), (K), (Y), (HI) | `ANTHROPIC_API_KEY_OFFICE`, `ANTHROPIC_API_KEY_K`, `ANTHROPIC_API_KEY_Y`, `ANTHROPIC_API_KEY_HI` |
| GPT API (Office), (K) | `GPT_API_KEY_OFFICE`, `GPT_API_KEY_K` |

명령은 Paseo home에 실행 스크립트를 복사하고 여섯 프로필을 병합한 뒤 데몬에 다시 로드한다. 각 프로필로 새 에이전트를 시작하면 해당 키 하나를 Infisical에서 읽어 Anthropic 또는 OpenAI 공식 API에 연결한다. 저장소와 Paseo 설정에는 키 이름만 들어간다. 키를 교체하면 다음 실행부터 반영된다. 로그인이 만료되면 `infisical login`을 다시 실행하고, 다른 로그인 프로필로 바꿨다면 가져오기 명령도 다시 실행한다.

등록과 API 호출은 별개다. Claude Console에 사용 가능한 잔액이 필요하다. ChatGPT에 연결된 월간 API 크레딧 혜택을 이용하는 조직은 일반 OpenAI Responses API가 성공해도 Codex의 API 키 요청이 거절될 수 있다. [OpenAI의 API 크레딧 혜택 안내](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions)

### 로컬에 키를 입력하는 방식

기존 `claude-api` provider의 키를 바꾸려면 터미널에서 실행한다.

```sh
python3 ~/dev/bootstrap/scripts/paseo-api-key.py
```

새 키를 숨김 입력으로 받아 로컬 Paseo의 `config.json`에서 해당 provider의 `ANTHROPIC_API_KEY`만 교체한다. 다른 설정을 보존하고 파일 권한을 600으로 설정한 뒤 `paseo reload`를 실행한다. 새 키는 해당 API provider로 새 에이전트를 시작해서 사용한다. 키를 명령 인자나 저장소에 넣지 않는다.

키를 병행하려면 별도 provider와 선택용 프로필을 함께 만든다. 아래 명령은 두 번째 키를 입력받은 뒤에만 저장한다. 기존 `claude-api`의 키와 프로필은 유지된다.

```sh
python3 ~/dev/bootstrap/scripts/paseo-api-key.py --create --provider claude-api-2 --profile-name 'Claude API 2'
```

Paseo의 새 에이전트 모델 선택기에서 각 프로필을 고르면 해당 키를 사용한다. 새 프로필은 모델·모드·추론 수준을 고정하지 않으므로 생성 화면에서 선택한다. 이후 두 번째 키를 교체할 때는 `--provider claude-api-2`만 지정한다. 기존 provider에도 `--profile-name '원하는 이름'`을 붙이면 선택용 프로필을 추가할 수 있고, 이미 있는 프로필의 모델·모드 등은 보존한다. 같은 이름이 다른 provider에 쓰이면 중단한다.

기본 home은 `PASEO_HOME`, 없으면 `~/.paseo`다. 다른 로컬 home은 `--home <경로>`, 파일만 저장하려면 `--no-reload`를 쓴다. reload 실패 시 키는 저장된 상태로 남으며 스크립트가 실패를 알린다. 이 스크립트는 수동 실행용이며 bootstrap 설치·자동 갱신 과정에서 키를 요구하지 않는다. 키와 개인 API 프로필은 각 기기에만 저장하며 공유 프로필 manifest에는 넣지 않는다. ZeroSub 구독 계정 전환과는 별개로, API 키 사이의 자동 전환은 하지 않는다.

검증: `python3 scripts/paseo-api-key.test.py` (가짜 키·임시 home·reload 대역만 사용).

## 프로필

총괄·중요한 설계와 시각적 완성도가 중요한 UI 구현은 Opus 5.5에, 범위가 정해진 심층 리뷰는 Fable 5.2(high)에, 작업량이 많은 일반 구현·테스트·일상 리뷰는 GPT-6.2 Sol에 맡긴다. 프로필의 Claude 모델(총괄·설계는 Opus, 심층 리뷰는 Fable)이 한도 소진·접속 불가일 때만 Astra 대체 프로필을 선택한다. 예외: [yw-chief-supervisor](skills/yw-chief-supervisor/SKILL.md#독립-검토와-조치) 스킬을 실행 중인 총괄 감독이 그 스킬의 교차 모델 합의(감사·완료 판정·운영 정책 설계)에 쓸 때는 Claude 가용 여부와 관계없이 Architect (Astra)·Deep Reviewer (Astra)를 선택할 수 있다. yw-supervisor의 리뷰·설계와 총괄 감독 자신의 코드 PR 리뷰에는 적용하지 않는다. 판단 범위와 모델 구성의 원장은 위 스킬이며, Supervisor (Astra)의 총괄 인계 조건은 그대로 적용한다.

| 프로필 | 기본 모델 | 추론 | 모드 |
|---|---|---|---|
| Supervisor | Claude Opus 5.5 | high | bypassPermissions |
| Supervisor (Astra) | GPT-6.2 Astra | high | full-access |
| Builder | GPT-6.2 Sol | high | full-access |
| Frontend Builder | Claude Opus 5.5 | high | bypassPermissions |
| Reviewer | GPT-6.2 Sol | xhigh | auto-review + plan |
| Architect | Claude Opus 5.5 | xhigh | plan |
| Architect (Astra) | GPT-6.2 Astra | xhigh | auto-review + plan |
| Deep Reviewer | Claude Fable 5.2 | high | plan |
| Deep Reviewer (Astra) | GPT-6.2 Astra | xhigh | auto-review + plan |

- Supervisor는 여러 작업·프로젝트의 우선순위·의존성·할당·진행·검증·완료를 관리한다. 직접 구현하지 않고 수정·테스트·통합과 큰 탐색은 Paseo 작업자에게 맡긴다. 내장 서브에이전트는 짧은 읽기 전용 확인에만 쓴다.
- 기본 흐름: Builder 구현 → 새 Reviewer 세션에서 독립 리뷰 → Supervisor가 결과 확인. 중요한 변경에는 새 Deep Reviewer 세션을 추가한다.
- 같은 모델이 작성했더라도 독립 리뷰가 가능하다. 리뷰에는 요구사항·diff·관련 코드·검증 결과를 전달하고, 지적은 코드 근거·발생 조건·영향·재현 방법으로 검증한다.
- Astra 프로필과 notes는 선택 지침이며 자동 장애 전환 기능이 아니다. Supervisor를 인계할 때 모든 작업의 상태·의존성·workspace·agent ID·결정·검증·남은 조치를 전달한다. 단순히 작업이 어렵다는 이유로 대체하지 않는다.
- 구현·총괄 프로필은 권한 확인 없이 실행한다(Claude `bypassPermissions`, Codex `full-access`). 리뷰·설계 프로필은 직접 수정하지 않는 역할이라 plan 계열 모드를 유지한다.
- 프로필 변경은 이후 선택에 적용된다. 이미 실행 중인 에이전트의 모델은 바뀌지 않는다.

## 총괄 운영 스킬

작업 대화에서 `yw-supervisor 스킬로 <목표와 완료 조건>을 총괄해줘`라고 요청한다.

감독 복귀는 Better Paseo Tasks의 자식 카드 Open parent를 쓴다.

lane 이름·`tasks.md`·감독 ID·인계·승인·종료는 [감독 계약](skills/yw-supervisor/SKILL.md#시작과-기록)을 따른다. 작업자·리뷰어는 코드 worktree의 `workspaceId`를 명시한다. 도구가 없으면 `./bootstrap.sh --only paseo` 후 새 에이전트를 연다.

여러 감독 세션을 함께 감사할 때는 [yw-chief-supervisor](skills/yw-chief-supervisor/SKILL.md)를 쓴다. 감독 1개 운영은 `yw-supervisor`가 맡는다.

> yw-chief-supervisor 스킬로 여러 감독의 lane 현황과 규칙 준수를 감사해줘. 다른 모델 계열의 독립 검토자와 지적·조치에 합의하고, 소유 감독에게 전달한 조치와 내 결정이 필요한 항목을 보고해줘.

총괄은 진행 중인 다른 lane을 인수·중단·정리하거나 작업자에게 직접 지시하지 않는다. 순찰·재개는 스킬 조건을 따르고 누적 사용자 목표의 완료를 교차 모델로 판정한 세션만 안전 대조 뒤 archive한다. `tasks.md`는 현재 상태, `log.md`는 경과이며 직접 배정한 작업의 소유 기록은 `-chief` 없는 폴더에 따로 둔다. local workspace archive 뒤에도 기록 폴더는 보존한다. 세부 발견·합의·정리·인계는 [총괄 스킬](skills/yw-chief-supervisor/SKILL.md)을 따른다.

Frontend Builder는 새 화면·레이아웃·타이포그래피·모션처럼 시각적 선택이 중요한 작업에 사용한다. API 연결·상태 관리·확정된 디자인의 단순 수정은 Builder가 기본이다. Opus를 쓸 수 없고 중요한 시각적 선택이 남았다면 Architect (Astra)가 방향·완료 기준을 정하고 Builder가 구현한다. 시각 작업과 기능 작업은 나누는 것이 유익할 때만 분리하고, 한 작업자로 충분한 작은 작업을 억지로 쪼개지 않는다. 같은 파일을 동시에 수정하지 않도록 독립 worktree 또는 순차 작업으로 배정한다. 디자인 방향이 없으면 작업자가 기존 제품에서 근거를 찾거나 중요한 선택을 질문하게 하고, 불필요한 재디자인은 피한다. Opus를 못 써서 일반 UI를 Builder에 넘기면 이유를 알리고, 같은 시각 품질을 보장한다고 말하지 않는다. UI 완료 근거에는 실제 브라우저에서 확인한 렌더링·반응형·키보드 조작·주요 흐름이 포함되어야 한다.

이 배정은 사용자 선호를 반영한 초기 운영 기준이며, Opus가 모든 프론트엔드에서 Sol보다 우수하다는 비교 결과를 뜻하지 않는다. [Anthropic의 Opus 5.5 가이드](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#frontend-design-defaults)도 구체적인 디자인 방향이 없으면 기본 스타일로 흐른다고 설명한다. 기존 디자인 시스템과 참고 화면을 함께 전달하고 결과로 배정을 조정한다.

## 기기 정리 스킬

이 기기에 쌓인 Paseo 세션·workspace·연결이 끊긴 worktree를 한 번에 정리할 때는 [yw-paseo-cleanup](skills/yw-paseo-cleanup/SKILL.md)을 쓴다.

이 스킬 폴더와 이 절도 [감독 스킬의 변경 창구·교훈 포착 규칙](skills/yw-supervisor/SKILL.md)에 따라 총괄 감독 lane의 PR로 바꾸고, 교훈은 `skill-lesson` 수신 이슈로 보낸다.

> yw-paseo-cleanup 스킬로 이 기기의 Paseo 세션과 workspace를 정리해줘. 실행 중이거나 기다리는 건 남기고, 정리 계획을 먼저 보여줘.

- 스킬 폴더의 `scan.mjs`가 저장 레코드·git·gh·감독 기록을 읽기만 해서 분류 초안을 만든다. 실행 기록은 `${XDG_STATE_HOME:-$HOME/.local/state}/yw-paseo-cleanup/<실행 ID>/`에 남는다.
- status만으로 판단하지 않는다. closed는 끝남이 아니고, 질문·백그라운드·heartbeat를 기다리는 세션도 idle로 보인다. 완료 근거가 확인된 것만 정리 후보가 된다.
- 배치 승인 후보와 항목별 결정을 나눈 계획을 먼저 보여 주고, 승인받은 범위만 실행한다. archive 안전 규칙은 [archive 전 공통 안전 대조](skills/yw-supervisor/SKILL.md#archive-전-공통-안전-대조)를 따른다.
- 감독 lane은 그 감독이나 yw-chief-supervisor가 정리한다. 이 스킬은 lane 밖 잔재와, 명시적 완료 판정이 있고 지금 다른 감독·chief가 관리하지 않는 잔재만 다룬다.

## 설치와 갱신

`paseo` 단계는 먼저 사용자 스킬을 연결하고, `$PASEO_HOME/config.json`(기본 `~/.paseo/config.json`)의 `daemon.agentProfiles`에 없는 프로필만 추가하며, Paseo 도구 제공은 켜고 머지된 워크스페이스 자동 아카이브는 끈다. 이름 또는 ID가 일치하는 기존 프로필과 개인 프로필은 유지한다. 예전 `Cross Reviewer`는 `Deep Reviewer`의 이전 이름으로 인식한다. Paseo 설정이 아직 없어도 스킬은 연결된다.

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

모든 기기에 설치하는 기본 플러그인과 갱신 정책은 [paseo-plugins.json](paseo-plugins.json)에 있다. 직접 만든 플러그인의 코드·개발·CI는 [01-works/paseo-plugin](https://github.com/01-works/paseo-plugin)에서 관리한다.

| 플러그인 | 기능 | 소스 | 버전 |
|---|---|---|---|
| mac-monitor | 시스템 지표·상위 앱·프로세스 종료·정리 검사 | `github:01-works/paseo-plugin:mac-monitor` | Git 기본 브랜치 최신 커밋 |
| Better Paseo | 채팅 타임라인 재구성, 호스트 전체 에이전트 Tasks 보드 (RoundRedDot 배포) | `roundreddot/better-paseo` (Paseo 레지스트리) | 레지스트리 최신 검토 커밋 |
| ZeroSub | Claude·ChatGPT 구독 계정 선택·한도 도달 시 전환 (Kapybara 배포) | `kapybara-org/zerosub` (Paseo 레지스트리) | 레지스트리 최신 검토 버전 |

agent-list는 Better Paseo로 대체해 은퇴했다(`retired`). Better Paseo의 기능·데이터 흐름은 [paseo-plugin의 안내](https://github.com/01-works/paseo-plugin/blob/main/docs/plugins/better-paseo.md).

### 플러그인 설정

목록 항목의 `settings`에 플러그인의 설정 문서(`settings.<설정 ID>`)별로 맞출 키와 값을 적는다. 적은 키만 맞추고, 적지 않은 키는 앱에서 바꾼 값을 그대로 둔다. 설정은 기기(호스트)마다 데몬에 저장되므로(`~/.paseo/plugin-settings/<플러그인>/<설정 ID>.json`) 이 목록이 모든 기기의 기준이다. 바꾸려면 앱이 아니라 목록을 고친다. 앱에서 바꾼 값은 `doctor`가 경고하고 다음 `paseo` 단계가 되돌린다.

| 플러그인 | 설정 | 값 | 이유 |
|---|---|---|---|
| Better Paseo | `title-generation` | `afterFirstReply: true`, `customModel: true`, `provider: claude`, `model: claude-haiku-5-5`, `disableThinking: true`, `prompt`: 기본 프롬프트에서 언어 문장만 "한국어 대화면 한국어로"로 바꾼 것 | 이름 없이 시작한 대화의 제목을 첫 턴에 만든다. 이미 이름이 있는 대화(감독이 만든 작업자 등)는 바꾸지 않는다. 2026-11-17 실측(대화 4개, 미리보기)에서 Haiku 5.5(추론 off)가 GPT-6-Luna보다 빠르고(평균 4.3초 대 5.3초) 대화 전체 목표를 더 잘 잡았다. 플러그인은 UI 언어를 영어·중국어로만 판정해 한국어 앱을 영어로 보고 기본 프롬프트를 "영어 우선"으로 바꾼다(실측에서 전부 영어 제목). 프롬프트를 바꾸면 그 지시가 언어를 정하므로 한국어를 명시한다 |

- 목록의 소스에서 설치되어 실행 중인 플러그인만 맞춘다. 개발용 폴더 설치와 꺼진 플러그인은 건드리지 않는다. 데몬을 막 켰거나 방금 설치한 플러그인은 실행될 때까지 10초 기다리고, 그래도 실행 중이 아니면 동기화 기록을 남기지 않아 다음 실행에서 다시 맞춘다.
- 앱의 플러그인 설정 화면과 같은 설정 RPC(`settings.<ID>.read`/`write`)를 Paseo 앱의 Node 런타임과 앱 내부 클라이언트 모듈로 부른다(`scripts/paseo-plugins-settings-client.mjs`). 공개 CLI가 아니어서 Paseo 버전에 따라 깨질 수 있다. 실패하면 저장값을 다시 읽어 실패로 남기므로, 그때는 앱의 플러그인 설정에서 맞추고 스크립트를 고친다. PATH의 `paseo`가 앱 CLI가 아닌 기기(npm 설치)는 맞추지 못하고 알린다.
- 모델 ID는 `paseo provider models <provider>`로 확인한다. 그 기기에 provider가 없거나 모델이 사라지면 설정은 저장되지만 제목 생성이 실패한다(Tasks 카드에 오류 표시).

`paseo` 단계가 하는 일:

- 플러그인 사용(`pluginsEnabled`, 앱의 Enable plugins)이 꺼져 있으면 켠다. bootstrap 기기는 이 목록의 플러그인을 쓰기로 이미 정한 기기로 본다.
- 없는 플러그인을 설치한다. 목록에 있는 플러그인을 기기에서 지우면 다음에 이 단계가 돌 때 다시 설치된다. 빼려면 목록에서 뺀다.
- `ref` 또는 `version`이 `latest`인 플러그인은 초기 설치 시 레지스트리 최신 검토본이나 Git 기본 브랜치의 최신 커밋을 받는다. 설치 뒤 버전 변경은 아래 수동 갱신 절차를 따른다. 저장소에서 버전을 관리할 항목은 `latest` 대신 Git의 커밋 전체 해시 또는 레지스트리의 패키지 버전·커밋 해시를 지정한다.
- 목록에서 빼기만 한 플러그인은 기기에서 지우지 않는다. 모든 기기에서 지우려면 `plugins`에서 빼고 `retired`에 `{ "id", "source" }`로 옮긴다. 그 소스에서 설치된 것만 `paseo plugin remove`로 지우고(플러그인 데이터도 함께 지워진다), 폴더·다른 소스 설치는 유지하고 알린다. 모든 기기가 갱신된 뒤에도 남겨 두면 나중에 맞추는 기기에서도 지운다.
- 맞춘 뒤 목록을 다시 읽어, 버전이 맞지 않거나 이번에 설치·갱신한 플러그인이 실행되지 않으면 실패로 남긴다(자동 갱신 알림·재시도 대상).
- 폴더에서 설치한 플러그인(개발 중)과 다른 소스에서 설치한 플러그인은 그대로 두고 알리기만 한다. 꺼 둔 플러그인도 켜지 않는다.
- 설치·갱신은 실행 중인 데몬이 한다. 데몬이 꺼져 있으면 이 기기에서 마지막으로 맞춘 기록만 본다. 그 뒤 목록이 바뀌었으면 데몬을 잠시 켜서 맞추고 다시 끈다. 기록은 `~/.local/state/bootstrap/paseo-plugins/`.

`doctor`는 설치 누락, 버전 차이, 은퇴한 플러그인의 잔류, 설정 차이, 꺼짐, 실행 안 됨, 다른 소스를 경고한다. 개발 중인 폴더 설치는 표시만 한다.

### 플러그인 갱신

플러그인 코드는 데몬 권한으로 실행된다. 터미널에서 `paseo plugin update --all --check`로 후보 버전과 리뷰 링크를 볼 수 있다. `paseo plugin update zerosub` 또는 `paseo plugin update --all`은 후보를 다시 표시하고 승인한 버전을 적용한다. [Paseo CLI 문서](https://paseo.sh/docs/plugins/reference#cli-reference)

고정된 플러그인만 `node scripts/paseo-plugins.mjs --bump`로 새 버전을 확인하고 목록을 갱신한다. 변경을 bootstrap main에 반영하면 다른 기기에도 적용된다.

### 플러그인 개발

개발 중에는 폴더에서 설치한다. 폴더 설치는 bootstrap이 건드리지 않는다. 절차는 [paseo-plugin의 개발 안내](https://github.com/01-works/paseo-plugin#개발). ZeroSub의 계정 로그인·전환 설정은 [ZeroSub 안내](https://github.com/01-works/paseo-plugin/blob/main/docs/plugins/zerosub.md).

### Paseo 새 버전

노트북은 앱이 스스로 업데이트한다(정식은 36시간에 걸쳐 단계 배포). 앱의 업데이트 확인은 앱 화면이 켜져 있을 때만 돌아서, 앱 없이 데몬만 띄우는 데스크톱은 따로 올린다. `paseo` 단계가 등록한 LaunchAgent(`local.bootstrap.paseo-upgrade`)가 한 시간마다 `./bootstrap.sh paseo-upgrade --auto`를 실행한다 (`scripts/paseo-upgrade.sh`).

- 하루에 한 번 Homebrew cask의 최신 버전과 그 GitHub 릴리스 공개 시각을 확인한다. 공개 시각은 `gh`에 로그인된 토큰으로 받고, 안 되면 로그인 없이 받는다(IP마다 시간당 60회라 같은 IP의 다른 도구와 나눠 쓰다 막힌다). 못 받으면 한 시간 뒤 다시 확인한다. 공개 뒤 36시간(공식 단계 배포 기간)이 지난 버전만 올린다. 이틀 사이에 핫픽스가 이어지는 경우가 있어서다.
- 실행 중(running)인 에이전트가 있으면 올리지 않고 한 시간 뒤 다시 본다. 하루 넘게 못 올리면 한 번 알리고(`doctor`에도 대기로 표시), 한가할 때 터미널에서 `./bootstrap.sh paseo-upgrade --force`로 올린다. `--force`는 36시간 대기와 실행 중 에이전트 확인을 건너뛰고, 진행 중인 작업은 끊긴다.
- `brew upgrade --cask paseo`는 cask 제거 단계에서 데몬을 멈춘다(`paseo daemon stop --force`). 끝나면 `local.bootstrap.paseo`로 데몬을 다시 띄우고 새 버전으로 응답하는지 확인한다. 실패하면 옛 버전으로라도 다시 띄우고 실패로 알린다.
- 앱이 스스로 새 버전이 됐는데 데몬이 옛 버전이면 데몬만 멈췄다가 시작한다. `paseo daemon restart`는 supervisor를 바꾸지 않아 버전이 바뀌지 않는다 ([CLI 문서](https://paseo.sh/docs/cli.md)).
- 앱 화면이 켜져 있거나 앱을 Homebrew 밖에서 설치했으면 앱은 앱의 자동 업데이트에 맡기고 데몬 버전만 맞춘다.
- Paseo 에이전트 안에서는 실행하지 않는다. 데몬을 멈추면 그 에이전트도 끝나기 때문이다. 미리 보기는 `--dry-run`. 기록은 `~/.local/state/bootstrap/paseo-upgrade/` (`upgrade.log`, `status`).
- 끄기: `launchctl bootout gui/$(id -u)/local.bootstrap.paseo-upgrade` 후 `~/Library/LaunchAgents/local.bootstrap.paseo-upgrade.plist`를 지운다.

플러그인의 요구 버전(`paseo-plugin.json`의 `requirements.paseo`)은 데몬이 설치·시작·reload 때, 앱이 client 실행 전에 각자 검사해서, 범위를 벗어나면 업데이트된 기기마다 플러그인이 멈춘다.

- 자체 플러그인은 최소 버전만 적고 상한을 두지 않는다. 새 Paseo가 나와도 미리 할 일은 없다.
- paseo-plugin의 [Paseo 새 버전 검사](https://github.com/01-works/paseo-plugin/blob/main/.github/workflows/paseo-next.yml)가 `latest`·`beta` SDK로 조기 경보를 낸다. 정식 전 발견이나 실제 호스트 동작을 보장하지는 않는다. 실패하거나 새 마이너가 나오면 [paseo-plugin의 대응 절차](https://github.com/01-works/paseo-plugin#paseo-새-버전)를 따르고 [플러그인 갱신](#플러그인-갱신) 절차로 수정본을 적용한다.
- 이미 올라간 기기에서 깨지면 상한을 붙인 버전은 그 기기에서 거부되므로 수정본을 배포한다. `doctor`는 데몬 쪽 실행 실패만 경고하고, 앱 화면의 실패는 잡지 못한다.

## 새 기기에서

`paseo` 단계가 설정이 없으면 앱의 첫 실행 화면 대신 공식 CLI로 첫 설정을 하고 데몬을 띄운다: `paseo onboard --relay --voice disable`. 고정값은 원격(릴레이) 연결 켬, 음성 기능 끔이다. 이어서 같은 단계에서 프로필과 Paseo 도구 설정까지 끝난다. 다른 기기(노트북·휴대폰)의 앱은 데스크톱 데몬에서 `paseo daemon pair`로 받은 연결 링크로 붙는다(릴레이). 에이전트는 같은 링크를 `paseo --host '<링크>' ls`처럼 CLI에 준다. 링크는 데몬 접속 권한 자체라 저장소·공유 문서에 넣지 않는다. 감독 기기에 작업 기기를 host로 등록하는 절차는 [README](../README.md#작업-기기를-paseo-host로-등록-처음-한-번)를 따른다 ([원격 접속](../macos/system-settings.md#원격-접속)).

늘 켜두는 기기(배터리 없음)는 LaunchAgent `local.bootstrap.paseo`가 로그인할 때 `paseo daemon start`를 실행한다. 이미 실행 중이면 아무것도 하지 않는다. 노트북은 앱을 열 때 데몬이 함께 뜬다. 데스크톱에서 끄려면 `launchctl bootout gui/$(id -u)/local.bootstrap.paseo` 후 `~/Library/LaunchAgents/local.bootstrap.paseo.plist`를 지운다. 설치한 스킬이 현재 세션에 보이지 않으면 새 에이전트를 연다.

작업자의 브라우저 작업은 [브라우저 작업](browser.md)의 운영 규칙(공유 연결, own 탭, 순서대로 조작)을, 네이티브 GUI 작업은 [기기 GUI 작업](computer-use.md)을 따른다. Paseo 작업자의 Computer Use 지원은 확인되지 않았으므로 GUI 작업을 기본으로 배정하지 않는다.
