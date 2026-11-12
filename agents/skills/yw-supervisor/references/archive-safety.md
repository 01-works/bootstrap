# archive 전 공통 안전 대조

에이전트·workspace를 archive하는 모든 경로에 적용한다. 부모 archive는 `paseo.parent-agent-id`를 따라 후손을 연쇄 archive하거나 부모 관계를 제거할 수 있다. Paseo 0.15.3·0.15.4에서 다른 workspace이거나 열린 탭 라벨이 있는 하위만 자동 분리하고 나머지는 closed 여부와 무관하게 연쇄 archive함을 확인했다. CLI에 `--force`를 주지 않아도 후손은 보호되지 않는다.

- **후손 전체 조회:** 에이전트 archive는 대상 에이전트부터, workspace archive는 그 workspace의 모든 에이전트부터 `paseo.parent-agent-id` 값이 현재 노드 ID인 자식을 찾고 재귀로 끝까지 조회한다. 직계 자식이나 같은 workspace 목록만으로 끝내지 않는다. 연쇄는 같은 호스트 registry 안에서만 전파된다. 각 노드에서 `paseo agent ls -g --background --label paseo.parent-agent-id=<전체 ID> --json`을 반복하고 원격은 `--host <검증한 endpoint>`를 붙인다. CLI는 cursor로 끝까지 조회한다. MCP `list_agents`는 최대 200개이며 cursor가 없어 전체 후손 조회 수단으로 쓰지 않는다. `sinceHours`는 미보관 에이전트를 시간으로 제외하지 않고, 보관된 항목을 포함할 때 그 항목의 활동 시각에 적용된다(Paseo 0.15.3·0.15.4). 다른 workspace·별도 탭 자식의 자동 detach 분기를 보호 근거로 삼지 않고 후손 대조에 포함한다. 관계·조회 범위를 확인할 수 없으면 보류한다. parent 라벨이 없는 에이전트는 연쇄 대상이 아니지만 workspace archive에는 포함되므로, workspace 조건과 개별 대조로 확인한다.
- **범위·완료·소유:** closed를 포함한 모든 후손과 인계 체인을 완료·소유 판정에 포함한다. 정리 대상 밖이거나 완료·소유를 확인하지 못한 후손이 하나라도 있거나 필요한 알림 중계가 남아 있으면 기본적으로 부모 archive를 보류한다. 부모의 완료·closed 상태만으로 후손의 완료를 판단하지 않는다.
- **권한 내 분리:** 기존 권한 범위에서 `paseo agent detach <전체 agent ID>`로 분리할 때는 소유와 현재·새 보고 경로(`{serverId, agentId}`, 자동 알림 의존 여부)를 먼저 확인한다. 다른 소유자의 살아 있는 세션 detach는 일반 정리 권한에 포함되지 않는다. 소유 감독의 동의를 받고, 연락이 안 되면 사용자 승인을 받는다. 감독 세션 자체를 detach할 때 동의 주체는 그 감독 자신이나 사용자이며, archive하려는 부모의 동의로 대신하지 않는다. 실행 뒤 parent 라벨이 제거됐는지, workspace·실행 상태가 보존됐는지 readback하고 새 보고 경로를 기록한다. 자동 알림이 새 감독에게 이어진다고 가정하지 말고 후속 결과의 직접 보고 경로를 해당 세션에 알린다.
- **실행 직전 대조:** detach 뒤에는 남은 후손 전체를 다시 조회하고, archive 호출 직전에 대상·후손의 관계와 상태를 재확인한다. 조회 누락, 분리 실패, 실행 직전 관계·상태 변화(후손의 running·백그라운드 대기·새 요청 포함)가 있으면 archive를 보류하고 이유를 보고한다. `--force`나 MCP로 우회하지 않는다. 다음 재개 루프를 적용한다.

  1. 승인 범위·완료·소유 조건을 충족한 잎 하나를 고른다.
  2. 호출 직전에 그 대상의 후손 전체를 다시 조회해 미보관 후손이 0인지 확인한다.
  3. 그 대상만 CLI로 `--force` 없이 archive한다.
  4. 대상과 영향받는 후손의 `Archived`·`ArchivedAt`·부모 관계를 readback한다.
  5. 확인에 성공한 뒤에만 다음 대상으로 1)부터 반복한다.
  6. 구성원 처리가 끝나면 workspace 조건(자기·살아 있는 감독의 작업 공간 아님, 모든 구성원 완료·소유, 미커밋 변경·터미널 없음)을 다시 확인한다.
  7. workspace를 archive하고 readback한다.

  미확인, 조건 불충족, readback 실패가 있으면 그 대상과 그것에 의존하는 부모·workspace에서 멈추고 보존한다.

- **에이전트 archive 경로:** 로컬·원격 모두 `paseo agent archive <전체 agent ID>`를 `--force` 없이 사용하고 원격에는 `--host <검증한 endpoint>`를 붙인다. MCP `archive_agent`는 실행 중인 대상도 중단시키므로 쓰지 않는다. CLI의 running 거절은 대상 하나의 사전 검사로 위험을 줄일 뿐, 검사 이후 실행·관계 변화나 후손의 running을 보호하는 원자적 보장은 아니다. 이미 archive된 응답은 아래 상태 변경 확인을 따르고, 그 밖의 거절 시 보존하고 거절 사유와 실제 상태를 기록한다.
- **상태 변경 확인:** 라벨·heartbeat/schedule·archive 상태를 바꾼 뒤에는 대상 ID의 실제 상태를 다시 읽고 확인 결과를 기록한다. 성공 반환만으로 적용됐다고 쓰지 않는다. 에이전트 archive 뒤에는 `paseo agent inspect <전체 ID> --json`의 `Archived`·`ArchivedAt`과 부모 관계(`ParentAgentId`)를 대상 및 영향받는 하위에서 확인한다(원격은 검증한 `--host` 사용). 활성 목록에서 사라진 것만으로 성공을 판정하지 않는다. 이미 archive된 경우 기본 출력은 `Error: Agent … is already archived`이며 `--json`에서만 `AGENT_ALREADY_ARCHIVED` 코드가 나온다. 어느 출력이든 같은 readback으로 `Archived: true`와 `ArchivedAt`을 확인한 뒤 성공으로 처리하고, 확인할 수 없으면 보류한다.
- **workspace 추가 조건:** 구성원은 MCP `list_agents(cwd, includeBackground: true, limit: 200)`로 조회하고 결과가 200개면 보류한다. 대상 workspaceId·cwd가 감독 자신이나 다른 살아 있는 감독의 workspace가 아닌지, workspace의 모든 에이전트가 완료·소유 확인된 정리 대상 lane 소속인지, running agent·미커밋 변경·터미널이 없는지 대조한다(터미널은 로컬 `list_terminals(cwd)`, 원격 `paseo terminal ls --workspace <workspace ID> --host <endpoint>`로 확인). 어느 조건이든 충족하지 못하거나 확인할 수 없으면 workspace를 남기고 보고한다.
