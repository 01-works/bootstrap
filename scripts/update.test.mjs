import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, utimesSync, lstatSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = fileURLToPath(new URL('../', import.meta.url));
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// 단계 대역: 이름과 무인 실행 여부를 기록하고, $MOCK/exit-<이름>이 있으면 그 코드로 끝난다.
const mockStep = name => `#!/usr/bin/env bash
printf '%s %s\\n' ${name} "\${BOOTSTRAP_UNATTENDED:-0}" >> "$MOCK/calls"
exit "$(cat "$MOCK/exit-${name}" 2>/dev/null || echo 0)"
`;
const STEPS = ['00-preflight', '20-homebrew', '35-power', '40-dotfiles', '65-paseo', '80-autoupdate'];

// 원격 저장소, 다른 기기(seed), 이 기기(work). 실제 update.sh·bootstrap.sh·lib.sh에 대역 단계를 붙인다.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-update-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const remote = join(root, 'remote.git'), seed = join(root, 'seed'), work = join(root, 'work');
  const mock = join(root, 'mock'), bin = join(root, 'bin'), state = join(root, 'state/bootstrap/update');
  for (const dir of [seed, mock, bin]) mkdirSync(dir, { recursive: true });
  const env = { ...process.env, ...gitEnv, HOME: join(root, 'home'), XDG_STATE_HOME: join(root, 'state'),
    XDG_CONFIG_HOME: join(root, 'config'), PATH: `${bin}:${process.env.PATH}`, MOCK: mock, DRY_RUN: '0', ASSUME_YES: '0' };
  for (const key of ['BOOTSTRAP_ROOT', 'BOOTSTRAP_LOCKED', 'BOOTSTRAP_UNATTENDED', 'BOOTSTRAP_RESULTS']) delete env[key];
  const git = (cwd, ...args) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  // 알림 대역: macOS 알림과 휴대폰 알림 내용을 남긴다.
  writeFileSync(join(bin, 'osascript'), '#!/bin/sh\nshift 6; printf "%s | %s\\n" "$1" "$2" >> "$MOCK/notify"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MOCK/push"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'ps'), '#!/bin/sh\nprintf \'%s\\n\' codex\n', { mode: 0o755 });
  writeFileSync(join(bin, 'scutil'), '#!/bin/sh\necho TestMac\n', { mode: 0o755 });

  const write = (dir, files) => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content, { mode: 0o755 });
    }
  };
  for (const path of ['bootstrap.sh', 'scripts/lib.sh', 'scripts/update.sh']) {
    mkdirSync(dirname(join(seed, path)), { recursive: true });
    copyFileSync(join(repo, path), join(seed, path));
  }
  write(seed, {
    'scripts/doctor.sh': 'exit 0\n',
    'scripts/paseo-profiles.mjs': "import { appendFileSync } from 'node:fs';\n" +
      "appendFileSync(process.env.MOCK + '/calls', `paseo-profiles ${process.argv.slice(2).join(' ')}\\n`);\n",
    'README.md': 'readme\n', 'Brewfile': 'brew "git"\n', 'home/zsh/.zshrc': '# zsh\n', 'agents/paseo-profiles.json': '[]\n',
    ...Object.fromEntries(STEPS.map(file => [`scripts/steps/${file}.sh`, mockStep(file.replace(/^\d+-/, ''))])),
  });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '.');
  git(seed, 'commit', '-q', '-m', 'init');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', '-u', 'origin', 'main');
  git(root, 'clone', '-q', remote, work);

  const read = path => existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = path => read(path).split('\n').filter(Boolean);
  return {
    root, work, mock, state, git,
    // 다른 기기에서 고치고 push한다.
    push(files) {
      write(seed, files);
      git(seed, 'add', '.');
      git(seed, 'commit', '-q', '-m', Object.keys(files).join(' '));
      git(seed, 'push', '-q');
    },
    update: (...args) => spawnSync('/bin/bash', [join(work, 'bootstrap.sh'), 'update', ...args], { env, encoding: 'utf8' }),
    migrate: () => spawnSync('/bin/bash', [join(work, 'bootstrap.sh'), '--only', 'dotfiles', '--migrate-claude-settings'], { env, encoding: 'utf8' }),
    install: () => spawnSync('/bin/bash', [join(work, 'bootstrap.sh')], { env, encoding: 'utf8' }),
    // 기록된 단계 호출을 돌려주고 비운다.
    calls() { const result = lines(join(mock, 'calls')); rmSync(join(mock, 'calls'), { force: true }); return result; },
    notifications: () => lines(join(mock, 'notify')),
    pushes: () => read(join(mock, 'push')),
    status: () => Object.fromEntries(lines(join(state, 'status')).map(line => [line.split('=')[0], line.slice(line.indexOf('=') + 1)])),
    applied: () => read(join(state, 'applied')).trim(),
    head: () => git(work, 'rev-parse', 'HEAD'),
    remoteHead: () => git(remote, 'rev-parse', 'main'),
    exitWith: (name, code) => code === null ? rmSync(join(mock, `exit-${name}`), { force: true }) : writeFileSync(join(mock, `exit-${name}`), String(code)),
  };
}
const output = result => result.stdout + result.stderr;

