# Homebrew

설치 목록은 Brewfile이 기준이다.

- [`Brewfile`](../Brewfile) 하나에 모든 기기가 설치할 것을 적는다. 항목별 이유는 [TOOLS.md](../TOOLS.md).

## Intel Mac

Homebrew는 2026-09부터 Intel Mac을 Tier 3으로 분류한다. 기존 바이너리는 쓸 수 있지만 새 버전은 소스 빌드가 필요할 수 있다. 최신 설치기는 Intel을 받지 않으므로, `homebrew` 단계는 Intel을 지원하는 공식 설치기 버전을 고정해서 쓴다. 설치 경로는 `/usr/local`이다. Apple Silicon은 최신 설치기와 `/opt/homebrew`를 쓴다.

저장소를 받기 전 Intel Mac에 Homebrew를 설치하려면:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/f4aa1b1ca5b256954dbde0315455fb259cdfc45a/install.sh)"
eval "$(/usr/local/bin/brew shellenv)"
```

근거: [Homebrew 7.0.0](https://brew.sh/2026/09/13/homebrew-7.0.0/), [Intel을 지원하는 공식 설치기 고정 버전](https://github.com/Homebrew/install/blob/f4aa1b1ca5b256954dbde0315455fb259cdfc45a/install.sh).

### Intel의 uv

Intel에서는 Homebrew의 uv 바이너리가 없어 빌드용 Rust·LLVM까지 소스에서 컴파일하게 된다. `Brewfile`은 Intel에서 uv를 제외하고, `homebrew` 단계가 [uv 공식 설치기](https://docs.astral.sh/uv/getting-started/installation/)로 `~/.local/bin`에 바이너리를 설치한다. `UV_NO_MODIFY_PATH=1`로 셸 설정을 유지한다. 기존 uv가 있으면 갱신하지 않으며 실행 실패·uv/uvx 경로 충돌은 덮어쓰지 않고 알린다. doctor는 Homebrew 등록과 별개로 uv 실행을 확인한다.

## 추가·삭제

```sh
brew install <이름>              # 설치하고
# Brewfile에 한 줄 추가
./bootstrap.sh snapshot         # 빠진 게 없는지 확인
```

지울 때는 `brew uninstall` 후 Brewfile에서도 지운다.

## 동작 방식

- `homebrew` 단계는 `brew bundle --no-upgrade`로 설치한다. 이미 깔린 건 업그레이드하지 않으므로 다시 실행해도 아무것도 바뀌지 않는다. 업그레이드는 따로 `brew upgrade`.
- 한 항목이 실패해도 다음 단계로 넘어간다. 빠진 항목은 `doctor`가 보여준다.

## 기존 앱 옮기기

Brewfile에 있는 앱을 이미 직접 설치해 둔 기기에서는 `brew bundle`이 "이미 앱이 있다"며 실패한다. Homebrew 관리로 옮기려면:

```sh
brew install --cask --adopt <이름>
```

설치된 앱과 버전이 달라서 adopt가 안 되면, 앱을 종료한 뒤 `--force`로 덮어쓴다. 앱 데이터(`~/Library`)는 그대로 남는다.
