import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, realpathSync, readlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setup } from './browser-use-setup.mjs';

const official = '---\nname: browser-use\ndescription: Official test fixture\n---\n';
function fixture(fn) {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-browser-use-'));
  try { fn(home); } finally { rmSync(home, { recursive: true, force: true }); }
}
function skill(path, text = official) {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'SKILL.md'), text);
}
function cli({ absent = false, broken = false, alias = false, installFails = false } = {}) {
  const calls = [];
  let installed = !absent;
  const run = (command, args) => {
    calls.push([command, ...args]);
    if (command === 'browser-use') {
      if (!installed) return { error: { code: 'ENOENT' } };
      if (broken) return { status: 1, stderr: 'broken' };
      assert.ok(['--version', '--help', 'skill'].includes(args[0]), '설치 검사에서 daemon/브라우저 명령 금지');
      return { status: 0, stdout: args[0] === 'skill' ? official : '0.1.13\n' };
    }
    if (command === '/bin/sh') return { status: alias ? 0 : 1, stdout: alias ? '/personal/bu' : '' };
    assert.equal(command, 'uv');
    if (args[0] === 'tool') {
      assert.deepEqual(args, ['tool', 'install', '--python', '3.12', 'browser-use']);
      if (installFails) return { status: 1, stderr: 'offline' };
      installed = true;
    }
    return { status: 0, stdout: 'uv 0.13.1' };
  };
  return { run, calls };
}

test('새 기기: dry-run 무변경, uv 신규 설치, 양쪽 공식 스킬, 반복/doctor는 갱신 없음', () => fixture(home => {
  const state = cli({ absent: true });
  setup({ home, env: {}, dryRun: true, run: state.run });
  assert.equal(existsSync(join(home, '.codex')), false);
  assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  setup({ home, env: {}, run: state.run });
  for (const provider of ['.codex', '.claude']) assert.equal(readFileSync(join(home, provider, 'skills/browser-use/SKILL.md'), 'utf8'), official);
  setup({ home, env: {}, run: state.run });
  setup({ home, env: {}, check: true, run: state.run });
  assert.equal(state.calls.filter(c => c[0] === 'uv' && c[1] === 'tool').length, 1);
}));

test('커스텀 provider 홈: 기존 원본으로 연결하고 실제 검색 경로 검사', () => fixture(home => {
  const env = { CODEX_HOME: join(home, 'codex-custom'), CLAUDE_CONFIG_DIR: join(home, 'claude-custom') };
  const run = cli().run;
  setup({ home, env, run });
  for (const [custom, canonical] of [[env.CODEX_HOME, '.codex'], [env.CLAUDE_CONFIG_DIR, '.claude']]) {
    assert.equal(realpathSync(join(custom, 'skills/browser-use')), realpathSync(join(home, canonical, 'skills/browser-use')));
  }
  setup({ home, env, check: true, run });
}));

test('실제 provider skills 상위 링크와 shared Codex 경로는 중복 설치하지 않음', () => fixture(home => {
  const canonical = join(home, '.codex/skills');
  skill(join(canonical, 'browser-use'));
  mkdirSync(join(home, 'active'));
  symlinkSync(canonical, join(home, 'active/skills'));
  setup({ home, env: { CODEX_HOME: join(home, 'active') }, run: cli().run });
  rmSync(join(home, '.codex'), { recursive: true });
  skill(join(home, '.agents/skills/browser-use'));
  setup({ home, env: {}, run: cli().run });
  assert.equal(existsSync(join(home, '.codex/skills/browser-use')), false);
  setup({ home, env: {}, check: true, run: cli().run });
}));

