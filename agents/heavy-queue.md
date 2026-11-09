# 공용 heavy 대기열 (yw-heavy)

전체 타입 검사·테스트·빌드, dev 서버처럼 메모리를 많이 쓰는 명령은 같은 기기에서 하나씩 실행한다. 감독 세션과 worktree가 달라도 같은 대기열을 쓴다. 원본은 `scripts/yw-heavy.sh`이고, 모든 기기에서 `heavy` 단계가 `~/.local/bin/yw-heavy`로 설치한다. 자동 갱신이 원본 변경을 전파한다.

## verifier 역할 기기

`${XDG_CONFIG_HOME:-$HOME/.config}/bootstrap/roles/verifier` 파일이 있으면 compat·round-robin 모두 `acquire`·`run`의 supervisor가 정확히 `verifier-loop`일 때만 허용한다. 기존 verifier 호출은 `acquire VERIFIER-01-software nightly-local verifier-loop --holder <루프 PID>`이며, 호출을 바꿀 필요가 없다. 역할이 꺼져 있으면 기존 동작 그대로다. 조회·해제·제어 명령에는 이 제한을 적용하지 않는다.

다른 요청은 대기열에 넣기 전에 코드 **4**로 거절한다. 예외 실행은 `YW_HEAVY_VERIFIER_OVERRIDE_REASON='<사유>' yw-heavy run ...`처럼 명시한다. 제어 문자를 제거한 뒤 비어 있거나 공백뿐인 사유는 거절한다. 사유는 실행 lock의 `owner.txt`에 `verifierOverrideReason`으로, 제출 시 진단 로그(`$YW_HEAVY_LOG`)에도 남긴다. 비밀값을 쓰지 않는다.

supervisor는 호출자가 주는 운영 식별자다. 이 제한은 같은 OS 사용자의 식별자 사칭이나 구버전 도구의 직접 lock 사용을 막는 보안 경계가 아니다.

## 모드와 전환 원칙

설치·자동 갱신의 기본은 **compat**다. 기존 FIFO, 감독자당 2줄, v2 출력·파일 형식을 유지한다. 재진입·라운드로빈·작업 이벤트는 감독자가 기기에서 **round-robin**을 명시적으로 켠 뒤에만 동작한다. `capabilities`의 기능 목록은 설치된 구현의 지원 목록이고, 소비자는 `mode`도 반드시 확인한다.

새 모드는 실행 슬롯 **1개**를 유지하면서 감독자별 FIFO를 순환한다. 새 감독자는 순환 끝에 들어간다. 실행 중 감독자는 차례를 끝낼 때 남은 작업이 있으면 끝으로 간다. 같은 ID·감독자의 재시도는 줄 위치·세대·등록 시각을 보존하고 이전 대기자는 코드 3으로 끝난다. 대기자 없는 감독자는 목록에서 빠지고, 다시 제출하면 끝에 붙는다.

큐와 실행 owner를 기준으로 감독자 순환 목록을 편집 잠금 아래에서 복구한다. 큐·순환 파일 갱신 사이에 프로세스가 종료돼도 기존 감독자 순서를 보존하고, 누락된 감독자는 큐 등록 순서대로 끝에 추가하며, 더 이상 실행·대기하지 않는 감독자는 제거한다. 이 동기화는 신규 등록 전에도 수행하며, no-reclaim은 실행 lock·대기 줄 회수만 막고 순환 목록 복구는 막지 않는다.

## v3 기계 프로토콜 (round-robin)

```sh
yw-heavy capabilities          # version도 같은 JSON. 읽기 전용
yw-heavy acquire REQUEST worker supervisor --json --holder PID
yw-heavy release --generation GENERATION --token TOKEN --lease LEASE
```

`capabilities` stdout은 JSON 한 줄이다:

```json
{"protocol":3,"mode":"compat","paused":false,"capabilities":["lease-json","generation-release","token-reentry","ancestor-reentry","supervisor-round-robin","events-jsonl"]}
```