test('처음에는 preflight를 뺀 전 단계, 이후에는 바뀐 파일에 해당하는 단계만 무인으로 실행한다', t => {
  const f = fixture(t);
  let result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['homebrew 1', 'power 1', 'dotfiles 1', 'paseo 1', 'autoupdate 1']);
  assert.equal(f.status().result, 'ok');
  assert.equal(f.status().banner, '');
  assert.equal(f.applied(), f.head());
  assert.equal(f.notifications().length, 1);
  assert.match(f.notifications()[0], /^bootstrap 적용됨 \|/);
  assert.ok(existsSync(join(f.state, 'checked')));
  assert.ok(!existsSync(join(f.root, 'state/bootstrap/lock')), '끝나면 잠금을 푼다');

  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), [], '바뀐 것이 없으면 아무것도 실행하지 않음');

  f.push({ 'README.md': 'docs\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.head(), f.remoteHead(), 'fast-forward로 받음');
  assert.deepEqual(f.calls(), [], '문서 변경은 실행할 단계가 없음');
  assert.equal(f.applied(), f.head());
  assert.equal(f.notifications().length, 1, '실행한 것이 없으면 알리지 않음');

  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['dotfiles 1']);

  f.push({ 'agents/paseo-plugins.json': '{}\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['paseo 1'], '플러그인 목록은 paseo 단계만');

  f.push({ 'agents/paseo-profiles.json': '[1]\n', 'Brewfile': 'brew "gh"\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['homebrew 1', 'paseo 1', 'paseo-profiles --update'], '실행 순서대로 한 번씩');

  f.push({ 'scripts/steps/35-power.sh': mockStep('power') + '# changed\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['power 1']);
  assert.equal(f.notifications().length, 5);

  f.push({ 'scripts/steps/66-heavy.sh': mockStep('heavy') });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['heavy 1'], '새 단계 파일은 그 단계');
  f.push({ 'scripts/yw-heavy.sh': '# yw-heavy\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['heavy 1'], 'yw-heavy 원본은 heavy 단계');

  f.push({ 'scripts/steps/90-roles.sh': mockStep('roles') });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['roles 1'], '새 단계 파일은 그 단계');
  f.push({ 'scripts/role.sh': '# role\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['roles 1'], '역할 코드는 roles 단계');
  f.push({ 'scripts/verifier-logs.sh': '# verifier-logs\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['roles 1'], '읽기 전용 SSH 강제 명령도 roles 단계');

  f.push({ 'scripts/verifier-clock.mjs': '// verifier-clock\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['roles 1'], 'guest clock helper도 roles 단계');

  f.push({ 'home/한글 파일': 'x\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['dotfiles 1'], '비ASCII 경로도 따옴표 없이 경로 규칙과 비교');
});

test('새 사용자 스킬 원본이 오면 paseo 단계로 연결하고 내용 갱신도 반영한다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  const skillPath = 'agents/skills/yw-chief-supervisor/SKILL.md';
  f.push({ [skillPath]: 'chief skill v1\n' });
  let result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['paseo 1']);
  assert.equal(readFileSync(join(f.work, skillPath), 'utf8'), 'chief skill v1\n');
  f.push({ [skillPath]: 'chief skill v2\n' });
  result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['paseo 1']);
  assert.equal(readFileSync(join(f.work, skillPath), 'utf8'), 'chief skill v2\n');
  const referencePath = 'agents/skills/yw-supervisor/references/archive-safety.md';
  for (const content of ['archive safety v1\n', 'archive safety v2\n']) {
    f.push({ [referencePath]: content });
    result = f.update('--auto');
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(f.calls(), ['paseo 1'], '중첩 references만 바뀌어도 paseo 단계 선택');
    assert.equal(readFileSync(join(f.work, referencePath), 'utf8'), content);
  }
});

test('수동 작업 대기는 자동으로 반복하지 않고, 터미널에서 실행하면 다시 실행한다', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, 'config/bootstrap'), { recursive: true });
  writeFileSync(join(f.root, 'config/bootstrap/notify-url'), 'https://ntfy.example/topic\n');
  f.exitWith('power', 2);
  let result = f.update('--auto');
  assert.equal(result.status, 2, output(result));
  f.calls();
  assert.equal(f.status().result, 'pending');
  assert.equal(f.status().pending, 'power');
  assert.match(f.status().banner, /수동 작업 대기: power → .*bootstrap\.sh update/);
  assert.equal(f.applied(), f.head(), '대기는 적용 기록을 막지 않음');
  assert.match(f.notifications().at(-1), /^bootstrap 수동 작업 대기 \| power/);
  assert.match(f.pushes(), /TestMac: bootstrap 수동 작업 대기/);
  assert.match(f.pushes(), /https:\/\/ntfy\.example\/topic/);

  const notified = f.notifications().length;
  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  result = f.update('--auto');
  assert.equal(result.status, 2, output(result));
  assert.deepEqual(f.calls(), ['dotfiles 1'], '대기 단계는 자동으로 다시 실행하지 않음');
  assert.equal(f.status().pending, 'power', '대기는 계속 남음');
  assert.equal(f.notifications().length, notified, '같은 대기는 새 커밋에도 다시 알리지 않음');

  f.exitWith('power', null);
  result = f.update();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['power 0'], '터미널 실행은 대기 단계를 사람이 있는 상태로 다시 실행');
  assert.equal(f.status().result, 'ok');
  assert.equal(f.status().banner, '');
});

test('heavy 사용 중 보류는 다음 자동 갱신에서 다시 확인하고 다른 수동 대기는 유지한다', t => {
  const f = fixture(t);
  f.exitWith('power', 2);
  assert.equal(f.update('--auto').status, 2);
  f.calls();
  f.exitWith('heavy', 2);
  f.push({ 'scripts/steps/66-heavy.sh': mockStep('heavy') });
  assert.equal(f.update('--auto').status, 2);
  assert.deepEqual(f.calls(), ['heavy 1']);
  assert.equal(f.status().pending, 'power heavy');
  assert.equal(f.update('--auto').status, 2, '같은 커밋의 다음 자동 갱신도 재시도');
  assert.deepEqual(f.calls(), ['heavy 1'], '일반 수동 대기는 자동 실행하지 않는다');
  f.exitWith('heavy', null);
  assert.equal(f.update('--auto').status, 2, '사용 중 참여자가 끝나면 heavy를 적용');
  assert.deepEqual(f.calls(), ['heavy 1']);
  assert.equal(f.status().pending, 'power', '완료한 heavy만 pending에서 제거');
  assert.equal(f.update('--auto').status, 0, '실행할 단계가 없으면 기존의 무작업 성공 코드를 유지');
  assert.equal(f.status().pending, 'power');
  assert.deepEqual(f.calls(), [], '완료한 heavy는 매번 다시 실행하지 않는다');
});

test('실패한 단계만 이어서 다시 시도하고, 같은 커밋은 한 시간 뒤에 자동으로 다시 시도한다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  f.exitWith('homebrew', 3);
  f.push({ 'Brewfile': 'brew "gh"\n', 'agents/paseo-profiles.json': '[1]\n' });
  let result = f.update('--auto');
  assert.equal(result.status, 1, output(result));
  assert.deepEqual(f.calls(), ['homebrew 1', 'paseo 1', 'paseo-profiles --update']);
  assert.equal(f.status().result, 'failed');
  assert.equal(f.status().failed, 'homebrew');
  assert.match(f.status().banner, /갱신 실패: homebrew .*update\.log/);
  assert.equal(f.applied(), f.head(), '적용 기록은 옮기고 실패한 단계는 상태로 이어 감');
  assert.match(f.notifications().at(-1), /^bootstrap 실패 \| homebrew/);
  const notified = f.notifications().length;

  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), [], '한 시간 안에는 다시 시도하지 않음');

  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  assert.equal(f.update('--auto').status, 1);
  assert.deepEqual(f.calls(), ['homebrew 1', 'dotfiles 1'], '새 커밋이 오면 바로, 성공했던 단계(paseo)는 반복하지 않음');
  assert.equal(f.notifications().length, notified, '같은 실패는 다시 알리지 않음');

  f.exitWith('homebrew', null);
  result = f.update();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['homebrew 0'], '터미널 실행은 바로 다시 시도');
  assert.equal(f.status().result, 'ok');
  assert.equal(f.notifications().length, notified, '터미널 실행은 알림을 보내지 않음');
});

test('받은 커밋의 update.sh 규칙으로 단계를 고른다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  const script = readFileSync(join(repo, 'scripts/update.sh'), 'utf8');
  const rule = '      home/*) out="$out dotfiles" ;;\n';
  assert.ok(script.includes(rule));
  f.push({ 'scripts/update.sh': script.replace(rule, rule + '      extra/*) out="$out dotfiles" ;;\n'), 'extra/file': 'x\n' });
  const result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['dotfiles 1']);
  assert.equal((result.stdout.match(/^\[\d{4}-/gm) || []).length, 1, '다시 시작해도 시각은 한 번만 기록');
  assert.ok(!existsSync(join(f.root, 'state/bootstrap/lock')), '다시 시작한 뒤에도 잠금을 푼다');
});

test('실행 중에 이 기기로 들어온 커밋은 적용 기록에 넣지 않고 다음 갱신이 실행한다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  // $MOCK/land가 있으면 dotfiles 단계가 도는 동안 이 기기에서 home/ 변경을 커밋한다.
  const land = 'if [[ -f "$MOCK/land" ]]; then rm "$MOCK/land"; echo x >>"$BOOTSTRAP_ROOT/home/landed"\n' +
    '  git -C "$BOOTSTRAP_ROOT" add home/landed && git -C "$BOOTSTRAP_ROOT" commit -q -m landed; fi\n';
  f.push({ 'scripts/steps/40-dotfiles.sh': mockStep('dotfiles').replace('exit ', land + 'exit ') });
  writeFileSync(join(f.mock, 'land'), '');
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['dotfiles 1']);
  assert.notEqual(f.head(), f.remoteHead(), '실행 중에 커밋이 들어옴');
  assert.equal(f.applied(), f.remoteHead(), '시작한 커밋까지만 적용으로 기록');
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['dotfiles 1'], '들어온 커밋의 단계는 다음 갱신이 실행');
  assert.equal(f.applied(), f.head());

  const start = f.head();
  writeFileSync(join(f.mock, 'land'), '');
  assert.equal(f.install().status, 0);
  f.calls();
  assert.notEqual(f.head(), start);
  assert.equal(f.applied(), start, '전체 설치도 시작한 커밋을 기록');
});

