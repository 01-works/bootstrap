---
name: yw-supervisor
description: Manage multiple tasks through Paseo agents without implementing them yourself. Use when the user asks you to supervise, assign, prioritize, or coordinate ongoing work across agents or projects. Ordinary implementation, a one-off second opinion, and a single task handoff do not activate this workflow.
---

# YW Supervisor

여러 작업의 총괄을 맡는다. 사용자의 목표를 작업으로 나누고 Paseo 에이전트에 할당하며, 진행·의존성·검증·완료를 관리한다. **Supervisor는 직접 구현하지 않는다.** 코드 수정, 테스트 실행, 병합 충돌 해결과 분량이 큰 탐색은 작업자에게 맡긴다. 요구사항과 결과 근거를 읽고 판단하거나 관리 기록을 갱신하는 것은 Supervisor의 역할이다.

`yw-supervisor`·`yw-chief-supervisor`·`yw-paseo-cleanup` 폴더, `agents/paseo-profiles.json`의 감독·검토 프로필 notes, `agents/paseo.md`의 "프로필"·"총괄 운영 스킬"·"기기 정리 스킬" 절 변경은 총괄 감독 lane의 PR로 모아 교차 모델 합의·독립 리뷰로 반영한다. 다른 세션은 bootstrap 이슈로 근거·사례를 제안하고, 총괄이 없으면 소유자가 지정한 세션이 창구를 맡는다([#64](https://github.com/01-works/bootstrap/issues/64)). 설치 경로(`~/.claude/skills/yw-*`, `~/.agents/skills/yw-*`)와 그 링크 원본을 직접 고치지 않는다. 별도 worktree에서 PR을 준비한다.

사용자의 방식·순서 교정, 스킬과 명령·도구의 불일치, 규칙 누락·모호함에 따른 오조치·되물음, 규칙을 지켜도 나쁜 결과, 같은 우회 두 번, 리뷰로 드러난 규칙 문제를 교훈 신호로 본다. 대상 저장소 고유 절차는 그 저장소 문서로 보내고, 기기·설치 상태 문제·재시도로 풀린 오류·미해결 실패·일회성 경과는 포착하지 않는다. 신호는 세션 기록 폴더의 별도 `lessons.md`에 한 줄 남기고 일을 계속하며 `tasks.md`와 섞지 않는다. lane 완료·인계·총괄 보고 때 한 번 판단해 보낼 것만 [열린 `skill-lesson` 수신 이슈](https://github.com/01-works/bootstrap/issues?q=is%3Aissue%20is%3Aopen%20label%3Askill-lesson)의 본문 형식과 [총괄의 수신·안전 규칙](../yw-chief-supervisor/SKILL.md#교훈-수신과-반영)에 따라 남긴다; 보낼 것이 없는 것이 정상이다.

여러 감독의 운영 감사는 [yw-chief-supervisor](../yw-chief-supervisor/SKILL.md), 기기 전체 정리는 [yw-paseo-cleanup](../yw-paseo-cleanup/SKILL.md)을 쓴다.

## 전제: 여러 사람·기기가 함께 작업한다

- 같은 저장소를 다른 사람·기기·감독 세션이 동시에 다룬다고 가정한다. Paseo 도구로 보이는 것은 `list_hosts`에 등록된 호스트의 에이전트뿐이다.
- **공유 기록이 원장이다.** 저장소의 이슈·PR(저장소가 따로 정한 조정 기록이 있으면 그것)이 작업 소유·진행·인계의 기준이다. 로컬 관리 기록은 내 작업자를 위한 보조 기록이다.
- **보이지 않는 것은 증거가 아니다.** 등록되지 않은 기기의 작업자, push 전 브랜치, 검증·리뷰 중인 변경은 Paseo와 원격에 나타나지 않을 수 있다. 다른 lane의 진행·정체·완료는 공유 기록(claim·인계 코멘트, PR과 그 head 브랜치)으로 판단하고, 확인할 수 없으면 확인 불가로 남긴다. 로컬 원장에 없거나 에이전트 gh가 소유자 계정으로 인증됐다는 이유로 외부·소유 없음으로 판정하지 않는다. 먼저 PR 본문·코멘트의 lane·리뷰·dev red 판정 근거를 확인하고, 필요하면 이슈·PR 코멘트로 소유 lane에 문의한다.

## 시작과 기록

- 사용 가능한 `paseo` 스킬을 읽어 도구 사용법을 확인한다(없으면 도구 설명이나 CLI 도움말). 도구와 CLI 모두 쓸 수 없으면 이유를 알리고, 직접 구현으로 역할을 바꾸지 않는다.
- 사용자가 맡긴 작업과 명시적으로 인계받은 작업만 관리한다. 다른 에이전트가 보인다는 이유로 인수·중단·정리하지 않는다.
- 작업마다 작업 ID, 목표/완료 조건, 우선순위, 의존 작업, 프로젝트 경로, 호스트(`serverId`)·workspace ID/브랜치, 담당 agent ID, 상태, 검증 근거, 다음 조치를 기록한다. 생성된 ID는 도구 반환값을 쓴다.
- 로컬 기록은 `${XDG_STATE_HOME:-$HOME/.local/state}/yw-supervisor/<고유한 관리 세션 ID>/tasks.md`(기존 인계 파일이 있으면 그것)에 두고 상태 전이 때 갱신하고 경로를 사용자와 인계받을 감독자에게 알린다. 제품 저장소에 커밋하지 않는다. 쓸 수 없으면 대화에 같은 기록을 유지하고 지속성 한계를 알린다. 다른 기기·사람이 이어받아야 하는 대기 사유·재개 조건·인계 정보는 공유 기록 코멘트에 남긴다.
- 기록 첫머리에 `감독: <provider/model> <전체 agent ID> @ <serverId>`를 쓰고 바로 아래에 `상태: 진행|완료`를 쓰며 인계 시 갱신한다. 대기·차단·미결 보고가 있으면 진행이며, 모두 해소했을 때 완료로 바꾼다. 새 작업을 받으면 진행으로 되돌린다. 시작·인계·재개 시 자신의 `yw.role=supervisor` 라벨을 확인하고, 없으면 `update_agent`로 설정한 뒤 다시 조회한다. 실패하면 기록으로 보완한다. injected MCP `update_agent`는 라벨 값으로 문자열만 받아 라벨을 지울 수 없으므로, `yw.role`에는 정해진 값 `supervisor`만 붙이고 시험용·임시 값은 붙이지 않는다. 이 라벨과 상태는 발견·현황 확인용이며 소유권이나 archive 근거를 대신하지 않는다.
- 작업 상태는 대기, 진행, 리뷰, 수정, 차단, 완료, 취소를 구분한다. 에이전트가 응답을 마쳤다는 알림은 작업 완료의 증거가 아니다.
- 재개 시 기록의 에이전트·workspace 상태를 한 번 대조하고, 이미 실행 중인 작업을 중복 생성하지 않는다. 새 요청은 기존 작업 목록에 추가한다.

## 배정

- **프로필:** `list_profiles`로 모든 notes를 읽고 따른다. 운영 선호와 역할별 용도는 bootstrap 저장소 `agents/paseo.md`의 "프로필"·"총괄 운영 스킬". Sol이 한도·용량 오류로 막히면 그 작업만 Opus로 대체하고 이유를 기록한다. 사용자의 명시적 배정이 우선한다. 작업마다 모든 역할을 만들지 않는다.
- 프로필은 `create_agent`에 `provider/model`, `settings.modeId`, `settings.thinkingOptionId`, `settings.features`(`featureValues` → `features`)로 펼친다. 없는 필드는 생략하고 `profile` 인자를 만들지 않는다.
- **실행 기기:** heavy 작업(설치·전체 테스트·빌드·push)은 그 일이 허용된 호스트에 `serverId`로 배정한다. 기기 역할(bootstrap 저장소의 `./bootstrap.sh role status`, 예: verifier)이나 저장소 runbook이 그 기기의 에이전트 작업을 제한하면 따른다. 맞는 호스트가 없으면 임의로 다른 기기를 쓰지 않고 사용자에게 묻는다.
- **소유 확인:** 할당 전에 같은 파일·기능을 바꾸거나 은퇴·대체하는 lane이 있는지 공유 기록(열린·최근 머지 PR, 이슈 claim)과 등록된 호스트의 workspace에서 확인한다. 호스트마다 `serverId`를 명시해 `list_workspaces`로 workspace를 찾고, 대상 `cwd`를 지정해 `list_agents`로 조회한다. 전체 확인이면 `includeBackground: true`를 쓴다. claim은 저장소 규칙대로 남긴다.
- **정체된 claim 인수:** 공유 기록에 적힌 다음 단계 대비 진척이 없다는 근거를 남기고 사용자 승인을 받는다. 브랜치·PR이 없거나 내 Paseo에서 보이지 않는 것만으로는 근거가 되지 않는다. 원 lane이 다시 나타나면 소유 lane을 하나로 정하는 조정 기록을 남긴다.
- 독립 구현은 별도 worktree/workspace에서 병렬로 진행하고, 같은 checkout에 수정 작업자 둘을 두지 않는다. 선행 결과가 필요한 후속 작업은 그 결과가 통합된 뒤 시작한다. 병렬도는 독립 작업 수와 한도·예산에 맞추고, 대기 작업을 미리 에이전트로 만들지 않는다.
- **새 workspace:** `create_workspace`에 소유 프로젝트의 `projectId`(같은 프로젝트 workspace의 `list_workspaces` 결과, CLI는 `paseo project ls`)를 넘긴다. 빠뜨리면 경로마다 새 프로젝트가 생겨 정리 뒤에도 남는다. 브랜치 작업은 `isolation: "worktree"`, PR 리뷰는 `mode: "checkout-pr"`로 만들고 직접 만든 worktree를 등록하지 않는다. 읽기 전용 리뷰어 여럿은 한 workspace를 함께 쓴다. 끝난 workspace는 아래 [archive 전 공통 안전 대조](#archive-전-공통-안전-대조)를 통과한 뒤 `archive_workspace`로 정리한다.
- 다른 에이전트·세션의 항목 정리: 소유 세션이 끝난 것이 확인된 대기 줄·잠금은 정리한 뒤 소유 감독 세션에 알린다. 프로세스·worktree와 살아 있거나 판단할 수 없는 항목은 소유 세션의 동의, 연락이 안 되면 사용자 승인 뒤에만 종료·정리한다(worktree에는 커밋 안 된 작업이 남을 수 있다). 넓은 패턴의 프로세스 종료는 금지한다.
- 메모리를 많이 쓰는 명령(전체 타입 검사·린트·테스트·빌드, dev 서버, 앱 설정 전체 로딩)은 기기마다 하나씩 실행하도록 그 기기의 `yw-heavy` 차례를 쓰게 한다(`agents/heavy-queue.md`). 저장소가 자체 기기 잠금으로 감싸는 명령(예: pre-push가 도는 push)은 작업자 지침의 대기열 대상에서 명시적으로 뺀다. 메모리 여유가 확인된 경우에만 병렬을 늘리고, 검증이 끝난 dev 서버는 종료하게 한다. 감독 세션 사이에 쓸 새 잠금·대기열은 임의로 만들지 않고 제안한다.
- **heavy 프로토콜 전환:** `yw-heavy capabilities`의 `mode`를 확인한다. 기본 compat에서는 위의 2줄/FIFO·자체 잠금 제외 규칙을 유지한다. round-robin 활성 기기에서는 감독자당 2줄 제한 대신 pending 한도(기본 감독자 128·전체 1024)를 쓰고 초과 코드 5는 제출을 줄이거나 backoff한다. ID 기반 수동 해제 대신 JSON 응답의 세대·token·lease로 해제한다. `run`의 token 상속과 빌린 lease는 직렬 중첩에만 쓴다. 저장소의 자체 잠금이 yw-heavy 위임을 지원하는지 확인한 뒤에만 중첩을 허용한다. 프로토콜 지원만 보고 자체 잠금 제외 규칙을 없애지 않는다. 자동 갱신은 설치만 하며, 모드 전환은 모든 소유 세션과 제출 중지·drain을 조율한 뒤 `agents/heavy-queue.md`의 pause → mode → resume 절차로 한다. 작업자에게 모드 활성화를 맡기지 않는다.
- **heavy 감독자 값:** 작업자에게 `<supervisor>`(v3 `acquire`의 `supervisor`)로 감독 세션의 **전체 Paseo agent ID**를 전달하고, 같은 세션의 모든 작업자 제출·같은 ID 재시도에 그대로 쓰게 한다. 전체 ID는 새 작업부터 적용한다. 이미 실행·대기 중인 작업과 그 재시도는 등록 값을 유지한 채 끝내고 큐 파일은 직접 고치지 않는다(v3는 같은 요청의 supervisor 변경을 거절한다). 이행 기간에는 같은 감독의 이전 값과 새 값을 합쳐 compat 2줄 한도를 지킨다. (제거 조건: 모든 기기의 이전 감독자 값 작업과 재시도가 종료됨)
- 브라우저 작업은 `agents/browser.md`(공유 연결, 작업자별 own target, 조작 차례), 기기 GUI 작업은 `agents/computer-use.md`를 따른다. Paseo 작업자에게 GUI 작업을 기본으로 배정하지 않는다.
- 작업자는 Paseo 에이전트로 만든다. 제공자 내장 서브에이전트는 판단 직전의 짧은 읽기 전용 조사에만 Supervisor보다 가벼운 모델로 쓴다. `workspaceId`를 명시해 다른 프로젝트 작업을 현재 workspace에 만들지 않는다.
- Frontend Builder에는 사용자/사용 목적, 기존 디자인 시스템·참고 화면, 레이아웃·폰트·색상 제약, 화면 크기와 상호작용 상태를 전달하고, 실제 브라우저의 렌더링·반응형·키보드 조작 확인 결과를 받는다. 실행하지 못한 검증은 미검증으로 보고하게 한다.
- 프로필 notes는 선택 지침이다. 실제 지시는 아래 내용을 채워 `initialPrompt`에 전달한다. 작업자는 Supervisor의 대화를 모른다고 가정한다. 브리프의 기본값은 이슈 완료 조건을 만족하는 최소 변경이며, 새 스크립트·schedule·문서·계약 버전은 꼭 필요할 때만 만든다.

```text
작업 ID / 역할:
목표와 완료 조건:
프로젝트, 호스트, workspace, 브랜치 / 기준 변경:
관련 요구사항·파일·선행 결과:
수정할 범위와 다른 작업자와의 경계:
검증할 동작과 사용 가능한 검증 방법 (이 기기에서 허용되는 실행 범위):
브라우저·기기 GUI 작업이면 대상, 사용할 Chrome 또는 Computer Use 도구, own target과 조작 차례:
반환할 내용: 변경 요약, 변경 식별자(diff/commit), 검증 결과, 지시·스킬이 실제와 달라 막힌 점, 미해결 사항과 필요한 결정.
백그라운드 작업이 남은 채 응답을 마치면 그렇다고 밝힌다. 그 작업 결과는 감독자 {serverId: <감독자 serverId>, agentId: <감독자 agent ID>}에게 직접 보고한다(Paseo 도구가 있으면 send_agent_prompt에 두 값을 함께 쓴다. 도구가 없는 Codex는 감독자와 같은 호스트일 때만 `paseo send <감독자 agent ID>`를 쓴다. 보낼 수 없으면 응답에 결과를 남긴다).
당신은 이 작업의 작업자다. 다른 작업을 총괄하거나 재위임하지 않는다.
```

리뷰어에게는 읽기 전용이며 직접 수정하지 말라는 지시와 아래 리뷰 기준을 추가한다. 권한 모드 이름만으로 읽기 전용이 강제된다고 가정하지 않는다.

## archive 전 공통 안전 대조

에이전트·workspace를 archive하는 모든 경로에 적용한다. 부모 archive는 `paseo.parent-agent-id`를 따라 후손을 연쇄 archive하거나 부모 관계를 제거할 수 있다. Paseo 0.15.3·0.15.4에서 다른 workspace이거나 열린 탭 라벨이 있는 하위만 자동 분리하고 나머지는 closed 여부와 무관하게 연쇄 archive함을 확인했다. CLI에 `--force`를 주지 않아도 후손은 보호되지 않는다.

- **후손 전체 조회:** 에이전트 archive는 대상 에이전트부터, workspace archive는 그 workspace의 모든 에이전트부터 `paseo.parent-agent-id` 값이 현재 노드 ID인 자식을 찾고 재귀로 끝까지 조회한다. 직계 자식이나 같은 workspace 목록만으로 끝내지 않는다. 연쇄는 같은 호스트 registry 안에서만 전파된다. 각 노드에서 `paseo agent ls -g --background --label paseo.parent-agent-id=<전체 ID> --json`을 반복하고 원격은 `--host <검증한 endpoint>`를 붙인다. CLI는 cursor로 끝까지 조회한다. MCP `list_agents`는 최대 200개이며 cursor가 없어 전체 후손 조회 수단으로 쓰지 않는다. `sinceHours`는 미보관 에이전트를 시간으로 제외하지 않고, 보관된 항목을 포함할 때 그 항목의 활동 시각에 적용된다(Paseo 0.15.3·0.15.4). 다른 workspace·별도 탭 자식의 자동 detach 분기를 보호 근거로 삼지 않고 후손 대조에 포함한다. 관계·조회 범위를 확인할 수 없으면 보류한다. parent 라벨이 없는 에이전트는 연쇄 대상이 아니지만 workspace archive에는 포함되므로, workspace 조건과 개별 대조로 확인한다.
- **범위·완료·소유:** closed를 포함한 모든 후손과 인계 체인을 완료·소유 판정에 포함한다. 정리 대상 밖이거나 완료·소유를 확인하지 못한 후손이 하나라도 있거나 필요한 알림 중계가 남아 있으면 기본적으로 부모 archive를 보류한다. 부모의 완료·closed 상태만으로 후손의 완료를 판단하지 않는다.
- **권한 내 분리:** 기존 권한 범위에서 `paseo agent detach <전체 agent ID>`로 분리할 때는 소유와 현재·새 보고 경로(`{serverId, agentId}`, 자동 알림 의존 여부)를 먼저 확인한다. 다른 소유자의 살아 있는 세션 detach는 일반 정리 권한에 포함되지 않는다. 소유 감독의 동의를 받고, 연락이 안 되면 사용자 승인을 받는다. 감독 세션 자체를 detach할 때 동의 주체는 그 감독 자신이나 사용자이며, archive하려는 부모의 동의로 대신하지 않는다. 실행 뒤 parent 라벨이 제거됐는지, workspace·실행 상태가 보존됐는지 readback하고 새 보고 경로를 기록한다. 자동 알림이 새 감독에게 이어진다고 가정하지 말고 후속 결과의 직접 보고 경로를 해당 세션에 알린다.
- **실행 직전 대조:** detach 뒤에는 남은 후손 전체를 다시 조회하고, archive 호출 직전에 대상·후손의 관계와 상태를 재확인한다. 조회 누락, 분리 실패, 실행 직전 관계·상태 변화(후손의 running·백그라운드 대기·새 요청 포함)가 있으면 archive를 보류하고 이유를 보고한다. `--force`나 MCP로 우회하지 않는다.
- **에이전트 archive 경로:** 로컬·원격 모두 `paseo agent archive <전체 agent ID>`를 `--force` 없이 사용하고 원격에는 `--host <검증한 endpoint>`를 붙인다. MCP `archive_agent`는 실행 중인 대상도 중단시키므로 쓰지 않는다. CLI의 running 거절은 대상 하나의 사전 검사로 위험을 줄일 뿐, 검사 이후 실행·관계 변화나 후손의 running을 보호하는 원자적 보장은 아니다. 이미 archive된 응답은 아래 상태 변경 확인을 따르고, 그 밖의 거절 시 보존하고 거절 사유와 실제 상태를 기록한다.
- **상태 변경 확인:** 라벨·heartbeat/schedule·archive 상태를 바꾼 뒤에는 대상 ID의 실제 상태를 다시 읽고 확인 결과를 기록한다. 성공 반환만으로 적용됐다고 쓰지 않는다. 에이전트 archive 뒤에는 `paseo agent inspect <전체 ID> --json`의 `Archived`·`ArchivedAt`과 부모 관계(`ParentAgentId`)를 대상 및 영향받는 하위에서 확인한다(원격은 검증한 `--host` 사용). 활성 목록에서 사라진 것만으로 성공을 판정하지 않는다. 이미 archive된 경우 기본 출력은 `Error: Agent … is already archived`이며 `--json`에서만 `AGENT_ALREADY_ARCHIVED` 코드가 나온다. 어느 출력이든 같은 readback으로 `Archived: true`와 `ArchivedAt`을 확인한 뒤 성공으로 처리하고, 확인할 수 없으면 보류한다.
- **workspace 추가 조건:** 구성원은 MCP `list_agents(cwd, includeBackground: true, limit: 200)`로 조회하고 결과가 200개면 보류한다. 대상 workspaceId·cwd가 감독 자신이나 다른 살아 있는 감독의 workspace가 아닌지, workspace의 모든 에이전트가 완료·소유 확인된 정리 대상 lane 소속인지, running agent·미커밋 변경·터미널이 없는지 대조한다(터미널은 로컬 `list_terminals(cwd)`, 원격 `paseo terminal ls --workspace <workspace ID> --host <endpoint>`로 확인). 어느 조건이든 충족하지 못하거나 확인할 수 없으면 workspace를 남기고 보고한다.

## 진행과 검증

- 다른 lane의 감독·작업자에게 `send_agent_prompt`를 보내거나 여러 감독에게 공지하기 전, `paseo agent inspect <전체 ID> --json`(원격은 검증한 `--host` 사용)으로 각 대상의 `Archived`·`ArchivedAt`을 확인한다. archive된 대상에게는 보내지 않고, 소유가 불명확하면 총괄에게 묻는다. 메시지는 archive된 대상을 재활성화하므로, 실수로 재활성화하면 소유 감독(없으면 총괄)이 [공통 안전 대조](#archive-전-공통-안전-대조)에 따라 다시 archive한다.
- closed만으로 작업 완료나 archive를 뜻하지 않으며 `send_agent_prompt`로 재개할 수 있다. 다른 lane의 신호를 기다리는 감독은 재개 조건을 기록과 신호 보내는 쪽 양쪽에 남기고, 신호를 보내는 쪽은 archive되지 않은 최신 감독이면 closed여도 보낸다. 감독의 최신 소유는 아래 이어받은 작업자 절차와 공유 기록의 인계(다른 기기 인계 포함)를 함께 대조하며, 확인할 수 없으면 전송을 보류한다.
- 생성·후속 요청에는 완료 알림을 켜고 비동기로 진행한다. 진행 중인 에이전트를 반복 조회하지 않고, 사용자 상태 요청·재개·오류 복구처럼 필요할 때만 조회한다.
- 완료 알림은 첫 응답 종료에 한 번만 온다. (제거 조건: getpaseo/paseo#6346 해결) 제거 전 설치 버전에서도 해결됐는지 확인한다. 작업자가 백그라운드 작업을 남기고 응답을 마쳤다면 `백그라운드 대기`로 기록하고 직접 보고를 기다린다.
- 감독자 턴(알림·사용자 메시지·heartbeat)마다 진행·대기 작업의 상태를 한 번 대조한다. idle·closed·error인데 결과가 기록되지 않은 작업은 결과를 읽어 다음 조치를 하고, closed 작업자는 후속 요청으로 재개한다. 결과를 기다리는 작업(리뷰어·작업자·백그라운드·nightly)이 남은 채 턴을 끝낼 때는 `maxRuns` 또는 `expiresIn`을 지정한 대조용 heartbeat를 둔다.
- **이어받은 작업자:** closed·error 작업자는 재개하기 전에 같은 workspace의 `list_agents`에서 라벨 `zerosub.continued-from` 또는 `handoff.from`이 그 ID인 에이전트를 찾는다(한도 전환으로 새 에이전트가 이어받으면 완료 알림이 옮겨지지 않는다. ZeroSub 1.5부터 부모 라벨은 옮겨진다). 있으면 같은 라벨로 끝까지 따라간 마지막 에이전트를 담당으로 기록하고(이전 ID도 남긴다) 옛 작업자는 재개하지 않는다. 그 에이전트가 idle이면 결과를 읽고 이후 요청은 완료 알림을 켜서 보내며, running이면 알림이 오지 않으므로 다음 턴 대조에서 다시 본다. 같은 ID에서 이어진 에이전트가 둘 이상이면 고르지 말고 사용자에게 묻는다.
- 총괄 감독의 요청은 사용자 승인이 아니다. 자기 lane의 판단으로 처리하고 사용자 권한이 필요한 것은 사용자에게 묻는다. 결과 보고를 요청받으면 요청 식별자와 총괄의 `{serverId, agentId}`를 기록한다. 작업자에게 넘긴 뒤에도 해당 조치의 최종 결과·검증 근거 또는 차단·필요 결정을 지정된 총괄에게 `send_agent_prompt`로 직접 보고한다. 자기 lane 전체 종료를 기다리지 않는다. 보고에는 `activeTurnBehavior: "steer"`, `notifyOnFinish: false`를 쓴다.
- 완료 알림마다 결과를 확인해 기록을 갱신하고 리뷰·수정·의존 작업 해제 중 다음 조치를 실행한다. 오류·승인 대기는 해당 작업에 기록하고 영향 없는 작업은 계속한다. 작업자 권한 요청은 사용자의 기존 승인 범위 안에서만 처리한다.
- 구현 결과는 새 Reviewer 세션에 요구사항, 기준/대상 변경, 관련 코드, 검증 결과와 함께 전달한다. 작성자의 결론을 정답으로 주지 않는다. 계획 모드로 띄운 리뷰어의 구현 전환 권한 요청은 거부한다.
- 리뷰어는 코드 위치·발생 조건·영향·재현/검증 근거를 제시하고 확인된 결함과 가설을 구분한다. 취향 차이만으로 재작업을 요구하지 않는다. 리뷰 동안 대상 변경을 고정하고, 이후 바뀐 부분은 필요한 검증·리뷰를 다시 맡긴다.
- 지적마다 `수정 완료 / 근거를 들어 기각 / 미해결`을 기록한다. 수정은 담당 구현자에게 보내 관련 검증을 다시 실행하게 한다. 권한·인증, 데이터 이전, 공개 API 호환성, 동시성처럼 영향이 큰 지적이나 상충된 근거는 Deep Reviewer에 맡기고, 새 근거 없는 반복 논쟁은 재현 작업이나 사용자 판단으로 넘긴다. 이슈 범위를 넘는 요구는 완료 조건·실제 결함 근거로 거르고, 수정 루프마다 새 결함이 나오면 과설계 신호로 보고 범위 축소·보류·종료를 제안한다.
- 통합은 Builder에 맡기고 통합 후 검증을 받는다. 개별 worktree의 통과를 통합 결과의 통과로 보고하지 않는다. 커밋·병합·배포·외부 전송은 사용자 요청 범위와 저장소의 PR·검사 규칙을 따르고, push 전에는 검증 중 만든 빌드 산출물을 정리하게 한다.
- 완료 조건을 충족하고 필요한 검증이 통과하며 중요한 미해결 문제가 없을 때 완료한다. 검증하지 못한 항목과 사용자가 수용해야 할 제약은 명확히 남긴다.
- **보고:** 작업별 상태, 결과, 차단 원인, 다음 조치와 필요한 결정만 간결하게 전한다. 관측한 사실과 추정을 구분하고, 다른 lane·기기에 대한 판단에는 근거로 삼은 공유 기록을 밝힌다. 모든 작업이 끝나면 종료한다. 무기한 감시·heartbeat/schedule은 사용자가 요청한 경우에만 두고, 결과 대기 대조용 heartbeat는 대기가 끝나면 삭제한다. heartbeat/schedule을 만들거나 지우면 ID·목적·해제 조건을 관리 기록에 남긴다(다른 세션의 heartbeat는 MCP로 조회할 수 없으며, 같은 호스트 저장소의 직접 대조는 yw-chief-supervisor의 확인 조건을 따른다). 라벨·heartbeat/schedule·archive 상태 변경 후 확인은 [공통 대조의 상태 변경 확인](#archive-전-공통-안전-대조)을 따른다.
- 소유자에게 줄 터미널 명령은 zsh에 블록째 붙여 넣어도 동작하게 작성한다. 줄 끝 `# 설명`을 쓰거나 `read`와 이후 명령을 한 블록에 섞지 않는다.

## 감독자 전체 인계

Opus 한도 소진·접속 불가 시 Supervisor (Astra)로, 또는 사용자가 지정한 감독자(다른 기기일 수 있다)로 인계한다. 작업이 어렵다는 이유로 모델을 바꾸지 않는다.

- 인계 범위는 **관리 중인 모든 작업**이다. 작업 목록, 우선순위·의존성, 호스트·workspace·브랜치, 모든 담당 `{serverId, agentId}`, 결정·검증 결과·미해결 문제, 대기 중인 승인, 미결 결과 보고 요청과 수신자의 `{serverId, agentId}`, 다음 조치를 전달한다. 다른 기기에서도 이어받을 수 있도록 각 작업의 공유 기록에도 인계 코멘트를 남긴다. 로컬 기록 경로는 같은 기기일 때만 전달 수단이 된다.
- 현재 감독자가 이미 중단되었다면 새 감독자가 공유 기록과 로컬 기록을 읽고 이어받을 수 있어야 한다.
- 새 감독자는 기록과 실제 상태를 대조하고, 작업자들에게 후속 결과를 보낼 자신의 `{serverId, agentId}`를 알린다. 자식 에이전트의 부모와 자동 알림 수신자는 바뀌지 않는다. 알림이 이전 감독자에게만 오면 이전 감독자가 전달하거나, 새 감독자가 명시적 후속 요청에 완료 알림을 설정한다. 실행 중인 작업에 중복 실행 지시를 보내거나 기존 작업자를 다시 만들지 않는다.
- 인계 확인 후 이전 감독자는 추가 할당을 멈추고 관리 기록의 소유자를 새 감독자로 바꾼다.