소비자는 `protocol >= 3`, 필요한 capability, `mode == "round-robin"`을 확인한다. compat의 `acquire --json`은 코드 4로 거절한다. 아직 활성화되지 않았을 때 소비자의 기존 경로·fallback 정책은 소비자가 정한다. 이 저장소는 01-software의 helper를 바꾸지 않는다.

활성 모드의 `acquire`는 `--json` 유무에 관계없이 아래 JSON **한 줄만** stdout에 쓴다. 진단은 stderr다. 필드 `requestId`는 사람이 준 ID, `generation`은 등록 때 만든 192비트 무작위 세대, `token`은 획득 때 만든 별도의 192비트 무작위 값이다. `lease`는 획득 응답마다 다르다.

```json
{"protocol":3,"requestId":"REQUEST","generation":"<hex>","token":"<hex>","lease":"r-<hex>","borrowed":false}
```

- `--holder`는 호출자의 살아 있는 조상 프로세스여야 한다(자기 자신 포함). PID와 시작 시각을 검증하지 못하면 코드 6이다. 생략하면 직접 부모를 holder로 쓴다. 여러 도구 호출 사이에 차례를 유지하려면 `run` 안에 명령들을 묶는다. compat의 holder 없는 수동 차례는 v3에서 제공하지 않는다.
- 현재 세대의 `YW_HEAVY_GENERATION`·`YW_HEAVY_TOKEN`을 함께 상속했거나, 검증된 조상 프로세스가 현재 holder면 새 줄 없이 빌린다. 응답은 같은 세대·token, 새로운 `b-…` lease, `borrowed:true`다. `run`은 자식에게 두 환경 변수를 전달한다. 소비자가 `acquire`를 직접 쓰면 반환받은 두 값을 자식 환경에 전달한다. 상속한 값이 만료·불일치하거나 holder의 시작 시각을 검증하지 못하면 코드 6으로 거절한다.
- 재진입은 **직렬 중첩 작업**용이다. 같은 token으로 병렬 heavy 작업을 시작하지 않는다. 같은 OS 사용자 안의 악의적 우회를 막는 보안 경계는 아니다.
- 해제는 응답의 `generation`, `token`, `lease` 세 값을 그대로 보낸다. stdout은 비어 있고 성공 코드는 0이다. 빌린 lease·중복 해제·오래된 세대 해제는 no-op이다. 현재 세대의 잘못된 token·root lease는 코드 6이다. `release REQUEST`는 v3 실행·대기 항목을 해제하지 않는다. 활성 모드에서 ID 기반 해제 코드를 계속 쓰면 안 된다.
- `run`은 호출자의 umask를 그대로 명령에 전달한다. 내부 상태 파일의 600·실행 lock 디렉터리의 700 권한은 생성 구간에만 적용한다. 빌린 차례를 해제해도 바깥 차례를 유지한다. TERM·INT·HUP는 자식이 끝날 때까지 차례를 유지하고 신호 코드를 돌려준다. SIGKILL 후 고아 자식 감지는 기존과 같이 제공하지 않는다.
- pending 한도는 실행 중 항목을 제외해 감독자별 128개(`YW_HEAVY_MAX_PENDING_SUPERVISOR`), 전체 1024개(`YW_HEAVY_MAX_PENDING`)다. 초과하면 등록하지 않고 사유와 현재 수를 stderr에 쓰며 즉시 코드 5로 끝난다. 소비자는 무한 즉시 재시도를 하지 말고 backoff·제출 제한을 적용한다. 운영 한도를 바꿀 때 같은 기기의 호출자 환경을 일치시킨다.
- 인계는 `YW_HEAVY_FAST_POLL`(기본 0.2초) 내부 재확인으로 진행하며 기존 `YW_HEAVY_POLL`(30초)을 기다리지 않는다. 선점·가중치·동시 슬롯 확대는 제공하지 않는다.