test('Homebrew 자체가 실패하면 실행하지 못한 뒤 단계도 실패로 남긴다', t => {
  const f = fixture(t);
  f.exitWith('homebrew', 1);
  assert.equal(f.update('--auto').status, 1);
  assert.deepEqual(f.calls(), ['homebrew 1']);
  assert.equal(f.status().failed, 'homebrew power dotfiles paseo autoupdate');
  f.exitWith('homebrew', null);
  assert.equal(f.update().status, 0);
  assert.deepEqual(f.calls(), ['homebrew 0', 'power 0', 'dotfiles 0', 'paseo 0', 'autoupdate 0']);
});

test('커밋 안 된 변경이 있으면 새 커밋을 받지 않고 한 번만 알리며, 정리하면 이어서 적용한다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  const head = f.head();
  writeFileSync(join(f.work, 'README.md'), 'local edit\n');
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), [], '새 커밋이 없으면 작업 중인 기기를 건드리지 않음');
  assert.notEqual(f.status().result, 'held');

  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.head(), head, '받지 않음');
  assert.deepEqual(f.calls(), []);
  assert.equal(f.status().result, 'held');
  assert.match(f.status().banner, /커밋 안 된 변경/);
  assert.match(f.notifications().at(-1), /^bootstrap 갱신 보류/);
  const notified = f.notifications().length;
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.notifications().length, notified, '같은 보류는 한 번만 알림');

  const manual = f.update();
  assert.equal(manual.status, 1);
  assert.match(output(manual), /커밋 안 된 변경/);

  f.git(f.work, 'checkout', '--', 'README.md');
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), ['dotfiles 1']);
  assert.equal(f.status().result, 'ok');
});

