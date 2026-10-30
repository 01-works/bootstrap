# 공용 heavy 대기열 (yw-heavy)

전체 타입 검사·테스트·빌드, dev 서버처럼 메모리를 많이 쓰는 명령은 같은 기기에서 하나씩 실행한다. 감독 세션과 worktree가 달라도 같은 대기열을 쓴다. 원본은 `scripts/yw-heavy.sh`이고, 모든 기기에서 `heavy` 단계가 `~/.local/bin/yw-heavy`로 설치한다. 자동 갱신이 원본 변경을 전파한다.

## 사용법

```sh
yw-heavy run <ID> <worker> <supervisor> -- <명령…>          # 권장
yw-heavy acquire <ID> <worker> <supervisor> --holder <PID>   # 여러 명령을 묶을 때. 끝나면 release
yw-heavy release <ID>
yw-heavy status                                              # 읽기 전용
```

- **`run`이 기본이다.** 명령이 실행되는 동안만 차례를 잡고, 명령이 끝나거나 실패하거나 신호를 받으면 푼다. 종료 코드는 명령의 것이다. 신호(TERM·INT·HUP)를 받아도 명령이 끝날 때까지 차례를 유지한 뒤 143·130·129로 끝난다.
- **셸 스크립트에서 여러 명령을 묶을 때**: `yw-heavy acquire ID w s --holder $$`와 `trap 'yw-heavy release ID' EXIT`. 서브셸 안에서도 `$$`는 스크립트의 PID다. Python은 `--holder str(os.getpid())`.
- holder는 "작업 전체 수명을 대표하는 프로세스"다. holder가 끝난 것이 확정되면 다른 대기자가 차례를 회수한다. 그래서 holder는 **acquire부터 release까지 같은 스크립트·같은 도구 호출 안에서 끝까지 살아 있는 프로세스**여야 한다. 에이전트의 Bash 호출 하나가 끝나면 그 셸(`$$`)도 끝나므로, 다음 호출까지 차례를 이어 가는 holder로 쓰면 그 사이에 회수된다.
- 도구 호출을 넘겨 차례를 잡아야 하면 명령 하나로 묶어 `run`을 쓰거나, holder 없이 `acquire` 하고 끝나면 반드시 `release`한다(holder가 없으면 자동 회수하지 않는다). nightly처럼 종료를 확인하지 못했을 때 차례를 일부러 남기는 작업도 holder 없이 쓴다.
- 도구 호출 사이에 걸치는 background `acquire`는 동작은 하지만 자동 회수가 없다. `run`으로 바꾼다.
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

- 차례가 정체되면 보유자·대기자가 실제로 살아 있는지 확인한다. 끝난 것이 확인된 다른 세션의 항목은 소유 감독 세션에 알린 뒤 `release`한다.

## 자동 회수 끄기

`touch /tmp/yw-heavy-queue.no-reclaim`이면 실행 lock과 대기 줄을 자동 회수하지 않는다(편집 표지 정리는 계속). 비상시와 롤백에 쓴다. 다시 켜려면 지운다.

## 구버전과 전환

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
7. 구형식 줄마다 대기자가 살아 있는지 확인한다(`pgrep -fl` 결과의 ID와 대조). 대기자가 없는 고아 줄은 관문을 계속 닫아 두므로, 소유 감독 세션의 동의를 받은 뒤 `yw-heavy release <ID>`로 지운다.
8. 관찰: 다음 두 번의 인계에서 release마다 다음 맨 앞 대기자가 차례를 얻는지, 회수 기록에 살아 있는 pid가 없는지 본다.

즉시 롤백하는 경우: `status`·`acquire`·`release`가 종료 코드 1이나 bash 오류를 냄, 정상 release가 아닌데 줄이 사라지거나 순서가 바뀜, 편집 lock이 2분 넘게 남음, 살아 있는 pid(시작 시각 일치)를 회수한 기록, 실행 lock owner와 실제 실행 중인 작업이 다름.

### 롤백

1. `touch /tmp/yw-heavy-queue.no-reclaim` — 이미 떠 있는 새 버전 대기자의 회수를 멈춘다.
2. `cp -p /tmp/cc-yw-heavy.sh.pre-switch-<시각> /tmp/cc-yw-heavy.sh.rb.$$ && mv -f /tmp/cc-yw-heavy.sh.rb.$$ /tmp/cc-yw-heavy.sh`
3. 구버전이 지나갈 수 없는 새 버전 편집 표지를 flock 아래에서만 지운다. `-k`가 없으면 lockf가 flock 파일을 지우므로 반드시 붙인다.

   ```sh
   /usr/bin/lockf -k -t 30 /tmp/yw-heavy-queue.flock /bin/sh -c 'e=/tmp/yw-heavy-queue.edit.lock; { [ -L "$e" ] || { [ -f "$e" ] && [ ! -d "$e" ]; }; } && rm -f "$e"; true'
   ```

4. 확인: `head -3 /tmp/cc-yw-heavy.sh`(구버전 원문), 대기열이 그대로인지(v2 줄도 구버전이 첫 필드로 읽는다), 편집 lock 상태.
5. `yw-supervisor` 스킬이 `yw-heavy`를 쓰라고 바뀌어 있으면(전환 뒤 후속 PR) 그 변경도 되돌린다. 스킬은 저장소 링크라 병합 즉시 모든 감독 세션에 적용된다.
6. no-reclaim 파일은 새 버전 프로세스가 모두 끝날 때까지(`pgrep -fl yw-heavy`가 빌 때까지) 두었다가 지운다. 그 전에 지우면 남아 있는 새 버전 대기자가 다시 회수를 시작한다. 이슈에 기록한다.
