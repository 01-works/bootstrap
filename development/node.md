# Node

| 도구 | 설치 | 비고 |
|---|---|---|
| Node (개발용) | fnm (`brew "fnm"`) | 기본 버전 24 (`runtimes` 단계의 `NODE_VERSION`) |
| pnpm | corepack | 전역 패키지 위치 `~/Library/pnpm` (`PNPM_HOME`) |
| Node (Hermes용) | `brew "node"` | Hermes 대시보드가 `/opt/homebrew/bin/node`로 실행된다 |

## fnm

`.zshrc`에서 `fnm env --use-on-cd --version-file-strategy recursive`로 켠다.

- 프로젝트 폴더에 들어가면 `.node-version`/`.nvmrc`를 찾아 자동으로 버전을 바꾼다. 상위 폴더까지 찾는다.
- 로그인 셸(`.zprofile`)에는 기본 버전 경로(`~/.local/share/fnm/aliases/default/bin`)를 넣는다. 그래서 `.zshrc`를 읽지 않는 비대화형 셸에서도 `node`가 잡힌다.
- PATH에서 fnm이 Homebrew보다 앞에 있으므로 터미널에서 `node`를 치면 fnm 버전이 실행된다. brew `node`는 Hermes처럼 `/opt/homebrew/bin`을 직접 쓰는 것만 쓴다.

## 전역 npm 패키지

전역 패키지는 Node 버전별로 따로 깔린다. 기본 버전을 바꾸면 사라진 것처럼 보인다. 그래서 CLI 도구는 가능하면 brew나 cask로 설치한다 (예: Codex → `cask "codex"`).
