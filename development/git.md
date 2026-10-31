# git · GitHub

## 계정과 인증

- GitHub 계정: `01-office` (조직 `01-works` 멤버)
- 커밋 작성자: [`home/git/.gitconfig`](../home/git/.gitconfig). 이메일은 GitHub noreply 주소를 쓴다.
- git은 **https + gh 자격 증명**으로 GitHub에 접속한다. `gh auth login` 한 번이면 push/pull이 된다. 토큰은 gh가 관리하고 저장소에는 들어가지 않는다.
- 에이전트 세션의 gh·push는 App 설정이 있는 기기에서 에이전트 전용 GitHub App 신원을 쓴다 → [agents/github-app.md](../agents/github-app.md). 그래서 credential helper가 원격 경로를 받도록 `useHttpPath`를 켠다.

## SSH 키

bootstrap은 SSH 키를 만들지 않는다. git은 https로 쓰고, 이 기기에서 다른 기기·서버로 SSH 접속할 때만 필요하기 때문이다. 이 기기로 *들어오는* 접속(원격 로그인)에는 접속하는 쪽의 키가 쓰인다.

- 필요해지면 기기마다 새로 만든다. 다른 기기의 개인키를 복사해 오지 않는다: `ssh-keygen -t ed25519 -C "$(scutil --get ComputerName)"`
- 접속할 기기의 `~/.ssh/authorized_keys`에 공개키(`~/.ssh/id_ed25519.pub`)를 추가한다.
- GitHub에 SSH로 붙거나 SSH 커밋 서명이 필요해지면 `gh auth refresh -s admin:public_key` 후 `gh ssh-key add`.
- `~/.ssh/config`는 저장소에 넣지 않는다. 기기마다 접속할 곳이 다르고, colima 같은 도구가 스스로 고쳐 쓴다.

## 기기별 설정

이 기기에서만 필요한 git 설정은 `~/.gitconfig.local`에 둔다. `.gitconfig`가 마지막에 include한다.

## 이 저장소의 커밋 전 검사

`.githooks/pre-commit`이 gitleaks로 staged 변경에서 비밀값을 찾는다. gitleaks가 없으면 커밋을 막는다. `xcode` 단계가 git 설치 뒤에 `core.hooksPath`를 설정하고, `doctor`가 켜져 있는지 확인한다.

훅은 `git commit --no-verify`로 건너뛸 수 있다. 그래서 GitHub에 처음 올리기 전에는 전체 기록을 한 번 검사한다: `gitleaks git --redact`