test('키 순서만 바뀐 JSON은 되돌리고 받으며, 값이 바뀐 JSON은 보류한다', t => {
  const f = fixture(t);
  f.push({ 'home/claude/.claude/settings.json': '{\n  "a": true,\n  "theme": "dark",\n  "list": [1, 2]\n}\n' });
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  const settings = join(f.work, 'home/claude/.claude/settings.json');
  const reordered = '{\n  "theme": "dark",\n  "list": [1, 2],\n  "a": true\n}\n';

  writeFileSync(settings, reordered);
  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  const dry = f.update('--dry-run');
  assert.equal(dry.status, 0);
  assert.match(output(dry), /\[dry-run\] 키 순서만 바뀐 home\/claude\/\.claude\/settings\.json 되돌리기/);
  assert.equal(readFileSync(settings, 'utf8'), reordered, 'dry-run은 되돌리지 않음');
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.head(), f.remoteHead(), '받음');
  assert.equal(f.git(f.work, 'status', '--porcelain', '--untracked-files=no'), '');
  assert.deepEqual(f.calls(), ['dotfiles 1']);
  assert.equal(f.status().result, 'ok');

  writeFileSync(settings, '{\n  "theme": "light",\n  "list": [1, 2],\n  "a": true\n}\n');
  f.push({ 'home/zsh/.zshrc': '# again\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.notEqual(f.head(), f.remoteHead(), '값이 바뀌면 받지 않음');
  assert.equal(f.status().result, 'held');
  assert.match(readFileSync(settings, 'utf8'), /"light"/, '사용자 변경은 그대로');

  writeFileSync(settings, '{\n  "theme": "dark",\n  "list": [2, 1],\n  "a": true\n}\n');
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.status().result, 'held', '배열 순서는 값으로 본다');
});

