// secrets 단계(scripts/steps/72-secrets.sh): 가짜 infisical·security로 설정·인증·검증·원자적 쓰기를 확인한다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';
// 셸 코드가 되려는 값: 작은따옴표로 문자열을 닫고 명령을 실행하려 한다.
const HOSTILE = "a'; touch \"$HOME/pwned\"; #'b";

function sandbox(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-secrets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'), bin = join(root, 'bin'), log = join(root, 'calls.log');
  mkdirSync(home);
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(root, 'values.json'), JSON.stringify([
    { key: 'OPENROUTER_API_KEY', value: 'abc' },
    { key: 'OTHER_KEY', value: 'x y $HOME `id`' },
    { key: 'HOSTILE_KEY', value: HOSTILE },
    { key: 'MULTI_LINE', value: 'line1\nline2' }
  ]));
  // 가짜 infisical: FAKE_* 환경 변수로 동작을 고른다. 호출 인자와 받은 비밀 환경 변수 유무를 기록한다(값은 기록하지 않음).
  writeFileSync(join(bin, 'infisical'), `#!/bin/bash
printf '%s|secret_env=%s|token_env=%s\\n' "$*" "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:+set}" "\${INFISICAL_TOKEN:+set}" >>"${log}"
case "$1 $2" in
  "login status")
    [[ -n "\${FAKE_STATUS_SLEEP:-}" ]] && sleep "$FAKE_STATUS_SLEEP"
    case "\${FAKE_SESSION:-}" in
      active) printf '{\\n  "sessions": [ { "kind": "user", "status": "active" } ]\\n}\\n'; exit 0 ;;
      expired) printf '{\\n  "sessions": [ { "kind": "user", "status": "expired" } ]\\n}\\n'; exit 1 ;;
      *) printf '{\\n  "sessions": []\\n}\\n'; exit 0 ;;
    esac ;;
  "login --method=universal-auth") [[ "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}" == s3cret ]] || { echo bad >&2; exit 1; }; printf 'tok-123\\n'; exit 0 ;;
esac
if [[ "$1" == export ]]; then
  [[ -n "\${FAKE_IGNORE_TERM:-}" ]] && trap '' TERM
  [[ -n "\${FAKE_SLEEP:-}" ]] && { sleep "$FAKE_SLEEP" & wait $!; }
  case "\${FAKE_EXPORT:-ok}" in
    ok) cat "${join(root, 'values.json')}" ;;
    prompt) printf '\\033[2K? Select your hosting option:\\n' ; echo 'No valid login session found' >&2; exit 1 ;;
    badkey) printf '[{"key":"A;rm","value":"1"}]' ;;
    hidden) printf '[{"key":"A","value":"","secretValueHidden":true}]' ;;
    notjson) printf 'export A=1\\n' ;;
  esac
  exit 0
fi
exit 0
`, { mode: 0o755 });
  // 가짜 security: FAKE_KEYCHAIN=1이면 기기 계정 값을 돌려준다.
  writeFileSync(join(bin, 'security'), `#!/bin/bash
[[ -n "\${FAKE_KEYCHAIN_SLEEP:-}" ]] && sleep "$FAKE_KEYCHAIN_SLEEP"
[[ "\${FAKE_KEYCHAIN:-}" == 1 ]] || exit 44
case "$*" in
  *"-a client-id"*) echo cid-1 ;;
  *"-a client-secret"*) echo s3cret ;;
  *) exit 44 ;;
esac
`, { mode: 0o755 });
  const config = join(home, '.config/bootstrap/secrets.env');
  const writeConfig = (text = `INFISICAL_PROJECT_ID=${PROJECT}\nINFISICAL_ENV=prod\nINFISICAL_PATH=/common\n`) => {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, text);
  };
  const run = (env = {}, path = `${bin}:/usr/bin:/bin`) => spawnSync('/bin/bash', [join(repo, 'scripts/steps/72-secrets.sh')], {
    env: { PATH: path, HOME: home, BOOTSTRAP_ROOT: repo, BOOTSTRAP_BREW_PREFIX: join(root, 'no-brew'), DRY_RUN: '0', XDG_STATE_HOME: join(root, 'state'), TMPDIR: root, ...env },
    encoding: 'utf8', input: ''
  });
  const target = join(home, '.zsh_secrets.infisical');
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  const leftovers = () => readdirSync(home).filter(name => name.startsWith('.zsh_secrets.infisical.'));
  return { root, home, run, writeConfig, target, calls, leftovers };
}

test('secrets 단계: 설정이 없으면 아무것도 하지 않는다', t => {
  const s = sandbox(t);
  const result = s.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /비밀값 동기화 설정 없음/);
  assert.equal(existsSync(s.target), false);
  assert.equal(s.calls(), '');
});

