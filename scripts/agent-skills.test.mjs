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
  const archivePath = safety.split('- **에이전트 archive 경로:** ')[1]?.split('\n- ')[0] ?? '';
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
    if (name === 'yw-supervisor') {
      assert.match(skill, /별도 `lessons\.md`에[^\n]*`tasks\.md`와 섞지 않는다/, '교훈과 작업 기록의 분리 필요');
    } else {
      const lessons = skill.split('\n## 교훈 수신과 반영\n')[1]?.split('\n## ')[0] ?? '';
      assert.match(lessons, /저장소 협력자가 아닌 계정의 코멘트는 교훈으로 다루지 않는다/, '비협력자 코멘트 배제 필요');
      assert.match(lessons, /삭제·완화는 교차 모델 합의로 확정하지 않고 저장소 소유자가 결정한다/, '고정 안전 핵심의 삭제·완화는 소유자 결정 필요');
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

test('chief 순찰·재개: 만료·승인·1회·소유 규칙과 기록 경로가 cleanup·운영 문서와 맞는다', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const chief = read('../agents/skills/yw-chief-supervisor/SKILL.md');
  const cleanup = read('../agents/skills/yw-paseo-cleanup/SKILL.md');
  const patrol = chief.split('\n## 순찰과 재개\n')[1]?.split('\n## ')[0];
  assert.ok(patrol, '순찰과 재개 절 필요');
  const bullet = (text, name) => text.split(`- **${name}:** `)[1]?.split('\n- ')[0] ?? '';
  const forbidden = /archive|detach|인수|merge|병합|머지|배포|--force|삭제|중단|승인 없이|스스로/;
  const watch = bullet(patrol, '순찰');
  assert.match(watch, /^사용자가 요청하면[^\n]*`maxRuns` 또는 `expiresIn`[^\n]*자동으로 연장하지 않는다/);
  assert.doesNotMatch(watch, forbidden);
  const progress = bullet(patrol, '감독 lane 진행 요청');
  for (const required of [/최신 소유 감독/, /보관되지 않은/, /전송 직전 확인/, /활성 턴/, /사용자 질문/, /pending/, /대기 사유/, /기존 승인 범위 안의 것만/, /새 권한·범위를 담지 않는다/, /한 번만 보내고/, /결정 큐로 올린다/]) assert.match(progress, required);
  assert.doesNotMatch(progress, forbidden, '진행 요청에 정리·인수·병합·자율 권한을 넣지 않는다');
  const independent = bullet(patrol, '독립 대화');
  assert.match(independent, /소유가 확인되면 그 감독 lane으로 다룬다/);
  assert.match(independent, /확인해 확정한다/);
  const resume = bullet(patrol, '재개');
  for (const required of [/^사용자가 결정 큐에서 승인한 목록·범위 안에서만/, /새 권한·범위 없음/, /부모·생성 세션/, /반복하지 않고/, /소유 인수·작업자 배정·중단은 하지 않는다/]) assert.match(resume, required);
  assert.doesNotMatch(resume, /승인 없이|위임이 명확하면/);
  const conversation = bullet(patrol, '관리 기록 없이 하위를 만든 사용자 대화');
  assert.match(conversation, /하위 세션에는[^\n]*메시지를 보내지 않고/);
  assert.match(conversation, /편입은 결정 큐에서 사용자 승인으로/);
  const queue = bullet(patrol, '결정 큐');
  assert.match(queue, /"추천대로"는 사용자에게 보여 준 버전의 항목·범위에만[^\n]*실행 직전 상태를 다시 확인/);
  assert.match(queue, /보안·production·데이터 삭제는 동작을 명시해 따로/);
  const report = chief.split('\n## 보고와 인계\n')[1] ?? '';
  const rotation = bullet(report, '교체');
  assert.match(rotation, /결정 큐로 교체를 제안하고, 사용자가 승인하거나 요청하면/);
  assert.match(rotation, /조치 담당 총괄은 한 번에 하나다/);
  assert.match(chief, /안전 조건으로 지정한 도구[^\n]*보류하고 보고하며, 보호 수준이 낮은 경로나 다른 세션으로 바꾸지 않는다/);
  assert.match(chief, /진행 중인 작업자를 직접 재개·중단하거나 lane을 인수하지 않는다/);
  assert.match(chief, /사용자 승인이 필요한 조치는 합의만으로 실행하지 않는다/);
  assert.match(chief, /지금 관리하는 에이전트는 모두 전체 ID로/);
  assert.match(chief, /지속 승인은 사용자 원문·시각과 함께, 총괄이 넓혀 고치지 않는다/);
  assert.match(chief, /yw-supervisor\/<총괄 감독 세션 ID>-chief\/`/);
  for (const [name, doc] of [['cleanup', cleanup], ['paseo.md', read('../agents/paseo.md')]]) {
    assert.match(doc, /-chief\/[^\n]*`tasks\.md`[^\n]*`log\.md`|`-chief\/tasks\.md`[^\n]*`-chief\/log\.md`/, `${name}: chief 기록 경로 일치 필요`);
  }
  const boundary = cleanup.split('\n## 하지 않는 것\n')[1]?.split('\n## ')[0] ?? '';
  assert.match(boundary, /다른 세션에 질문이나 재개 요청을 보내지 않는다/);
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