추가 종료 코드: **4** 제출 중지·비활성 프로토콜·전환 거절·잘못 들어온 구버전 줄, **5** pending 한도 초과, **6** lease·재진입·조상 검증 실패. 0~3과 `run`의 명령 종료 코드 전달은 아래 호환 규칙과 같다.

### 작업 이벤트

활성 모드는 `$YW_HEAVY_QUEUE.events`(기본 `/tmp/yw-heavy-queue.events`, `YW_HEAVY_EVENTS`로 변경)에 JSONL을 추가한다. 새 파일과 owner는 권한 600, 실행 lock 디렉터리는 700이다. 기존 `.log`는 편집 잠금 등 진단 기록으로 유지한다.

```json
{"event":"end","at":1790000000,"requestId":"REQUEST","generation":"<hex>","supervisor":"S","waitSeconds":2,"heldSeconds":8,"exitCode":"0","signal":"unknown"}
```

이벤트는 `enqueue`, `start`, `end`, `cancel`, `reclaim`이다. 초 단위 대기·보유 시간은 음수가 되지 않으며, 아직 시작하지 않은 항목의 보유 시간은 0이다. 종료 코드는 문자열이며 `run`의 명령 종료 코드, 신호는 `TERM`·`INT`·`HUP`를 기록한다. 수동 해제·죽은 프로세스처럼 알 수 없으면 `unknown`이다. 대기 중 신호 취소는 `cancel`, 확정 사망·PID 재사용 회수는 `reclaim`이다. 중첩 차례는 별도 작업이 아니므로 추가 이벤트를 남기지 않는다. token·lease·환경·명령 인자는 기록하지 않는다. 기록 실패는 진단하고 실행을 계속한다. 파일 순환·집계는 이번 범위가 아니다.

### 활성화와 롤백

순서는 **호환 설치 → 호출자 갱신 → 기기별 활성화**다. 자동 갱신은 설치까지만 한다. 아래 명령은 운영 감독자가 전환할 때만 실행한다.

1. 모든 감독 세션·소비자와 신규 제출 중지를 조율한다. `yw-heavy pause`로 새 구현의 신규 등록을 막는다. 이미 등록된 대기자는 계속 진행하고 기존 차례의 중첩 획득은 허용한다. 구버전 프로세스는 pause를 모르므로 제출 자체를 별도로 멈춰야 한다.
2. `status`와 소유 세션을 대조해 실행·대기자를 drain한다. 끝난 v3 holder·대기자만 남아 있으면 `yw-heavy reclaim`으로 확정 사망 항목만 회수한다(pause 중에도 가능). 생성 중 종료돼 owner가 없거나 0바이트인 lock은 구형식 줄이 없고 기본 60초 유예가 지난 뒤 회수한다. 실제 삭제 시도가 실패하면 코드 1을 반환한다. 조회 실패 등으로 생존을 판단할 수 없거나 no-reclaim 표지가 있으면 보존한다. 이전 2줄 상한 밖에서 polling하던 v2 프로세스, 구형식 shell·Python 구현도 끝났는지 확인한다. 아직 줄을 쓰지 않은 구버전 프로세스는 상태 파일만으로 검출할 수 없다. `pgrep -fl 'yw-heavy|cc-yw-heavy|heavy.sh|R1-heavy'`는 후보 조사용이며 소유자와 확인한다. 살아 있거나 판단 불가한 항목을 지우지 않는다.
3. 모든 호출자가 새 구현을 쓰는지 확인한다. `yw-heavy mode round-robin`은 편집 잠금 아래에서 제출 중지·빈 대기열·실행 lock 부재를 확인한다. v2 실행·대기 줄, 구형식 줄, owner 없는 lock이 하나라도 남으면 코드 4로 거절한다. 제출 중지 상태는 유지한다.
4. `capabilities`·`status`에서 모드를 확인하고 `yw-heavy resume`으로 새 제출을 연다. 두 번의 인계와 이벤트 기록을 확인한다.