test('개인 스킬·파일·깨진 링크·중복 충돌은 다른 provider 쓰기 전에 보존', () => {
  for (const kind of ['personal', 'file', 'broken', 'duplicate']) fixture(home => {
    const path = join(home, '.claude/skills/browser-use');
    mkdirSync(dirname(path), { recursive: true });
    if (kind === 'personal') skill(path, 'personal');
    if (kind === 'file') writeFileSync(path, 'personal');
    if (kind === 'broken') symlinkSync(join(home, 'missing'), path);
    if (kind === 'duplicate') {
      skill(join(home, '.agents/skills/browser-use'));
      skill(join(home, '.codex/skills/browser-use'));
    }
    assert.throws(() => setup({ home, env: {}, run: cli().run }));
    if (kind !== 'duplicate') assert.equal(existsSync(join(home, '.codex')), false);
    if (kind === 'personal') assert.equal(readFileSync(join(path, 'SKILL.md'), 'utf8'), 'personal');
    if (kind === 'file') assert.equal(readFileSync(path, 'utf8'), 'personal');
    if (kind === 'broken') assert.equal(readlinkSync(path), join(home, 'missing'));
    if (kind === 'duplicate') assert.equal(existsSync(path), false);
  });
});

test('깨진 CLI 링크는 미설치로 취급하지 않고 보존', () => fixture(home => {
  const bin = join(home, '.local/bin');
  mkdirSync(bin, { recursive: true });
  symlinkSync(join(home, 'missing-cli'), join(bin, 'browser-use'));
  const state = cli({ absent: true });
  assert.throws(() => setup({ home, env: { PATH: bin }, run: state.run }), /교체하지/);
  assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  assert.equal(readlinkSync(join(bin, 'browser-use')), join(home, 'missing-cli'));
}));

test('CLI/별칭/uv 실패 보존과 doctor 누락·다른 내용 검출', () => {
  for (const options of [{ broken: true }, { absent: true, alias: true }, { absent: true, installFails: true }]) fixture(home => {
    const state = cli(options);
    assert.throws(() => setup({ home, env: {}, run: state.run }));
    assert.equal(existsSync(join(home, '.codex')), false);
    if (options.alias || options.broken) assert.equal(state.calls.some(c => c[0] === 'uv'), false);
  });
  fixture(home => {
    const state = cli();
    assert.throws(() => setup({ home, env: {}, check: true, run: state.run }), /누락/);
    assert.equal(existsSync(join(home, '.codex')), false);
    skill(join(home, '.codex/skills/browser-use'), 'personal');
    assert.throws(() => setup({ home, env: {}, check: true, run: state.run }), /다릅니다/);
  });
});


test('browser 단계 dry-run은 Node 없는 PATH에서도 성공', () => fixture(home => {
  mkdirSync(join(home, 'scripts'));
  mkdirSync(join(home, 'empty-bin'));
  writeFileSync(join(home, 'scripts/lib.sh'), 'info() { printf "%s\\n" "$*"; }\n');
  const step = fileURLToPath(new URL('./steps/62-browser.sh', import.meta.url));
  const result = spawnSync('/bin/bash', [step], {
    env: { ...process.env, BOOTSTRAP_ROOT: home, DRY_RUN: '1', PATH: join(home, 'empty-bin') },
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Browser Use/);
  assert.equal(existsSync(join(home, '.codex')), false);
}));

test('양쪽 provider의 skills 상위 링크가 같은 실제 경로면 한 번만 배치', () => {
  for (const custom of [false, true]) fixture(home => {
    const shared = join(home, 'shared-skills');
    mkdirSync(shared);
    const codexHome = join(home, custom ? 'custom-codex' : '.codex');
    const claudeHome = join(home, custom ? 'custom-claude' : '.claude');
    for (const providerHome of [codexHome, claudeHome]) {
      mkdirSync(providerHome);
      symlinkSync(shared, join(providerHome, 'skills'));
    }
    const env = custom ? { CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome } : {};
    const run = cli().run;
    setup({ home, env, dryRun: true, run });
    assert.throws(() => setup({ home, env, check: true, run }), /누락/);
    assert.equal(existsSync(join(shared, 'browser-use')), false);
    setup({ home, env, run });
    for (const providerHome of [codexHome, claudeHome]) {
      assert.equal(readFileSync(join(providerHome, 'skills/browser-use/SKILL.md'), 'utf8'), official);
    }
    assert.equal(realpathSync(join(codexHome, 'skills/browser-use')), realpathSync(join(claudeHome, 'skills/browser-use')));
    setup({ home, env, run });
    setup({ home, env, check: true, run });
  });
});

test('Claude 검색 경로가 빈 shared 경로를 가리켜도 첫 설치 후 중복 없이 검사·재실행', () => {
  for (const existingCodex of [false, true]) fixture(home => {
    const shared = join(home, '.agents/skills');
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(home, '.claude'));
    symlinkSync(shared, join(home, '.claude/skills'));
    if (existingCodex) skill(join(home, '.codex/skills/browser-use'));
    const run = cli().run;
    setup({ home, env: {}, run });
    setup({ home, env: {}, check: true, run });
    setup({ home, env: {}, run });
    assert.equal(realpathSync(join(home, '.codex/skills/browser-use')), realpathSync(join(shared, 'browser-use')));
    assert.equal(readFileSync(join(shared, 'browser-use/SKILL.md'), 'utf8'), official);
  });
});