// 전환 전 설치는 settings.json을 저장소에 연결한다. update는 이전과 같은 fast-forward 경로를 쓴다.
function linkedSettings(t) {
  const f = fixture(t);
  const path = 'home/claude/.claude/settings.json';
  const original = readFileSync(join(repo, path), 'utf8');
  const dotfiles = readFileSync(join(repo, 'scripts/steps/40-dotfiles.sh'), 'utf8');
  f.push({ [path]: original, 'scripts/steps/40-dotfiles.sh': `mkdir -p "$HOME/.claude"
ln -sf "$BOOTSTRAP_ROOT/${path}" "$HOME/.claude/settings.json"
` });
  const result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  const local = join(f.root, 'home/.claude/settings.json');
  assert.ok(lstatSync(local).isSymbolicLink());
  f.calls();
  return { f, path, original, dotfiles, local };
}

test('자동 갱신은 기존 링크 전환을 pending으로 남기고 다른 단계와 후속 커밋 적용을 계속한다', t => {
  const { f, original, dotfiles, local } = linkedSettings(t);
  // 리뷰어의 마지막 cmp 직후 저장 주입. 자동 실행은 이 cmp 경로를 호출하지 않아야 한다.
  writeFileSync(join(f.root, 'bin/cmp'), `#!/bin/bash
/usr/bin/cmp "$@" || exit "$?"
touch "$MOCK/cmp-called"
printf '%s\\n' '{"theme":"late-save"}' > "$HOME/.claude/saved.json"
mv -f "$HOME/.claude/saved.json" "$HOME/.claude/settings.json"
`, { mode: 0o755 });
  f.push({ 'scripts/steps/40-dotfiles.sh': dotfiles, 'Brewfile': 'brew "gh"\n',
    'scripts/steps/65-paseo.sh': mockStep('paseo') + '# changed\n' });
  let result = f.update('--auto');
  assert.equal(result.status, 2, output(result));
  assert.equal(f.status().result, 'pending');
  assert.equal(f.status().pending, 'dotfiles');
  assert.equal(f.status().failed, '');
  assert.deepEqual(f.calls(), ['homebrew 1', 'paseo 1'], '뒤 단계도 계속 실행');
  assert.equal(readFileSync(local, 'utf8'), original);
  assert.ok(lstatSync(local).isSymbolicLink());
  assert.ok(!existsSync(join(f.mock, 'cmp-called')));
  assert.equal(f.applied(), f.head());
  f.push({ 'README.md': 'next docs\n' });
  result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.equal(f.head(), f.remoteHead());
  assert.equal(f.status().pending, 'dotfiles', '새 커밋을 받아도 수동 전환 대기는 유지');
  assert.deepEqual(f.calls(), []);
  assert.ok(lstatSync(local).isSymbolicLink());
});