모드·pause·순환 상태는 각각 `$YW_HEAVY_QUEUE.mode`, `.paused`, `.rotation`에 둔다. 큐 경로가 기기별 상태를 구분하고, 기본 `/tmp` 경로는 재시동 후 사라지므로 compat로 돌아간다. 재활성화도 같은 drain 절차를 따른다. 테스트는 큐·실행 lock·편집 lock·기록을 모두 임시 경로로 격리한다.

롤백은 먼저 새 구현의 compat로 한다. 신규 제출 조율 → `pause` → v3 세대·대기자 drain → `mode compat` → `capabilities` 확인 → `resume`. 바이너리까지 구버전으로 내릴 때는 compat 전환 후 다시 제출을 중지하고, 실행 lock·대기열이 비어 있고 v3 실행 프로세스가 남지 않았으며 구버전이 읽을 상태 형식인지 확인한 뒤 원자적으로 교체한다. 활성 상태에서 파일만 되돌리거나 실행 lock을 지우지 않는다.

## 호환 모드 사용법

```sh
yw-heavy run <ID> <worker> <supervisor> -- <명령…>          # 권장
yw-heavy acquire <ID> <worker> <supervisor> --holder <PID>   # 여러 명령을 묶을 때. 끝나면 release
yw-heavy release <ID>
yw-heavy status                                              # 읽기 전용
```

- `<supervisor>`(v3 `acquire`의 `supervisor`)는 감독 세션의 **전체 Paseo agent ID**다. 같은 세션의 모든 작업자 제출과 같은 ID 재시도에서 그대로 유지한다.
- 전체 ID는 **새 작업부터** 쓴다. 이미 실행·대기 중인 작업과 그 재시도는 등록할 때의 값을 유지한 채 자연히 끝내고, 큐 파일에서 값을 직접 고치지 않는다. v3는 같은 요청의 supervisor 변경을 거절한다(`scripts/yw-heavy.sh`의 재시도 검사). 이행 기간에는 같은 감독의 이전 값과 새 값을 합쳐 compat 2줄 한도를 지킨다.
- **`run`이 기본이다.** 명령이 실행되는 동안만 차례를 잡고, 명령이 끝나거나 실패하거나 신호를 받으면 푼다. 종료 코드는 명령의 것이다. 신호(TERM·INT·HUP)를 받아도 명령이 끝날 때까지 차례를 유지한 뒤 143·130·129로 끝난다.
- **셸 스크립트에서 여러 명령을 묶을 때**: `yw-heavy acquire ID w s --holder $$`와 `trap 'yw-heavy release ID' EXIT`. 서브셸 안에서도 `$$`는 스크립트의 PID다. Python은 `--holder str(os.getpid())`.
- holder는 "작업 전체 수명을 대표하는 프로세스"다. holder가 끝난 것이 확정되면 다른 대기자가 차례를 회수한다. 그래서 holder는 **acquire부터 release까지 같은 스크립트·같은 도구 호출 안에서 끝까지 살아 있는 프로세스**여야 한다. 에이전트의 Bash 호출 하나가 끝나면 그 셸(`$$`)도 끝나므로, 다음 호출까지 차례를 이어 가는 holder로 쓰면 그 사이에 회수된다.
- 도구 호출을 넘겨 차례를 잡아야 하면 명령 하나로 묶어 `run`을 쓰거나, holder 없이 `acquire` 하고 끝나면 반드시 `release`한다(holder가 없으면 자동 회수하지 않는다). nightly처럼 종료를 확인하지 못했을 때 차례를 일부러 남기는 작업도 holder 없이 쓴다.
- 도구 호출 사이에 걸치는 background `acquire`는 동작은 하지만 자동 회수가 없다. `run`으로 바꾼다.
- 차례를 잡은 명령은 할 일이 끝나면 프로세스도 끝나야 한다. DB·Redis 연결을 여는 일회성 node 스크립트(seed 등)는 성공·실패 모두 `finally`에서 연결을 닫거나 `process.exit`로 끝낸다. 그러지 않으면 출력은 끝났는데 프로세스가 남아 차례를 계속 쥔다(2026-11-01 두 번, 각 30~50분 정체).
- 차례는 무거운 명령 단위로 잡는다. 설치부터 push까지의 작업 흐름 전체를 한 차례로 잡지 않는다. 저장소가 자체 기기 잠금을 제공하면(예: pre-push 내부) 그 잠금이 감싸는 구간은 다시 감싸지 않고, 잠금 밖의 무거운 단계만 차례에 넣는다. 감독자가 작업자 지침에 대기열에 넣을 명령 목록을 줄 때는 이런 구간을 명시적으로 뺀다. 예를 들어 01-software의 pre-push가 도는 `git push`와 공식 real-DB wrapper는 `scripts/heavy-machine-lock.mjs`를 스스로 잡는다. compat 기기에서 이를 다시 감싸면 push 하나가 감독자의 대기 줄을 몇 분씩 차지한다(2026-11-09, 감독자 줄 2개가 push와 "설치→push" 묶음으로 막혔다). round-robin 기기에서는 01-software dev `0c00fd9` 이후의 helper가 이 차례를 yw-heavy에 위임하고 재진입하므로, 감싸든 감싸지 않든 같은 차례를 쓴다. 이때 helper가 위임할 때 쓰는 supervisor는 `YW_HEAVY_SUPERVISOR`(감독 세션 전체 Paseo agent ID, dev `aa73c82` 이후)로 넘긴다. 지정하지 않으면 `01-software`로 묶여 감독 세션 사이 순환을 받지 못한다. 그보다 오래된 base의 worktree는 별도 저장소 잠금을 잡으므로 round-robin 기기에서는 heavy 전에 rebase한다.
- launchd·Python 등 PATH가 다른 곳에서는 절대 경로 `~/.local/bin/yw-heavy`를 쓴다.
- ID·worker·supervisor는 공백·따옴표·역슬래시 없이 쓴다. 감독자마다 대기 줄은 2개까지다. 세 번째는 자리가 날 때까지 기다린다.