test('shared 생성 예정과 기존 Codex 원본 둘의 충돌은 쓰기 전에 검출', () => fixture(home => {
  const shared = join(home, '.agents/skills');
  mkdirSync(shared, { recursive: true });
  mkdirSync(join(home, '.claude'));
  symlinkSync(shared, join(home, '.claude/skills'));
  const codexHome = join(home, 'custom-codex');
  for (const dir of [join(home, '.codex'), codexHome]) skill(join(dir, 'skills/browser-use'));
  for (const check of [false, true]) {
    assert.throws(() => setup({ home, env: { CODEX_HOME: codexHome }, check, run: cli().run }), /중복/);
    assert.equal(existsSync(join(shared, 'browser-use')), false);
    for (const dir of [join(home, '.codex'), codexHome]) {
      assert.equal(readFileSync(join(dir, 'skills/browser-use/SKILL.md'), 'utf8'), official);
    }
  }
}));

test('browser 단계는 커스텀 Claude 홈의 기존 스킬을 재사용해 후속 설정까지 실행', () => fixture(home => {
  mkdirSync(join(home, 'scripts'));
  const lib = `
info() { :; }
ok() { :; }
die() { printf '%s\\n' "$*" >&2; exit 1; }
cli_works() { return 0; }
has() { return 0; }
command() { if [[ "$1" == -v && "$2" == agent-browser ]]; then printf '/opt/homebrew/bin/agent-browser\\n'; else builtin command "$@"; fi; }
agent-browser() { printf 'test\\n'; }
run() { "$@"; }
node() { printf '%s\\n' "$1" >> "$BROWSER_TEST_HOME/settings-calls"; }
npx() {
  mkdir -p "$BROWSER_TEST_HOME/.agents/skills/agent-browser" "$CLAUDE_CONFIG_DIR/skills/agent-browser"
  printf 'official fixture\\n' > "$BROWSER_TEST_HOME/.agents/skills/agent-browser/SKILL.md"
  cp "$BROWSER_TEST_HOME/.agents/skills/agent-browser/SKILL.md" "$CLAUDE_CONFIG_DIR/skills/agent-browser/SKILL.md"
  printf 'install\\n' >> "$BROWSER_TEST_HOME/install-calls"
}
`;
  writeFileSync(join(home, 'scripts/lib.sh'), lib);
  // HOME 자체를 바꾸지 않고, 시험 사본의 홈 참조만 격리 경로로 치환한다.
  const source = fileURLToPath(new URL('./steps/62-browser.sh', import.meta.url));
  const step = join(home, 'browser-step.sh');
  writeFileSync(step, readFileSync(source, 'utf8').replaceAll('$HOME', '${BROWSER_TEST_HOME}'));
  const env = { ...process.env, BOOTSTRAP_ROOT: home, BROWSER_TEST_HOME: home, DRY_RUN: '0', CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, 'custom-claude') };
  for (let i = 0; i < 2; i++) {
    const result = spawnSync('/bin/bash', [step], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(readFileSync(join(home, 'install-calls'), 'utf8').trim().split('\n').length, 1);
  assert.equal(readFileSync(join(home, 'settings-calls'), 'utf8').split('\n').filter(s => s.endsWith('/browser-settings.mjs')).length, 2);
}));