test('링크 상태의 값 변경은 보류하고 전환 후 로컬 변경은 clean 상태로 새 커밋을 받는다', t => {
  const { f, path, original, dotfiles, local } = linkedSettings(t);
  const changed = JSON.stringify({ ...JSON.parse(original), theme: 'light', enabledPlugins: { 'sentry@sentry': true } });
  writeFileSync(local, changed);
  f.push({ 'scripts/steps/40-dotfiles.sh': dotfiles });
  let result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.equal(f.status().result, 'held', '아직 링크인 동안 실제 값 변경은 보존하며 보류');
  assert.equal(readFileSync(local, 'utf8'), changed);
  f.git(f.work, 'checkout', '--', path); // 테스트에서 보존 확인을 마친 로컬 변경 정리
  result = f.update('--auto');
  assert.equal(result.status, 2, output(result));
  assert.equal(f.head(), f.remoteHead());
  assert.ok(lstatSync(local).isSymbolicLink());
  assert.equal(f.status().pending, 'dotfiles');
  result = f.migrate();
  assert.equal(result.status, 0, output(result));
  assert.ok(lstatSync(local).isFile());
  assert.equal(readFileSync(local, 'utf8'), original);
  const backup = join(f.root, 'state/bootstrap/backup');
  const copies = readdirSync(backup, { recursive: true }).filter(p => p.endsWith('/.claude/settings.json'));
  assert.equal(copies.length, 1);
  assert.ok(lstatSync(join(backup, copies[0])).isFile());
  assert.equal(readFileSync(join(backup, copies[0]), 'utf8'), original);

  writeFileSync(local, changed);
  assert.equal(f.git(f.work, 'status', '--porcelain'), '', '도구가 값을 고쳐도 저장소는 clean');
  f.push({ [path]: JSON.stringify({ ...JSON.parse(original), theme: 'system' }) });
  result = f.update('--auto');
  assert.equal(result.status, 0, output(result));
  assert.equal(f.head(), f.remoteHead(), '로컬 설정 때문에 새 커밋을 보류하지 않는다');
  assert.equal(f.status().result, 'ok');
  assert.equal(readFileSync(local, 'utf8'), changed, '후속 초기값 변경도 로컬 값은 보존');
  assert.equal(readdirSync(backup, { recursive: true }).filter(p => p.endsWith('/.claude/settings.json')).length, 1);
  assert.equal(f.git(f.work, 'status', '--porcelain'), '');
});