| 종료 코드 | 뜻 |
|---|---|
| 0 | 성공 (`run`은 명령의 종료 코드) |
| 1 | 내부 오류 (lockf 실패 등) |
| 2 | 사용법 오류, `--holder`가 처음부터 끝나 있음 |
| 3 | 대기 줄이 지워짐(`release`), 같은 ID 재시도에 자리를 넘김, holder 종료, 같은 ID가 이미 차례를 가짐, 같은 ID의 구버전 줄 |

## 같은 ID로 다시 시도할 때

- 끊긴 뒤 같은 ID로 다시 부르면 **자리를 이어받는다.** 줄 위치는 그대로고 대기자만 바뀐다. 이전 대기자가 살아 있으면 "superseded"로 종료 코드 3을 받고 끝난다.
- 그 ID가 이미 차례를 가졌으면 바로 종료 코드 3이다. 끝난 작업이면 `yw-heavy release <ID>` 뒤 다시 시도한다. holder가 끝난 것이 확정된 차례는 회수가 먼저 일어나므로 그대로 진행한다.
- 같은 ID의 구버전 줄은 이어받지 않는다(종료 코드 3). 구버전 대기자에게는 알릴 방법이 없다.

## 생존 판정과 회수

사망은 확정될 때만 인정한다. 대상은 PID와 시작 시각(`ps -o lstart`)의 쌍이다.

- `kill -0`이 `No such process`(ESRCH)이면 사망이다.
- 프로세스가 있는데 시작 시각이 기록과 다르면 PID가 재사용된 것이므로 사망이다.
- `Operation not permitted`(sandbox 등), `ps` 실패, 시작 시각 미기록은 "모름"이고 보존한다. `ps`에서 안 보인다는 것만으로는 사망으로 보지 않는다.

