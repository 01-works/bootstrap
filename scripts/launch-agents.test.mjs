import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_CHROME_URL, LABELS, PASEO_UPGRADE_INTERVAL, ROLE_DISABLED, UPDATE_INTERVAL, activeRoles, apply, definitions, harnessEnvPath, plist } from './launch-agents.mjs';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'bootstrap-launch-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const chromeBinary = join(home, 'Google Chrome Beta');
  writeFileSync(chromeBinary, '');
  // launchctl 대역: 등록 상태와 실행 중인 프로세스만 흉내 낸다.
  const loaded = new Set();
  const running = new Set();
  const calls = [];
  const run = (cmd, args) => {
    assert.equal(cmd, '/bin/launchctl');
    calls.push(args[0]);
    const label = args[1].split('/').pop();
    if (args[0] === 'print') return { status: loaded.has(label) ? 0 : 113, stdout: running.has(label) ? `${label} = {\n\tstate = running\n\tpid = 4242\n}\n` : '' };
    if (args[0] === 'bootstrap') { loaded.add(args[2].split('/').pop().replace(/\.plist$/, '')); return { status: 0 }; }
    if (args[0] === 'bootout') { loaded.delete(label); running.delete(label); return { status: 0 }; }
    throw new Error(`예상하지 못한 호출: ${args.join(' ')}`);
  };
  const options = { home, env: {}, run, uid: 501, chromeBinary };
  const agentPath = label => join(home, 'Library/LaunchAgents', `${label}.plist`);
  // 기기 역할 켜기·끄기 (scripts/role.sh의 상태 파일).
  const roleFile = join(home, '.config/bootstrap/roles/verifier');
  const setRole = on => on ? (mkdirSync(join(roleFile, '..'), { recursive: true }), writeFileSync(roleFile, 'colima_memory=6\n'))
    : rmSync(roleFile, { force: true });
  return { home, options, calls, loaded, running, agentPath, setRole };
}

test('기기 종류별 정의: 데스크톱은 로그인 시 시작, 노트북은 Chrome만 필요할 때', () => {
  const desktop = definitions({ home: '/h', laptop: false });
  assert.match(plist(desktop['agent-chrome']), /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist(desktop['agent-chrome']), /SuccessfulExit/);
  assert.match(plist(desktop['agent-chrome']), /--user-data-dir=\/h\/.local\/share\/bootstrap\/agent-chrome/);
  assert.match(plist(desktop.paseo), /<string>\/Applications\/Paseo\.app\/Contents\/Resources\/bin\/paseo<\/string>\s*<string>daemon<\/string>\s*<string>start<\/string>/);
  assert.match(plist(desktop.paseo), /<key>PATH<\/key><string>\/h\/.local\/bin:/);
  const upgrade = plist(desktop['paseo-upgrade']);
  assert.match(upgrade, /<string>paseo-upgrade<\/string>\s*<string>--auto<\/string>/);
  assert.match(upgrade, /<key>RunAtLoad<\/key><false\/>/, '로그인할 때 데몬과 함께 뜨지 않음');
  assert.match(upgrade, new RegExp(`<key>StartInterval</key><integer>${PASEO_UPGRADE_INTERVAL}</integer>`));
  assert.match(upgrade, /\/h\/.local\/state\/bootstrap\/paseo-upgrade\/upgrade\.log/);
  const laptop = definitions({ home: '/h', laptop: true });
  assert.match(plist(laptop['agent-chrome']), /<key>RunAtLoad<\/key><false\/>/);
  assert.doesNotMatch(plist(laptop['agent-chrome']), /KeepAlive/);
  assert.equal(laptop.paseo, null);
  assert.equal(laptop['paseo-upgrade'], null, '노트북은 앱이 스스로 업데이트');
  assert.match(plist({ label: 'x', args: ['a&b<c>'], runAtLoad: true }), /a&amp;b&lt;c&gt;/);
});

test('적용: dry-run·check 무변경, 등록·.env 추가, 재실행 무변경', t => {
  const f = fixture(t);
  const envPath = harnessEnvPath({ home: f.home, env: {} });
  assert.equal(apply({ ...f.options, laptop: false, dryRun: true }), 0);
  assert.equal(apply({ ...f.options, laptop: false, check: true }), 1);
  assert.equal(existsSync(join(f.home, 'Library')), false);
  assert.equal(existsSync(envPath), false);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  for (const label of Object.values(LABELS)) assert.ok(f.loaded.has(label));
  assert.equal(readFileSync(envPath, 'utf8'), `BU_CDP_URL=${AGENT_CHROME_URL}\n`);
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.ok(existsSync(join(f.home, '.local/share/bootstrap/agent-chrome')));
  const before = f.calls.length;
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  assert.equal(apply({ ...f.options, laptop: false, check: true }), 0);
  assert.ok(f.calls.slice(before).every(call => call === 'print'), '재실행은 조회만');
});