test('fast-forward 후 앞 단계 실패와 자동 재시도 생략 중에도 기존 설정 링크를 읽을 수 있다', t => {
  const { f, original, dotfiles, local } = linkedSettings(t);
  f.push({ 'scripts/steps/40-dotfiles.sh': dotfiles, 'Brewfile': 'brew "gh"\n' });
  f.exitWith('homebrew', 1);
  const result = f.update('--auto');
  assert.equal(result.status, 1, output(result));
  assert.equal(f.head(), f.remoteHead(), 'fast-forward를 이미 마친 상태');
  assert.ok(lstatSync(local).isSymbolicLink(), '앞 단계 실패로 전환은 미실행');
  assert.equal(readFileSync(local, 'utf8'), original, '기존 링크는 계속 유효');
  f.calls();
  assert.equal(f.update('--auto').status, 0, '같은 커밋의 자동 재시도는 한 시간 생략');
  assert.deepEqual(f.calls(), []);
  assert.equal(readFileSync(local, 'utf8'), original);
  f.exitWith('homebrew', null);
  assert.equal(f.update().status, 2, '기본 수동 update도 전환하지 않음');
  assert.ok(lstatSync(local).isSymbolicLink());
  assert.equal(f.migrate().status, 0);
  assert.ok(lstatSync(local).isFile());
  assert.equal(f.update().status, 0, '전환 뒤 기존 pending을 정리');
  assert.equal(readFileSync(local, 'utf8'), original);
});

test('전환과 후속 초기값 변경 여러 커밋을 함께 받아도 기존 링크 대상의 현재 내용을 백업한다', t => {
  const { f, path, original, dotfiles, local } = linkedSettings(t);
  f.push({ 'scripts/steps/40-dotfiles.sh': dotfiles });
  const current = JSON.stringify({ ...JSON.parse(original), theme: 'system' });
  f.push({ [path]: current });
  const result = f.update('--auto');
  assert.equal(result.status, 2, output(result));
  assert.equal(f.head(), f.remoteHead());
  assert.ok(lstatSync(local).isSymbolicLink());
  assert.equal(f.migrate().status, 0);
  assert.ok(lstatSync(local).isFile());
  // 전환 전까지는 같은 경로의 저장소 값 변경이 기존 링크를 통해 반영된다.
  assert.equal(readFileSync(local, 'utf8'), current);
  const backup = join(f.root, 'state/bootstrap/backup');
  const copies = readdirSync(backup, { recursive: true }).filter(p => p.endsWith('/.claude/settings.json'));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(backup, copies[0]), 'utf8'), current);
  assert.ok(!existsSync(join(f.work, `${path}.seed`)), '별도 seed 또는 끊긴 링크 복구에 의존하지 않음');
});

test('갈라진 기록이나 main이 아닌 브랜치는 받지 않는다', t => {
  const f = fixture(t);
  assert.equal(f.update('--auto').status, 0);
  f.calls();
  writeFileSync(join(f.work, 'local.txt'), 'x');
  f.git(f.work, 'add', '.');
  f.git(f.work, 'commit', '-q', '-m', 'local');
  f.push({ 'home/zsh/.zshrc': '# remote\n' });
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), []);
  assert.match(f.status().banner, /갈라졌습니다/);

  f.git(f.work, 'switch', '-q', '-c', 'feature');
  rmSync(join(f.state, 'checked'));
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), []);
  assert.match(f.status().banner, /main 브랜치/);
  assert.ok(existsSync(join(f.state, 'checked')), '브랜치 보류 중에도 확인 기록은 남겨 "하루 넘게 확인 못 함"과 구분');
});

