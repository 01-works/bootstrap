import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const HOUR = 3600 * 1000;
const infoPlist = version => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>
`;

// 실제 bootstrap.sh·lib.sh·paseo-upgrade.sh에 대역 명령(brew, 앱 안의 paseo, launchctl 등)을 붙인다.
// 대역은 $MOCK의 파일로 상태를 흉내 내고 호출을 $MOCK/calls에 남긴다.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-paseo-upgrade-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const mock = join(root, 'mock'), bin = join(root, 'bin'), brewBin = join(root, 'brew/bin');
  const app = join(root, 'Paseo.app'), state = join(root, 'state/bootstrap/paseo-upgrade');
  for (const dir of [mock, bin, brewBin, join(app, 'Contents/Resources/bin')]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'), XDG_CONFIG_HOME: join(root, 'config'),
    PATH: `${bin}:${brewBin}:${process.env.PATH}`, MOCK: mock, APP: app, BOOTSTRAP_PASEO_APP: app, BOOTSTRAP_BREW_PREFIX: join(root, 'brew'),
    BOOTSTRAP_PASEO_DAEMON_WAIT: '2', DRY_RUN: '0' };
  for (const key of ['BOOTSTRAP_ROOT', 'BOOTSTRAP_LOCKED', 'BOOTSTRAP_UNATTENDED', 'BOOTSTRAP_RESULTS', 'PASEO_AGENT_ID']) delete env[key];
  const script = (path, body) => writeFileSync(path, `#!/bin/bash\n${body}`, { mode: 0o755 });
  const log = 'printf "%s\\n" "$*" >> "$MOCK/calls"';
  // 데몬 대역: $MOCK/daemon에 실행 중인 버전. 시작하면 앱의 버전으로 뜬다.
  const startDaemon = 'plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" > "$MOCK/daemon"';
  script(join(app, 'Contents/Resources/bin/paseo'), `printf 'paseo %s\\n' "$*" >> "$MOCK/calls"
case "$1 $2" in
  'daemon status')
    if [[ -f "$MOCK/daemon" ]]; then
      printf '{\\n  "localDaemon": "running",\\n  "desktopManaged": %s,\\n  "daemonVersion": "%s"\\n}\\n' \\
        "$(cat "$MOCK/desktop-managed" 2>/dev/null || echo false)" "$(cat "$MOCK/daemon")"
    else
      printf '{\\n  "localDaemon": "stopped"\\n}\\n'
    fi ;;
  'daemon stop') rm -f "$MOCK/daemon" ;;
  'daemon start') ${startDaemon} ;;
  'ls -g') [[ -f "$MOCK/ls-fail" ]] && exit 1; cat "$MOCK/agents" 2>/dev/null || echo '[]' ;;
esac
`);
  // brew 대역: upgrade는 cask 제거 단계처럼 데몬을 멈추고 앱을 cask 버전으로 바꾼다.
  script(join(brewBin, 'brew'), `[[ "$1" == shellenv ]] && { printf 'export PATH="%s:$PATH"\\n' "${brewBin}"; exit 0; }
printf 'brew %s\\n' "$*" >> "$MOCK/calls"
case "$1" in
  list) [[ ! -f "$MOCK/outside" ]] ;;
  info) printf '{"casks":[{"version":"%s"}]}\\n' "$(cat "$MOCK/cask-version")" ;;
  upgrade)
    "$APP/Contents/Resources/bin/paseo" daemon stop --force
    code="$(cat "$MOCK/exit-upgrade" 2>/dev/null || echo 0)"
    [[ "$code" == 0 ]] && sed "s/<string>[^<]*<\\/string><\\/dict>/<string>$(cat "$MOCK/cask-version")<\\/string><\\/dict>/" "$APP/Contents/Info.plist" > "$MOCK/plist" && cat "$MOCK/plist" > "$APP/Contents/Info.plist"
    exit "$code" ;;
esac
`);
  // 릴리스 공개 시각: gh 로그인 토큰을 표준 입력 헤더로 넘긴 curl이 먼저, 실패하면 로그인 없는 curl.
  // gh-fail(로그인 없음)·curl-auth-fail(토큰 거절)·curl-fail(로그인 없는 한도 소진) 플래그로 실패를 흉내 낸다.
  script(join(bin, 'gh'), `printf 'gh %s\\n' "$*" >> "$MOCK/calls"
[[ -f "$MOCK/gh-fail" ]] && exit 1
[[ "$1 $2" == 'auth token' ]] && echo gho_test
`);
  script(join(bin, 'curl'), `if [[ " $* " == *' -H @- '* ]]; then
  printf 'curl %s [%s]\\n' "$*" "$(cat)" >> "$MOCK/calls"
  [[ -f "$MOCK/curl-auth-fail" ]] && exit 22
else
  printf 'curl %s\\n' "$*" >> "$MOCK/calls"
  [[ -f "$MOCK/curl-fail" ]] && exit 22
fi
[[ "$*" == *api.github.com* ]] && printf '{"published_at":"%s"}\\n' "$(cat "$MOCK/published")"
`);
  script(join(bin, 'launchctl'), `${log}
case "$1" in
  print) [[ -f "$MOCK/registered" ]] ;;
  kickstart) ${startDaemon} ;;
esac
`);
  script(join(bin, 'pmset'), '[[ -f "$MOCK/laptop" ]] && echo "-InternalBattery-0 100%" || echo "Now drawing from \'AC Power\'"\n');
  script(join(bin, 'pgrep'), '[[ -f "$MOCK/app-open" ]]\n');
  script(join(bin, 'osascript'), 'shift 6; printf "%s | %s\\n" "$1" "$2" >> "$MOCK/notify"\n');

  const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = path => read(path).split('\n').filter(Boolean);
  const iso = ms => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  const f = {
    mock, state,
    // 설치된 앱, 실행 중인 데몬(null이면 멈춤), Homebrew 최신 버전과 공개 뒤 지난 시간.
    set({ app: appVersion, daemon, cask, publishedHoursAgo = 48, agents } = {}) {
      if (appVersion) writeFileSync(join(app, 'Contents/Info.plist'), infoPlist(appVersion));
      if (daemon) writeFileSync(join(mock, 'daemon'), daemon);
      if (daemon === null) rmSync(join(mock, 'daemon'), { force: true });
      if (cask) writeFileSync(join(mock, 'cask-version'), cask);
      writeFileSync(join(mock, 'published'), iso(Date.now() - publishedHoursAgo * HOUR));
      if (agents) writeFileSync(join(mock, 'agents'), JSON.stringify(agents.map(status => ({ id: status, status })), null, 2));
    },
    flag: (name, on = true) => on ? writeFileSync(join(mock, name), '1') : rmSync(join(mock, name), { force: true }),
    run: (args = [], extraEnv = {}) => spawnSync('/bin/bash', [join(repo, 'bootstrap.sh'), 'paseo-upgrade', ...args],
      { env: { ...env, ...extraEnv }, encoding: 'utf8' }),
    calls() { const result = lines(join(mock, 'calls')); rmSync(join(mock, 'calls'), { force: true }); return result; },
    appVersion: () => /<string>([^<]*)<\/string><\/dict>/.exec(read(join(app, 'Contents/Info.plist')))[1],
    daemon: () => read(join(mock, 'daemon')).trim(),
    notifications: () => lines(join(mock, 'notify')),
    status: () => Object.fromEntries(lines(join(state, 'status')).map(line => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])),
    // 상태 파일의 시각을 hours 시간 전으로 돌린다.
    age(name, hours) { const at = (Date.now() - hours * HOUR) / 1000; utimesSync(join(state, name), at, at); },
  };
  f.flag('registered');
  // 진짜 brew·paseo가 불리면 이 기기의 앱이 바뀐다. lib.sh를 거친 뒤에도 대역을 찾는지 먼저 확인한다.
  const found = spawnSync('/bin/bash', ['-c', `source "${join(repo, 'scripts/lib.sh')}"; command -v brew`], { env, encoding: 'utf8' });
  assert.equal(found.stdout.trim(), join(brewBin, 'brew'), `brew 대역을 찾지 못함: ${found.stdout}${found.stderr}`);
  return f;
}
const output = result => result.stdout + result.stderr;