| 대상 | 회수하는 경우 | 회수하지 않는 경우 |
|---|---|---|
| 실행 lock (`/tmp/yw-heavy-check.lock`) | v2 owner의 holder가 사망하고, 대기열의 모든 줄이 v2일 때(관문) | 구형식·zsh 형식 owner, holder 없음, 모름, 구형식 줄이 남아 있음 |
| owner 없는 실행 lock (`owner.txt` 없음·빈 파일) | 관문이 열려 있고 60초(`YW_HEAVY_OWNERLESS_AGE`) 넘게 바뀌지 않음. 실행 lock을 만들거나(mkdir 뒤 owner 기록 전) 지우던(owner 삭제 뒤 rmdir 전) 프로세스가 그 사이에 끝난 것이다 | 관문이 닫혀 있음(구버전 acquire가 mkdir 직후일 수 있다), 최근에 바뀜 |
| 대기 줄 | v2 줄의 대기자가 사망. 실행 lock을 가진 ID의 줄은 실행 lock과 함께만 | 구형식 줄, `pid=-`(차례를 얻은 뒤 holder 없음) |
| 새 버전 편집 표지 | 언제나 (flock을 잡은 뒤에도 남아 있으면 만든 쪽이 끝난 것) | |
| 구형식 편집 lock 디렉터리 | owner pid가 ESRCH. owner는 구 bash의 `{"pid":N,"task":"T"}`와 `R1-heavy.py`의 `pid=N task=T`를 모두 읽는다 | owner 생존·모름, `owner.txt` 없음(2분 넘으면 경고) |

- 대기열 편집은 커널 flock(`/tmp/yw-heavy-queue.flock`, `/usr/bin/lockf`)으로 직렬화한다. 죽은 프로세스의 flock은 커널이 푼다. 그래서 편집 중에 끝난 프로세스 때문에 대기열 전체가 멈추지 않는다. flock 파일은 지우지 않는다(지우면 이중 보유가 생긴다).
- 구버전이 같은 경로에 편집 lock 디렉터리를 만들지 못하도록 `/tmp/yw-heavy-queue.edit.lock`에 표지 파일(`yw-heavy-v2:pid=…:task=…`)을 함께 만든다.
- 회수할 때마다 `/tmp/yw-heavy-queue.log`와 stderr에 한 줄 남긴다: `<UTC 시각> reclaim kind=exec|line|edit task=… pid=… start=… reason=esrch|start-mismatch|ownerless-stale|stale-edit-mark|legacy-edit-esrch by=<pid>:<ID>`. 같은 ID 재시도는 `takeover`로 남는다.
- `release`가 실행 lock을 지우지 못하면(그 ID의 lock인데 디렉터리에 다른 파일이 있음) 대기 줄만 지웠다고 stderr에 알리고 1로 끝난다. owner 없는 실행 lock은 누구 것인지 알 수 없어 지우지 않고, 줄만 지웠다고 알린다.
- 한계: `run` 프로세스만 SIGKILL로 죽으면 명령이 고아로 남은 채 차례가 회수될 수 있다. `run`을 끝낼 때는 TERM이나 프로세스 그룹 전체로 보낸다.

## status 읽는 법

```text
대기열: /tmp/yw-heavy-queue
  1. B12-1  v2  claude-6e9c  [pid 4242 alive]
  2. U20-7  구형식  bba9389a  [생존 판정 불가]
실행 lock: task=B12-1 holder=4242 alive
편집 lock: 없음
관문: 닫힘 (구형식 줄 1개). 실행 lock은 자동 회수하지 않음
```

