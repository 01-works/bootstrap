import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('사용자 스킬: frontmatter 이름은 폴더와 같고 배포 위치에서 깨지는 상위 상대 링크가 없다', () => {
  const root = fileURLToPath(new URL('../agents/skills/', import.meta.url));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = readFileSync(join(root, entry.name, 'SKILL.md'), 'utf8');
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    assert.ok(frontmatter, `${entry.name}: frontmatter 필요`);
    assert.equal(frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1], entry.name);
    for (const [, target] of skill.matchAll(/\]\(<?([^\s)>]+)>?\)/g)) {
      const path = posix.normalize(target.split('#')[0]);
      assert.ok(!path.startsWith('../../'), `${entry.name}: 스킬 배포 경로 밖의 상대 링크 ${target}`);
    }
  }
});

test('archive 안전 대조: supervisor 내부·chief·운영 문서가 같은 공통 절차를 참조한다', () => {
  const anchor = 'archive-전-공통-안전-대조';
  const supervisorPath = fileURLToPath(new URL('../agents/skills/yw-supervisor/SKILL.md', import.meta.url));
  const sources = [
    ['../agents/skills/yw-supervisor/SKILL.md', ''],
    ['../agents/skills/yw-chief-supervisor/SKILL.md', '../yw-supervisor/SKILL.md'],
    ['../agents/paseo.md', 'skills/yw-supervisor/SKILL.md'],
  ];
  const supervisor = readFileSync(supervisorPath, 'utf8');
  const headings = [...supervisor.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replaceAll(' ', '-'));
  assert.equal(headings.filter(heading => heading === anchor).length, 1, '공통 절차의 anchor는 하나여야 한다');
  for (const [source, target] of sources) {
    const sourceUrl = new URL(source, import.meta.url);
    const doc = readFileSync(sourceUrl, 'utf8');
    const references = [...doc.matchAll(/\]\(([^)]+)\)/g)].map(([, href]) => href);
    assert.ok(references.includes(`${target}#${anchor}`), `${source}: 공통 절차 참조 필요`);
    assert.equal(fileURLToPath(new URL(target || sourceUrl.href, sourceUrl)), supervisorPath);
  }
});

test('archive 공통 절: 후손 재귀 조회·보류·강제 및 MCP 우회 금지 규칙을 유지한다', () => {
  const supervisor = readFileSync(new URL('../agents/skills/yw-supervisor/SKILL.md', import.meta.url), 'utf8');
  const safety = supervisor.split('\n## archive 전 공통 안전 대조\n')[1]?.split('\n## ')[0];
  assert.ok(safety, '공통 안전 대조 절 필요');
  assert.match(safety, /paseo\.parent-agent-id[^\n]*재귀로 끝까지 조회한다/);
  assert.match(safety, /관계·상태 변화[^\n]*archive를 보류/);
  assert.match(safety, /`--force`나 MCP로 우회하지 않는다/);
  const archivePath = safety.split('- **에이전트 archive 경로:** ')[1]?.split('\n- **')[0] ?? '';
  assert.match(archivePath, /이미 archive된 응답은[^\n]*그 밖의 거절 시 보존하고 거절 사유와 실제 상태를 기록한다/);
});

test('교훈 경로: 설치 원본 직접 수정 금지와 bootstrap 단일 수신 경로를 유지한다', () => {
  for (const name of ['yw-supervisor', 'yw-chief-supervisor']) {
    const skill = readFileSync(new URL(`../agents/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(skill, /설치 경로[^\n]*링크 원본을 직접 고치지 않는다/, `${name}: 설치 원본 보호 필요`);
    const inboxes = [...skill.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)]
      .map(([, href]) => new URL(href))
      .filter(url => url.searchParams.get('q')?.includes('label:skill-lesson'));
    assert.ok(inboxes.length > 0, `${name}: 수신 링크 필요`);
    for (const inbox of inboxes) {
      assert.equal(inbox.pathname, '/01-works/bootstrap/issues');
      assert.equal(inbox.searchParams.get('q'), 'is:issue is:open label:skill-lesson');
    }
  }
  for (const [source, heading, target] of [
    ['../agents/skills/yw-paseo-cleanup/SKILL.md', '다른 스킬·호스트·버전과의 경계', '../yw-supervisor/SKILL.md'],
    ['../agents/paseo.md', '기기 정리 스킬', 'skills/yw-supervisor/SKILL.md'],
  ]) {
    const doc = readFileSync(new URL(source, import.meta.url), 'utf8');
    const section = doc.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0];
    assert.ok(section, `${source}: 경계 절 필요`);
    const routing = section.split('\n\n').find(paragraph => paragraph.includes('skill-lesson'));
    assert.ok(routing, `${source}: 교훈 수신 경로 필요`);
    assert.ok(routing.includes(`](${target})`), `${source}: 감독의 변경 창구·포착 규칙 참조 필요`);
  }
});

for (const name of ['yw-supervisor', 'yw-chief-supervisor', 'yw-paseo-cleanup']) {
  test(`${name} 설치: dry-run, 양쪽 동일 원본, 재실행, 충돌·중복 보존`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'bootstrap-skills-test-'));
    const script = fileURLToPath(new URL('./agent-skills.mjs', import.meta.url));
    const source = fileURLToPath(new URL(`../agents/skills/${name}`, import.meta.url));
    const codex = join(dir, '.agents/skills', name);
    const claude = join(dir, '.claude/skills', name);
    const env = { ...process.env, DRY_RUN: '0' };
    delete env.CLAUDE_CONFIG_DIR;
    delete env.CODEX_HOME;
    const run = (...args) => spawnSync(process.execPath, [script, '--home', dir, ...args], { env, encoding: 'utf8' });
    try {
      assert.equal(run('--dry-run').status, 0);
      assert.equal(run('--check').status, 1);
      assert.equal(existsSync(join(dir, '.agents')), false);
      assert.equal(existsSync(join(dir, '.claude')), false);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readlinkSync(codex), source);
      assert.equal(readlinkSync(claude), source);
      assert.equal(existsSync(join(dir, '.codex/skills', name)), false);
      assert.equal(run().status, 0);
      assert.equal(run('--check').status, 0);
      rmSync(claude);
      rmSync(codex);
      mkdirSync(claude);
      writeFileSync(join(claude, 'SKILL.md'), 'personal skill');
      assert.equal(run().status, 1);
      assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'personal skill');
      assert.equal(existsSync(codex), false, '한쪽 충돌 시 다른 쪽도 쓰기 전에 중단');
      rmSync(claude, { recursive: true });
      mkdirSync(join(dir, '.codex/skills', name), { recursive: true });
      assert.equal(run().status, 1);
      assert.equal(existsSync(codex), false);
      assert.equal(existsSync(claude), false);
      // ~/.claude/skills가 ~/.agents/skills를 가리키는 기기에서는 한 번만 연결한다.
      rmSync(join(dir, '.codex'), { recursive: true });
      rmSync(join(dir, '.claude'), { recursive: true });
      mkdirSync(join(dir, '.claude'));
      symlinkSync(join(dir, '.agents/skills'), join(dir, '.claude/skills'));
      assert.equal(run().status, 0);
      assert.equal(readlinkSync(codex), source);
      assert.equal(run('--check').status, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