test('secrets 단계: 값은 그대로 보존되고 셸 코드로 실행되지 않는다', t => {
  const s = sandbox(t);
  s.writeConfig();
  writeFileSync(join(s.home, '.zsh_secrets'), 'export MINE=1\n', { mode: 0o600 });
  const result = s.run({ FAKE_SESSION: 'active' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /비밀값 4개/);
  assert.equal(statSync(s.target).mode & 0o777, 0o600);
  assert.match(s.calls(), new RegExp(`export --silent --projectId ${PROJECT} --env prod --path /common --format json`));
  // zsh로 실제로 읽어 값이 바이트 단위로 같고, 표식 파일이 생기지 않는지 본다.
  const read = spawnSync('/bin/zsh', ['-f', '-c', `source ${JSON.stringify(s.target)}; printf '%s\\0' "$OPENROUTER_API_KEY" "$OTHER_KEY" "$HOSTILE_KEY" "$MULTI_LINE"`],
    { env: { HOME: s.home, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(read.stdout.split('\0').slice(0, 4), ['abc', 'x y $HOME `id`', HOSTILE, 'line1\nline2']);
  assert.equal(existsSync(join(s.home, 'pwned')), false, '값 안의 명령이 실행되면 안 된다');
  assert.equal(readFileSync(join(s.home, '.zsh_secrets'), 'utf8'), 'export MINE=1\n', '손으로 쓰는 파일은 그대로');
  const state = readFileSync(join(s.root, 'state/bootstrap/secrets/last-sync'), 'utf8');
  assert.match(state, /count=4/);
  assert.doesNotMatch(state, /abc/, '상태 파일에 값을 남기지 않는다');
  assert.deepEqual(s.leftovers(), []);
});

test('secrets 단계: 로그인이 없거나 만료되면 자동 갱신에서는 수동 작업 대기(2)', t => {
  const s = sandbox(t);
  s.writeConfig();
  for (const session of ['', 'expired']) {
    const result = s.run({ BOOTSTRAP_UNATTENDED: '1', FAKE_SESSION: session });
    assert.equal(result.status, 2, `${session}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Infisical 로그인/);
  }
  assert.doesNotMatch(s.calls(), /^export /m);
});

test('secrets 단계: 실패하거나 쓸 수 없는 내용이면 기존 파일을 지킨다', t => {
  const s = sandbox(t);
  s.writeConfig();
  writeFileSync(s.target, "export OLD='keep'\n", { mode: 0o600 });
  for (const [mode, message] of [['prompt', /비밀값 받기 실패 \(exit 1\)/], ['badkey', /쓸 수 없는 이름/], ['hidden', /값을 읽을 권한이 없습니다/], ['notjson', /JSON이 아닙니다/]]) {
    const result = s.run({ FAKE_SESSION: 'active', FAKE_EXPORT: mode });
    assert.equal(result.status, 1, mode);
    assert.match(result.stderr, message, mode);
    assert.equal(readFileSync(s.target, 'utf8'), "export OLD='keep'\n", mode);
  }
  assert.deepEqual(s.leftovers(), []);
});

test('secrets 단계: 기기 계정은 키체인 값을 환경 변수로만 넘기고 토큰으로 받는다', t => {
  const s = sandbox(t);
  s.writeConfig();
  const result = s.run({ FAKE_KEYCHAIN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /기기 계정/);
  const calls = s.calls();
  assert.match(calls, /^login --method=universal-auth --silent --plain\|secret_env=set\|/m);
  assert.doesNotMatch(calls, /s3cret|cid-1|tok-123/, '비밀값·토큰은 인자로 넘기지 않는다');
  assert.match(calls, /^export .*\|token_env=set$/m);
  assert.doesNotMatch(calls, /login status/, '기기 계정이면 사람 세션을 보지 않는다');
});

test('secrets 단계: 키체인·로그인 확인·받기 모두 시간 제한을 받고, TERM을 무시해도 끊는다', t => {
  const s = sandbox(t);
  s.writeConfig();
  const timed = (env, limitMs) => {
    const started = Date.now();
    const result = s.run({ BOOTSTRAP_SECRETS_TIMEOUT: '1', ...env });
    return { result, ms: Date.now() - started, limitMs };
  };
  // 키체인이 멈추면 기기 계정 없이 사람 세션으로 넘어간다(무인이면 대기 2).
  let r = timed({ FAKE_KEYCHAIN_SLEEP: '6', BOOTSTRAP_UNATTENDED: '1' }, 5000);
  assert.equal(r.result.status, 2, r.result.stderr);
  assert.ok(r.ms < r.limitMs, `키체인 제한: ${r.ms}ms`);
  r = timed({ FAKE_STATUS_SLEEP: '6', BOOTSTRAP_UNATTENDED: '1' }, 5000);
  assert.equal(r.result.status, 2, r.result.stderr);
  assert.ok(r.ms < r.limitMs, `로그인 확인 제한: ${r.ms}ms`);
  r = timed({ FAKE_SESSION: 'active', FAKE_SLEEP: '8', FAKE_IGNORE_TERM: '1' }, 6000);
  assert.equal(r.result.status, 1);
  assert.match(r.result.stderr, /exit 124/);
  assert.ok(r.ms < r.limitMs, `TERM 무시 제한: ${r.ms}ms`);
  assert.equal(existsSync(s.target), false);
});

test('secrets 단계: README 형식의 줄 끝 주석을 읽고, 잘못된 설정·대상은 거부한다', t => {
  const s = sandbox(t);
  s.writeConfig(`INFISICAL_PROJECT_ID=${PROJECT}\nINFISICAL_ENV=prod          # 생략하면 prod\nINFISICAL_PATH=/common      # 생략하면 /common\n# INFISICAL_DOMAIN=https://eu.infisical.com\n`);
  let result = s.run({ FAKE_SESSION: 'active' });
  assert.equal(result.status, 0, result.stderr);

  result = s.run({ FAKE_SESSION: 'active', DRY_RUN: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[dry-run\]/);

  result = s.run({}, `/usr/bin:/bin`);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /infisical 명령이 없습니다/);

  s.writeConfig('INFISICAL_PROJECT_ID=abc; rm -rf ~\n');
  result = s.run({ FAKE_SESSION: 'active' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /값 형식이 잘못됐습니다/);

  s.writeConfig(`INFISICAL_PROJECT_ID=${PROJECT}\nINFISICAL_DOMAIN=http://insecure.example\n`);
  result = s.run({ FAKE_SESSION: 'active' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /https:\/\//);

  s.writeConfig();
  rmSync(s.target);
  mkdirSync(s.target);
  result = s.run({ FAKE_SESSION: 'active' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /일반 파일이 아니라/);
  assert.deepEqual(s.leftovers(), []);
});