- 줄 상태: `alive`, `unknown`(판단 불가, 보존), `dead:…`(다음 대기자가 회수), `holder 없음`(차례를 얻은 뒤 holder 없이 실행 중, 자동 회수 안 함).
- 관문이 닫혀 있으면 구버전 대기자가 남아 있다는 뜻이다. 그동안 v2 holder가 끝나면 `release <ID>`로 직접 푼다.
- `실행 lock: … (owner 없음, N초 전 변경)`: 관문이 열려 있으면 60초 뒤 다음 대기자가 회수한다. 관문이 닫혀 있어 계속 남으면, 구버전 대기자 중 차례를 막 얻은 것이 없는지(`pgrep -fl 'cc-yw-heavy.sh|heavy.sh'`, 그 대기자의 출력) 확인한 뒤 flock 아래에서 지운다:

  ```sh
  /usr/bin/lockf -k -t 30 /tmp/yw-heavy-queue.flock /bin/sh -c 'x=/tmp/yw-heavy-check.lock; [ -d "$x" ] && [ ! -s "$x/owner.txt" ] && rm -f "$x/owner.txt" && rmdir "$x"; true'
  ```

- 차례가 정체되면 보유자·대기자가 실제로 살아 있는지 확인한다. 끝난 것이 확인된 다른 세션의 항목은 `release`로 정리한 뒤 소유 감독 세션에 알린다(대기 줄·잠금은 잃을 작업이 없고, 기다리는 동안 대기열 전체가 막힌다). 살아 있거나 판단할 수 없으면 건드리지 않고 소유 감독 세션의 동의, 연락이 안 되면 사용자 승인을 받는다.

## 자동 회수 끄기

`touch /tmp/yw-heavy-queue.no-reclaim`이면 실행 lock과 대기 줄을 자동 회수하지 않는다(편집 표지 정리는 계속). 비상시와 롤백에 쓴다. 다시 켜려면 지운다.

## 호환 모드의 구버전과 전환

같은 대기열을 쓰는 구현이 셋 있다. 모두 첫 필드(ID)로 줄을 읽으므로 섞여 돌아도 대기열을 읽을 수 있다.

| 구현 | 줄 | 실행 lock owner | 편집 lock | 새 도구의 처리 |
|---|---|---|---|---|
| `/tmp/cc-yw-heavy.sh` (구 bash) | 구형식 | `{"pid":<$PPID>,…}` | 디렉터리 + `{"pid":N,"task":"T"}` | 줄·실행 lock 보존(관문 닫힘), 편집 lock은 pid ESRCH면 회수 |
| 감독 세션의 zsh `heavy.sh` | 구형식 | `"PID"` 키 | 없음(잠금 없이 다시 씀) | 보존. shim으로 바꾸거나 폐기 (소유 세션 동의) |
| `/tmp/R1-heavy.py` | 구형식 | `{"pid": N, …}` (콜론 뒤 공백, `v` 없음) | 디렉터리 + `pid=N task=T` | 줄·실행 lock 보존, task는 읽음(같은 ID·release), 편집 lock은 pid ESRCH면 회수 |

- 이전 도구 `/tmp/cc-yw-heavy.sh`(bash, git 밖)와 함께 돌아도 안전하다. 새 줄에는 `v=2`, 새 owner에는 `"v":2`가 붙고, 구버전은 첫 필드만 읽으므로 그대로 읽는다. 구버전 acquire가 다시 부르는 `enqueue`는 구형식 줄을 쓴다.
- `heavy` 단계는 `/tmp/cc-yw-heavy.sh`가 **없을 때만** `~/.local/bin/yw-heavy`로 가는 링크를 만든다. 일반 파일(구버전)이 있으면 그대로 둔다. 그래서 이 저장소의 병합과 자동 갱신은 실행 중인 구버전을 바꾸지 않는다. `/tmp`는 재시동 때 비워진다. 링크는 저절로 다시 생기지 않고, `heavy` 단계가 다시 돌 때(yw-heavy 변경, 전체 설치, `./bootstrap.sh --only heavy`)만 생긴다. `doctor`가 링크 없음을 알린다. 정식 경로는 `~/.local/bin/yw-heavy`다.
- 구버전이 일반 파일로 있는 기기의 전환은 감독자가 아래 절차로 따로 한다.