test('공개 뒤 36시간이 지난 새 버전은 한가할 때 brew로 올리고 데몬을 다시 띄운다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2', publishedHoursAgo: 40, agents: ['idle', 'closed'] });
  const result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  const calls = f.calls();
  assert.ok(calls.includes('brew update --quiet'));
  const upgrade = calls.indexOf('brew upgrade --cask paseo');
  assert.ok(upgrade > 0, calls.join('\n'));
  assert.ok(calls.indexOf('kickstart gui/' + process.getuid() + '/local.bootstrap.paseo') > upgrade, '업그레이드 뒤 자동 시작 등록으로 데몬을 띄움');
  assert.equal(f.appVersion(), '0.13.2');
  assert.equal(f.daemon(), '0.13.2');
  assert.equal(f.status().result, 'ok');
  assert.deepEqual(f.notifications(), ['Paseo 업그레이드됨 | Paseo 0.12.0 → 0.13.2']);
  assert.match(result.stdout, /^\n\[\d{4}-\d\d-\d\d /, '--auto는 할 일이 있을 때 시각을 남김');

  // 최신이면 아무것도 하지 않고, 하루 안에는 다시 확인하지 않는다.
  const again = f.run(['--auto']);
  assert.equal(again.status, 0);
  assert.equal(again.stdout, '', '할 일이 없으면 기록하지 않음');
  assert.deepEqual(f.calls().filter(call => call.startsWith('brew')), []);
  f.age('checked', 25);
  f.run(['--auto']);
  assert.ok(f.calls().includes('brew info --cask --json=v2 paseo'), '하루가 지나면 다시 확인');
});