test('내용이 바뀐 등록만 내렸다 올리고, 노트북은 Paseo를 만들지 않는다', t => {
  const f = fixture(t);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: true }), 0);
  assert.deepEqual(f.calls.filter(call => call !== 'print'), ['bootout', 'bootstrap']);
  assert.match(readFileSync(f.agentPath(LABELS['agent-chrome']), 'utf8'), /<key>RunAtLoad<\/key><false\/>/);
  assert.ok(existsSync(f.agentPath(LABELS.paseo)), '기존 Paseo 등록은 지우지 않음');
});

test('.env의 다른 값은 보존하고, 다른 연결 대상은 덮어쓰지 않으며, Chrome Beta가 없으면 실패', t => {
  const f = fixture(t);
  const envPath = harnessEnvPath({ home: f.home, env: {} });
  mkdirSync(join(envPath, '..'), { recursive: true });
  writeFileSync(envPath, 'BROWSER_USE_API_KEY=keep');
  assert.equal(apply({ ...f.options, laptop: true, only: 'agent-chrome' }), 0);
  assert.equal(readFileSync(envPath, 'utf8'), `BROWSER_USE_API_KEY=keep\nBU_CDP_URL=${AGENT_CHROME_URL}\n`);
  writeFileSync(envPath, 'BU_CDP_URL=http://127.0.0.1:9222\n');
  assert.throws(() => apply({ ...f.options, laptop: true, only: 'agent-chrome' }), /덮어쓰지/);
  assert.equal(readFileSync(envPath, 'utf8'), 'BU_CDP_URL=http://127.0.0.1:9222\n');
  assert.equal(apply({ ...f.options, laptop: true, only: 'agent-chrome', chromeBinary: join(f.home, 'missing') }), 1);
  assert.equal(harnessEnvPath({ home: '/h', env: { BH_HOME: '/bh' } }), '/bh/agent-workspace/.env');
});

test('자동 갱신은 모든 기기에서 같고, 로그인할 때와 주기마다 낮은 우선순위로 실행한다', () => {
  const desktop = plist(definitions({ home: '/h', laptop: false, root: '/repo' }).update);
  assert.equal(plist(definitions({ home: '/h', laptop: true, root: '/repo' }).update), desktop);
  assert.match(desktop, /<string>\/bin\/bash<\/string>\s*<string>\/repo\/bootstrap\.sh<\/string>\s*<string>update<\/string>\s*<string>--auto<\/string>/);
  assert.match(desktop, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(desktop, new RegExp(`<key>StartInterval</key><integer>${UPDATE_INTERVAL}</integer>`));
  assert.match(desktop, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(desktop, /<key>StandardOutPath<\/key><string>\/h\/.local\/state\/bootstrap\/update\/update\.log<\/string>/);
  assert.doesNotMatch(desktop, /KeepAlive/);
  const custom = definitions({ home: '/h', laptop: false, env: { XDG_STATE_HOME: '/s' } }).update;
  assert.match(plist(custom), /\/s\/bootstrap\/update\/update\.log/);
  assert.ok(custom.args[1].endsWith('/bootstrap.sh'), '기본값은 이 저장소');
});

test('자동 갱신 중(noRestart)에는 실행 중인 등록을 내렸다 올리지 않고 대기로 알린다', t => {
  const f = fixture(t);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  writeFileSync(f.agentPath(LABELS.paseo), 'old');
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: false, only: 'paseo', noRestart: true }), 2);
  assert.ok(f.calls.every(call => call === 'print'), '내리지 않음');
  assert.equal(readFileSync(f.agentPath(LABELS.paseo), 'utf8'), 'old');
  f.loaded.delete(LABELS.update);
  assert.equal(apply({ ...f.options, laptop: false, only: 'update', noRestart: true }), 0, '등록이 없으면 올림');
  assert.ok(f.loaded.has(LABELS.update));
  assert.equal(apply({ ...f.options, laptop: false, noRestart: true, chromeBinary: join(f.home, 'missing') }), 1, '실패가 대기보다 우선');
  const xdg = plist(definitions({ home: '/h', laptop: false, env: { XDG_STATE_HOME: '/s' } }).update);
  assert.match(xdg, /<key>XDG_STATE_HOME<\/key><string>\/s<\/string>/, '셸의 상태 위치를 launchd에도 줌');
});

