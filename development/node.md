# Node

| 도구 | 설치 | 비고 |
|---|---|---|
| Node | fnm (`brew "fnm"`) | 기본 버전 24 (`scripts/lib.sh`의 `NODE_VERSION`) |
| pnpm | 공식 설치 스크립트 (`runtimes` 단계) | `~/Library/pnpm` (`PNPM_HOME`). Node와 따로 설치된다 |

## fnm

`.zshrc`에서 `fnm env --use-on-cd --version-file-strategy recursive`로 켠다.

- 프로젝트 폴더에 들어가면 `.node-version`/`.nvmrc`를 찾아 자동으로 버전을 바꾼다. 상위 폴더까지 찾는다.
- 로그인 셸(`.zprofile`)에는 기본 버전 경로(`~/.local/share/fnm/aliases/default/bin`)를 넣는다. 그래서 `.zshrc`를 읽지 않는 비대화형 셸에서도 `node`가 잡힌다.

## pnpm

- 공식 설치 스크립트로 Node와 따로 설치한다. 그래서 Node 버전을 바꿔도 pnpm은 그대로다.
- 프로젝트의 `package.json`에 `packageManager`로 고정한 버전이 있으면 pnpm이 그 버전을 받아서 실행한다. 프로젝트 밖에서는 설치된 최신 버전을 쓴다.
- 고정한 버전이 깨진 릴리스(예: 11.12.0)이면 pnpm이 경고를 내고 최신 버전으로 실행한다. 이 경고가 보이면 프로젝트의 `packageManager`를 정상 버전으로 올린다.
- 업데이트: `pnpm self-update`
- 설치 스크립트는 셸 설정의 pnpm 줄을 기기의 절대 경로로 다시 쓴다. `.zshrc`는 저장소 파일에 링크되어 있어서, `runtimes` 단계가 그 수정을 버리게 해 둔다. 저장소의 `.zshrc`에 같은 줄이 이미 있다.

## 기존 기기에서 corepack pnpm 바꾸기

예전에 corepack으로 pnpm을 켠 기기에서는 `runtimes` 단계가 이미 pnpm이 있다고 보고 건너뛰며 경고만 한다. 돌고 있는 작업이 없을 때 이렇게 바꾼다.

```sh
curl -fsSL https://get.pnpm.io/install.sh | ZDOTDIR="$(mktemp -d)" SHELL=/bin/zsh sh -   # .zshrc는 건드리지 않게
for v in $(fnm list | grep -oE 'v[0-9.]+' | sort -u); do fnm exec --using="$v" corepack disable pnpm; done
pnpm --version   # ~/Library/pnpm/bin/pnpm 이 잡히는지: which pnpm
```

고정 버전이 깨진 릴리스인 프로젝트가 있으면 바꾼 뒤 그 프로젝트에서 경고가 나온다. 그 프로젝트의 `packageManager`를 올린다.

## 전역 npm 패키지

npm 전역 패키지는 Node 버전별로 따로 깔린다. 기본 버전을 바꾸면 사라진 것처럼 보인다. 그래서 CLI 도구는 npm 전역으로 설치하지 않는다.

- 공식 설치 스크립트가 있으면 그것을 쓴다 (Claude Code, Codex).
- 패키지 관리자로만 설치하는 CLI는 pnpm 전역으로 설치한다 (Vercel CLI). Node 버전과 상관없는 `~/Library/pnpm`에 깔린다.
- 기본 브라우저 도구 Browser Use는 uv 도구 환경을 사용하므로 Node 버전과 독립적이다. 이전 agent-browser의 npm 설치가 남아 경로 충돌이 발생하면 [기존 설치 정리](../agents/browser.md#기존-설치-정리)를 참고한다.