test('다른 설치·갱신이 실행 중이면 자동 갱신은 건너뛰고, dry-run은 아무것도 바꾸지 않는다', t => {
  const f = fixture(t);
  const lock = join(f.root, 'state/bootstrap/lock');
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'pid'), String(process.pid));
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), []);
  assert.ok(!existsSync(join(f.state, 'checked')), '저장소도 확인하지 않음');
  assert.ok(existsSync(lock), '다른 실행의 잠금은 그대로');
  utimesSync(lock, new Date('2001-01-01'), new Date('2001-01-01'));
  assert.equal(f.update('--auto').status, 0);
  assert.equal(f.calls().length, 5, '재시동 전에 잡힌 잠금은 pid가 살아 있어도 버림');
  assert.ok(!existsSync(lock));
  rmSync(join(f.state, 'applied'));
  rmSync(join(f.state, 'status'));

  const head = f.head();
  f.push({ 'home/zsh/.zshrc': '# changed\n' });
  const result = f.update('--dry-run');
  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[dry-run\] 실행할 단계: homebrew power dotfiles paseo autoupdate/);
  assert.equal(f.head(), head);
  assert.deepEqual(f.calls(), []);
  assert.ok(!existsSync(join(f.state, 'status')));
});

test('전체 설치가 끝나면 적용 기록을 남겨 자동 갱신이 다시 실행하지 않는다', t => {
  const f = fixture(t);
  const result = f.install();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['preflight 0', 'homebrew 0', 'power 0', 'dotfiles 0', 'paseo 0', 'autoupdate 0']);
  assert.equal(f.applied(), f.head());
  assert.equal(f.update('--auto').status, 0);
  assert.deepEqual(f.calls(), []);
});

test('전체 설치의 실패·대기는 상태로 남겨 터미널의 update가 이어서 다시 실행한다', t => {
  const f = fixture(t);
  f.exitWith('power', 2);
  let result = f.install();
  assert.equal(result.status, 2, output(result));
  f.calls();
  assert.equal(f.status().result, 'pending');
  assert.equal(f.status().pending, 'power');
  assert.equal(f.applied(), f.head(), '대기는 적용 기록을 막지 않음');
  f.exitWith('power', null);
  result = f.update();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['power 0'], '설치에서 대기로 남은 단계를 다시 실행');
  assert.equal(f.status().result, 'ok');

  // 적용 기록이 있는 기기에서 전체 설치가 부분 실패하면 기록은 그대로 두고 실패를 남긴다.
  const applied = f.applied();
  f.push({ 'README.md': 'docs\n' });
  f.git(f.work, 'pull', '-q');
  f.exitWith('homebrew', 3);
  result = f.install();
  assert.equal(result.status, 1, output(result));
  f.calls();
  assert.equal(f.status().result, 'failed');
  assert.equal(f.status().failed, 'homebrew');
  assert.equal(f.applied(), applied, '실패하면 적용 기록을 옮기지 않음');
  f.exitWith('homebrew', null);
  result = f.update();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['homebrew 0'], '설치에서 실패한 단계를 다시 실행');
  assert.equal(f.status().result, 'ok');
  assert.equal(f.applied(), f.head());

  // Homebrew에서 멈추면 실행하지 못한 뒤 단계까지 실패로 남긴다.
  f.exitWith('homebrew', 1);
  result = f.install();
  assert.equal(result.status, 1, output(result));
  assert.deepEqual(f.calls(), ['preflight 0', 'homebrew 0']);
  assert.equal(f.status().result, 'failed');
  assert.equal(f.status().failed, 'homebrew power dotfiles paseo autoupdate');
  f.exitWith('homebrew', null);
  result = f.update();
  assert.equal(result.status, 0, output(result));
  assert.deepEqual(f.calls(), ['homebrew 0', 'power 0', 'dotfiles 0', 'paseo 0', 'autoupdate 0']);
  assert.equal(f.status().result, 'ok');
});