test('공개 뒤 36시간이 안 됐으면 기다리고, --force는 바로 올린다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2', publishedHoursAgo: 10 });
  let result = f.run();
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /0\.13\.2: 공개 뒤 36시간이 지나면 올립니다 \(약 26시간 남음\)/);
  assert.ok(!f.calls().includes('brew upgrade --cask paseo'));
  assert.equal(f.appVersion(), '0.12.0');

  result = f.run(['--force']);
  assert.equal(result.status, 0, output(result));
  assert.ok(f.calls().includes('brew upgrade --cask paseo'));
  assert.equal(f.daemon(), '0.13.2');
});

test('릴리스 공개 시각은 gh 로그인 토큰으로 받고, 안 되면 로그인 없이, 둘 다 안 되면 다음 주기에 다시 확인한다', t => {
  const f = fixture(t);
  const api = 'https://api.github.com/repos/getpaseo/paseo/releases/tags/v0.14.0';
  const latest = () => readFileSync(join(f.state, 'latest'), 'utf8');
  const recheck = () => { writeFileSync(join(f.state, 'latest'), '0.13.2 1\n'); f.age('checked', 25); };
  f.set({ app: '0.13.2', daemon: '0.13.2', cask: '0.14.0', publishedHoursAgo: 10 });
  let result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  let calls = f.calls().filter(call => call.startsWith('curl'));
  assert.deepEqual(calls, [`curl -fsS --max-time 20 -H @- ${api} [Authorization: Bearer gho_test]`], '토큰은 명령줄이 아닌 표준 입력으로');
  assert.match(latest(), /^0\.14\.0 \d+\n$/);

  // 토큰이 거절되거나(로그인 만료) gh에 로그인돼 있지 않으면 로그인 없이 받는다.
  for (const flag of ['curl-auth-fail', 'gh-fail']) {
    recheck();
    f.flag(flag);
    result = f.run(['--auto']);
    assert.equal(result.status, 0, output(result));
    assert.ok(f.calls().includes(`curl -fsS --max-time 20 ${api}`), flag);
    assert.match(latest(), /^0\.14\.0 /, flag);
    f.flag(flag, false);
  }

  // 둘 다 안 되면(로그인 없는 API의 시간당 한도 소진 등) 기록을 바꾸지 않고 한 시간 뒤 다시 확인한다.
  recheck();
  f.flag('gh-fail');
  f.flag('curl-fail');
  result = f.run(['--auto']);
  assert.match(output(result), /Paseo 0\.14\.0 릴리스 공개 시각을 받지 못했습니다 \(GitHub\)/);
  assert.equal(latest(), '0.13.2 1\n');
  f.flag('gh-fail', false);
  f.run(['--auto']);
  assert.match(latest(), /^0\.14\.0 /, '다음 주기에 다시 확인');
});

test('실행 중인 에이전트가 있으면 기다리고, 하루 넘게 이어지면 한 번 알린다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2', agents: ['running', 'idle'] });
  let result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /실행 중인 에이전트\(1개\)가 끝나면 올립니다/);
  assert.ok(!f.calls().includes('brew upgrade --cask paseo'));
  assert.equal(f.daemon(), '0.12.0', '데몬은 그대로');
  assert.ok(existsSync(join(f.state, 'blocked')));
  assert.notEqual(f.status().result, 'pending', '하루 안에는 대기로 알리지 않음');

  assert.equal(f.run(['--auto']).stdout, '', '같은 대기는 다시 기록하지 않음');
  assert.equal(f.run().status, 2, '터미널에서는 대기(2)');

  writeFileSync(join(f.state, 'blocked'), `${Math.floor((Date.now() - 25 * HOUR) / 1000)}\n`);
  f.run(['--auto']);
  f.run(['--auto']);
  assert.equal(f.status().result, 'pending');
  assert.match(f.status().banner, /--force/);
  assert.equal(f.notifications().length, 1, '한 번만 알림');
  assert.match(f.notifications()[0], /^Paseo 업그레이드 대기 \|/);

  f.flag('ls-fail');
  f.set({ agents: ['idle'] });
  f.calls();
  f.run(['--auto']);
  assert.ok(!f.calls().includes('brew upgrade --cask paseo'), '에이전트 목록을 못 읽으면 바쁜 것으로 봄');
  f.flag('ls-fail', false);

  result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  assert.equal(f.daemon(), '0.13.2', '한가해지면 올림');
  assert.ok(!existsSync(join(f.state, 'blocked')));
  assert.equal(f.status().result, 'ok');
});