test('verifier 역할: 세 정의는 null이고 자동 갱신은 그대로다', t => {
  const roles = ['verifier'];
  assert.deepEqual(ROLE_DISABLED.verifier, ['agent-chrome', 'paseo', 'paseo-upgrade']);
  for (const laptop of [false, true]) {
    const defs = definitions({ home: '/h', laptop, roles });
    for (const name of ROLE_DISABLED.verifier) assert.equal(defs[name], null, `${name} (laptop=${laptop})`);
    assert.equal(plist(defs.update), plist(definitions({ home: '/h', laptop }).update));
  }
  const f = fixture(t);
  assert.deepEqual(activeRoles({ home: f.home }), []);
  f.setRole(true);
  assert.deepEqual(activeRoles({ home: f.home }), ['verifier']);
  assert.deepEqual(activeRoles({ home: '/elsewhere', env: { XDG_CONFIG_HOME: join(f.home, '.config') } }), ['verifier']);
});

test('verifier 역할: 등록이 있으면 내리고 plist를 지운다. --check는 없을 때 0, 있을 때 1. 끄면 다시 등록한다', t => {
  const f = fixture(t);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  f.setRole(true);
  for (const name of ROLE_DISABLED.verifier) assert.equal(apply({ ...f.options, laptop: false, only: name, check: true }), 1, `${name} 남아 있음`);
  assert.equal(apply({ ...f.options, laptop: false, dryRun: true }), 0);
  assert.ok(f.loaded.has(LABELS.paseo), 'dry-run은 내리지 않음');
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  assert.equal(f.calls.filter(call => call === 'bootout').length, 3);
  for (const name of ROLE_DISABLED.verifier) {
    assert.equal(f.loaded.has(LABELS[name]), false, name);
    assert.equal(existsSync(f.agentPath(LABELS[name])), false, `${name} plist`);
    assert.equal(apply({ ...f.options, laptop: false, only: name, check: true }), 0, `${name} 꺼짐`);
  }
  assert.ok(f.loaded.has(LABELS.update), '자동 갱신은 그대로');
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: false, noRestart: true }), 0, '다시 실행해도 같다');
  assert.ok(f.calls.every(call => call === 'print'));

  f.setRole(false);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  for (const name of ROLE_DISABLED.verifier) assert.ok(f.loaded.has(LABELS[name]), `${name} 다시 등록`);
});

test('verifier 역할: 실행 중인 에이전트 Chrome은 끄지 않고 plist만 지워 대기로 알린다. 끝난 뒤 다시 실행하면 내린다', t => {
  const f = fixture(t);
  assert.equal(apply({ ...f.options, laptop: false, only: 'agent-chrome' }), 0);
  f.running.add(LABELS['agent-chrome']);
  f.setRole(true);
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: false, only: 'agent-chrome' }), 2);
  assert.ok(!f.calls.includes('bootout'), '실행 중인 Chrome을 내리지 않음');
  assert.ok(f.loaded.has(LABELS['agent-chrome']));
  assert.equal(existsSync(f.agentPath(LABELS['agent-chrome'])), false, '다음 로그인부터 시작하지 않게 plist를 지움');
  assert.equal(apply({ ...f.options, laptop: false, only: 'agent-chrome', check: true }), 2);
  f.running.delete(LABELS['agent-chrome']);
  assert.equal(apply({ ...f.options, laptop: false, only: 'agent-chrome', check: true }), 1);
  assert.equal(apply({ ...f.options, laptop: false, only: 'agent-chrome' }), 0);
  assert.equal(f.loaded.has(LABELS['agent-chrome']), false);
  assert.equal(apply({ ...f.options, laptop: false, chromeBinary: join(f.home, 'missing') }), 0, 'Chrome Beta가 없어도 끄는 데는 상관없음');
});

test('roles를 넘기면 상태 파일 대신 그 역할로 판단한다 (role.sh dry-run 미리 보기)', t => {
  const f = fixture(t);
  assert.equal(apply({ ...f.options, laptop: false }), 0);
  f.setRole(true);
  f.calls.length = 0;
  assert.equal(apply({ ...f.options, laptop: false, dryRun: true, roles: [] }), 0, '역할을 끈 뒤로 미리 보면 등록 유지');
  assert.ok(!f.calls.includes('bootout'));
  f.setRole(false);
  assert.equal(apply({ ...f.options, laptop: false, only: 'paseo', check: true, roles: ['verifier'] }), 1, '켠 뒤로 보면 남아 있음');
  assert.throws(() => apply({ ...f.options, laptop: false, roles: ['builder'] }), /알 수 없는 역할/);
});
