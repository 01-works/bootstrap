# 컨테이너

Docker Desktop 대신 **colima**를 쓴다. colima가 Linux VM을 띄우고 그 안에서 Docker 엔진을 돌린다. 그 엔진을 다루는 `docker` 명령어는 Homebrew의 `docker`(Docker Desktop 없이 명령어만)로 설치한다. 모두 `Brewfile`.

```sh
colima start                      # 기본 VM 시작
colima start --cpu 4 --memory 8   # 자원 지정
colima list                       # VM 목록
colima stop                       # 다 쓰면 끄기
docker ps
```

- `docker compose`, `docker buildx`는 쓰는 프로젝트가 없어서 설치하지 않는다. 필요해지면 `brew install docker-compose`(또는 `docker-buildx`) 후 `~/.docker/cli-plugins`에 연결한다 (Homebrew 설치 안내 참고).
- 로그인할 때 자동으로 켜지 않는다. VM은 켜져 있는 동안 메모리를 차지하므로 필요할 때 켜고 다 쓰면 끈다. 재부팅 후에도 늘 떠 있어야 하는 컨테이너가 생기면 그때 `brew services start colima`로 자동 시작을 켠다.
- 프로필(`colima start -p <이름>`)로 VM을 여러 개 둘 수 있다. 다 쓴 VM은 `colima delete -p <이름>`으로 지워야 디스크가 돌아온다.

## 메모리 주의

VM에 준 메모리는 macOS에서 그만큼 빠진다. 16GB 기기에서 8GB VM을 돌리면 스왑을 많이 쓴다.