test('앱이 스스로 업데이트했으면 데몬만 멈췄다가 다시 띄운다', t => {
  const f = fixture(t);
  f.set({ app: '0.13.2', daemon: '0.12.0', cask: '0.13.2' });
  const result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  const calls = f.calls();
  assert.ok(!calls.includes('brew upgrade --cask paseo'));
  assert.ok(calls.indexOf('paseo daemon stop') < calls.findIndex(call => call.startsWith('kickstart')));
  assert.equal(f.daemon(), '0.13.2');
  assert.deepEqual(f.notifications(), ['Paseo 업그레이드됨 | Paseo 데몬 0.12.0 → 0.13.2']);

  // 앱이 관리하는 데몬은 앱에 맡긴다.
  f.set({ daemon: '0.12.0' });
  writeFileSync(join(f.mock, 'desktop-managed'), 'true');
  f.calls();
  f.run(['--auto']);
  assert.ok(!f.calls().includes('paseo daemon stop'));
});

test('데몬이 멈춰 있으면 앱만 올리고, 자동 시작 등록이 없으면 CLI로 띄운다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: null, cask: '0.13.2' });
  assert.equal(f.run(['--auto']).status, 0);
  let calls = f.calls();
  assert.ok(calls.includes('brew upgrade --cask paseo'));
  assert.ok(!calls.some(call => call.startsWith('kickstart') || call === 'paseo daemon start'), '멈춰 있던 데몬은 띄우지 않음');

  f.set({ app: '0.12.0', daemon: '0.12.0' });
  f.flag('registered', false);
  assert.equal(f.run(['--auto']).status, 0);
  calls = f.calls();
  assert.ok(calls.includes('paseo daemon start'));
  assert.equal(f.daemon(), '0.13.2');
});

test('앱 화면이 켜져 있거나 Homebrew 밖에서 설치했으면 앱 업데이트에 맡긴다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2' });
  f.flag('app-open');
  let result = f.run();
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /앱이 켜져 있어 앱의 자동 업데이트에 맡깁니다/);
  assert.ok(!f.calls().includes('brew upgrade --cask paseo'));
  f.flag('app-open', false);

  f.flag('outside');
  result = f.run(['--force']);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /Homebrew 밖에서 설치한 Paseo/);
  assert.ok(!f.calls().includes('brew upgrade --cask paseo'));
  assert.equal(f.appVersion(), '0.12.0');
});

test('brew 실패는 데몬을 다시 띄우고 실패로 알린다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2' });
  writeFileSync(join(f.mock, 'exit-upgrade'), '1');
  const result = f.run(['--auto']);
  assert.equal(result.status, 1, output(result));
  assert.equal(f.daemon(), '0.12.0', '옛 버전으로 다시 띄움');
  assert.equal(f.status().result, 'failed');
  assert.match(f.notifications()[0], /^Paseo 업그레이드 실패 \| Paseo 0\.12\.0 → 0\.13\.2 실패/);
});

test('노트북, dry-run, Paseo 에이전트 안에서는 바꾸지 않는다', t => {
  const f = fixture(t);
  f.set({ app: '0.12.0', daemon: '0.12.0', cask: '0.13.2' });
  let result = f.run(['--dry-run']);
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[dry-run\] Paseo 0\.12\.0 → 0\.13\.2: brew upgrade --cask paseo/);
  assert.deepEqual(f.calls().filter(call => /^brew (update|upgrade)|^kickstart|daemon stop/.test(call)), []);
  assert.ok(!existsSync(join(f.state, 'latest')));

  result = f.run([], { PASEO_AGENT_ID: 'a1' });
  assert.equal(result.status, 1);
  assert.match(output(result), /Paseo 에이전트 안에서는 실행하지 않습니다/);

  f.flag('laptop');
  result = f.run(['--auto']);
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls().filter(call => call.startsWith('brew')), []);
  assert.equal(f.appVersion(), '0.12.0');
});