### 전환 (구버전이 있는 기기)

1. 조건: nightly가 실행 중이 아니고, 실행 lock이 nightly 것이 아니며, 편집 lock이 없다. 대기열이 비었으면 더 좋다.

   ```sh
   cat /tmp/yw-heavy-check.lock/owner.txt 2>/dev/null
   test ! -e /tmp/yw-heavy-queue.edit.lock
   cp /tmp/yw-heavy-queue /tmp/yw-heavy-queue.snapshot.$(date +%H%M%S)
   pgrep -fl 'cc-yw-heavy.sh|heavy.sh'     # 구버전 대기자 목록 기록
   ```

2. 설치 확인: `cmp <저장소>/scripts/yw-heavy.sh ~/.local/bin/yw-heavy`, `./bootstrap.sh doctor`의 heavy 항목.
3. 격리 시험: `d=$(mktemp -d); YW_HEAVY_QUEUE=$d/q YW_HEAVY_EXEC_LOCK=$d/x YW_HEAVY_EDIT_LOCK=$d/e ~/.local/bin/yw-heavy run SMOKE s s -- true; echo $?` → 0. `~/.local/bin/yw-heavy status`(실제 대기열, 읽기 전용) → 지금 줄이 구형식으로 나오고 관문이 닫혀 있다.
4. 조건 재확인: 1번 조건(nightly 미실행, 실행 lock이 nightly 것이 아님, 편집 lock 없음)을 전환 직전에 다시 확인한다. 하나라도 어긋나면 멈춘다.
5. 백업 후 원자적 전환:

   ```sh
   cp -p /tmp/cc-yw-heavy.sh /tmp/cc-yw-heavy.sh.pre-switch-$(date +%Y%m%d-%H%M%S)
   ln -s "$HOME/.local/bin/yw-heavy" /tmp/cc-yw-heavy.sh.switch.$$ && mv -f /tmp/cc-yw-heavy.sh.switch.$$ /tmp/cc-yw-heavy.sh
   ```

6. 확인: `readlink /tmp/cc-yw-heavy.sh`, `bash /tmp/cc-yw-heavy.sh status`, 대기열이 스냅샷과 같은지, 편집 lock이 없는지, 기록한 구버전 대기자가 살아 있는지(`ps -p`).
7. 구형식 줄마다 대기자가 살아 있는지 확인한다(`pgrep -fl` 결과의 ID와 대조). 대기자가 없는 고아 줄은 관문을 계속 닫아 두므로 `yw-heavy release <ID>`로 지운 뒤 소유 감독 세션에 알린다. 대기자가 살아 있거나 대조할 수 없으면 지우지 않는다.
8. 관찰: 다음 두 번의 인계에서 release마다 다음 맨 앞 대기자가 차례를 얻는지, 회수 기록에 살아 있는 pid가 없는지 본다.

즉시 롤백하는 경우: `status`·`acquire`·`release`가 종료 코드 1이나 bash 오류를 냄, 정상 release가 아닌데 줄이 사라지거나 순서가 바뀜, 편집 lock이 2분 넘게 남음, 살아 있는 pid(시작 시각 일치)를 회수한 기록, 실행 lock owner와 실제 실행 중인 작업이 다름.

### 구버전 바이너리로 롤백

위 "활성화와 롤백"의 drain 절차를 따른다. 호환 모드라도 신규 제출을 멈추고, 실행·대기자·구버전 프로세스가 모두 끝난 뒤 상태 형식을 확인하고 원자적으로 교체한다. no-reclaim 표지만 만들고 실행 중 바이너리나 편집 표지를 바꾸는 방식은 쓰지 않는다.
