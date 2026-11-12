import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readlinkSync, readFileSync, writeFileSync, rmSync, symlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

function assertDocumentLinks(file, root) {
  const doc = readFileSync(file, 'utf8');
  for (const [, href] of doc.matchAll(/\]\(<?([^\s)>]+)>?\)/g)) {
    if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(href)) continue;
    const [path, fragment] = href.split('#');
    const target = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const within = relative(root, target);
    assert.ok(within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within), `${file}: 배포 경로 밖의 상대 링크 ${href}`);
    assert.ok(existsSync(target), `${file}: 링크 파일 없음 ${href}`);
    if (fragment) {
      const headings = [...readFileSync(target, 'utf8').matchAll(/^#{1,6} (.+)$/gm)]
        .map(([, heading]) => heading.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replaceAll(' ', '-'));
      assert.ok(headings.includes(decodeURIComponent(fragment)), `${file}: 링크 앵커 없음 ${href}`);
    }
  }
}

function referenceMarkdown(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? referenceMarkdown(path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

function assertArchiveLoop(safety, label) {
  const steps = [...safety.matchAll(/^[ \t]*(\d+)\. (.+)$/gm)];
  assert.deepEqual(steps.map(([, number]) => Number(number)), [1, 2, 3, 4, 5, 6, 7], `${label}: 재개 루프 단계와 순서`);
  const conditions = [
    /승인 범위·완료·소유 조건을 충족한 잎 하나를 고른다/,
    /호출 직전에 그 대상의 후손 전체를 다시 조회해 미보관 후손이 0인지 확인한다/,
    /그 대상만 CLI로 `--force` 없이 archive한다/,
    /대상과 영향받는 후손의 `Archived`·`ArchivedAt`·부모 관계를 readback한다/,
    /확인에 성공한 뒤에만 다음 대상으로 1\)부터 반복한다/,
    /구성원 처리가 끝나면 workspace 조건\(자기·살아 있는 감독의 작업 공간 아님, 모든 구성원 완료·소유, 미커밋 변경·터미널 없음\)을 다시 확인한다/,
    /workspace를 archive하고 readback한다/,
  ];
  conditions.forEach((condition, i) => assert.match(steps[i][2], condition, `${label}: 재개 루프 ${i + 1}단계`));
  assert.match(safety, /미확인, 조건 불충족, readback 실패가 있으면 그 대상과 그것에 의존하는 부모·workspace에서 멈추고 보존한다/, `${label}: 재개 루프 멈춤 조건`);
}

test('사용자 스킬: frontmatter 이름은 폴더와 같고 본문·참조 링크가 배포 경로 안에서 열린다', () => {
  const root = fileURLToPath(new URL('../agents/skills/', import.meta.url));
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = readFileSync(join(root, entry.name, 'SKILL.md'), 'utf8');
    const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
    assert.ok(frontmatter, `${entry.name}: frontmatter 필요`);
    assert.equal(frontmatter.match(/^name:\s*(\S+)\s*$/m)?.[1], entry.name);
    for (const file of [join(root, entry.name, 'SKILL.md'), ...referenceMarkdown(join(root, entry.name, 'references'))]) {
      assertDocumentLinks(file, root);
    }
  }
});

test('스킬 링크 검사: 참조 기준 상대 경로·파일·앵커·배포 경계를 검증한다', t => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-skill-links-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'skills');
  const file = join(root, 'a/references/nested/guide.md');
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(join(root, 'b'));
  writeFileSync(join(root, 'b/SKILL.md'), '# 공통 안전 대조\n');
  writeFileSync(join(dir, 'outside.md'), '# 외부\n');
  writeFileSync(file, '[정상](../../../b/SKILL.md#공통-안전-대조)\n');
  assert.doesNotThrow(() => assertDocumentLinks(file, root));
  for (const [href, reason] of [
    ['../../../b/missing.md', /링크 파일 없음/],
    ['../../../b/SKILL.md#없는-앵커', /링크 앵커 없음/],
    ['../../../../outside.md', /배포 경로 밖/],
    ['../../../b/../../../outside.md', /배포 경로 밖/],
  ]) {
    writeFileSync(file, `[실패](${href})\n`);
    assert.throws(() => assertDocumentLinks(file, root), reason, href);
  }
});

test('archive 안전 대조: supervisor 내부·chief·cleanup·운영 문서가 같은 참조를 연다', () => {
  const anchor = 'archive-전-공통-안전-대조';
  const supervisorPath = fileURLToPath(new URL('../agents/skills/yw-supervisor/SKILL.md', import.meta.url));
  const safetyPath = fileURLToPath(new URL('../agents/skills/yw-supervisor/references/archive-safety.md', import.meta.url));
  const sources = [
    ['../agents/skills/yw-supervisor/SKILL.md', 'references/archive-safety.md', 3],
    ['../agents/skills/yw-chief-supervisor/SKILL.md', '../yw-supervisor/references/archive-safety.md', 1],
    ['../agents/skills/yw-paseo-cleanup/SKILL.md', '../yw-supervisor/references/archive-safety.md', 5],
    ['../agents/paseo.md', 'skills/yw-supervisor/references/archive-safety.md', 2],
  ];
  const supervisor = readFileSync(supervisorPath, 'utf8');
  const headings = [...supervisor.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading.toLowerCase().replaceAll(' ', '-'));
  assert.equal(headings.filter(heading => heading === anchor).length, 1, '공통 절차의 anchor는 하나여야 한다');
  for (const [source, target, count] of sources) {
    const sourceUrl = new URL(source, import.meta.url);
    const doc = readFileSync(sourceUrl, 'utf8');
    const references = [...doc.matchAll(/\]\(([^)]+)\)/g)].map(([, href]) => href);
    assert.equal(references.filter(href => href === target).length, count, `${source}: 공통 절차 참조 필요`);
    assert.equal(fileURLToPath(new URL(target, sourceUrl)), safetyPath);
  }
});

test('archive 공통 절: 후손 재귀 조회·보류·강제 및 MCP 우회 금지 규칙을 유지한다', () => {
  const safety = readFileSync(new URL('../agents/skills/yw-supervisor/references/archive-safety.md', import.meta.url), 'utf8');
  assert.ok(safety, '공통 안전 대조 절 필요');
  assert.match(safety, /paseo\.parent-agent-id[^\n]*재귀로 끝까지 조회한다/);
  assert.match(safety, /관계·상태 변화[^\n]*archive를 보류/);
  assert.match(safety, /`--force`나 MCP로 우회하지 않는다/);
  const checks = [
    ['후손 전체 조회', [
      /에이전트 archive는 대상 에이전트부터, workspace archive는 그 workspace의 모든 에이전트부터[^\n]*재귀로 끝까지 조회한다/,
      /직계 자식이나 같은 workspace 목록만으로 끝내지 않는다/,
      /CLI는 cursor로 끝까지 조회한다/,
      /MCP `list_agents`는 최대 200개이며 cursor가 없어 전체 후손 조회 수단으로 쓰지 않는다/,
      /관계·조회 범위를 확인할 수 없으면 보류한다/,
    ]],
    ['범위·완료·소유', [
      /closed를 포함한 모든 후손과 인계 체인을 완료·소유 판정에 포함한다/,
      /정리 대상 밖이거나 완료·소유를 확인하지 못한 후손이 하나라도 있거나 필요한 알림 중계가 남아 있으면[^\n]*부모 archive를 보류한다/,
      /부모의 완료·closed 상태만으로 후손의 완료를 판단하지 않는다/,
    ]],
    ['권한 내 분리', [
      /기존 권한 범위에서 `paseo agent detach <전체 agent ID>`[^\n]*소유와 현재·새 보고 경로[^\n]*먼저 확인한다/,
      /다른 소유자의 살아 있는 세션 detach는 일반 정리 권한에 포함되지 않는다[^\n]*소유 감독의 동의를 받고, 연락이 안 되면 사용자 승인을 받는다/,
      /감독 세션 자체를 detach할 때 동의 주체는 그 감독 자신이나 사용자이며, archive하려는 부모의 동의로 대신하지 않는다/,
      /parent 라벨이 제거됐는지, workspace·실행 상태가 보존됐는지 readback하고 새 보고 경로를 기록한다/,
      /자동 알림이 새 감독에게 이어진다고 가정하지 말고 후속 결과의 직접 보고 경로를 해당 세션에 알린다/,
    ]],
    ['실행 직전 대조', [
      /detach 뒤에는 남은 후손 전체를 다시 조회하고, archive 호출 직전에 대상·후손의 관계와 상태를 재확인한다/,
      /조회 누락, 분리 실패, 실행 직전 관계·상태 변화[^\n]*archive를 보류하고 이유를 보고한다/,
      /`--force`나 MCP로 우회하지 않는다/,
    ]],
    ['에이전트 archive 경로', [
      /로컬·원격 모두 `paseo agent archive <전체 agent ID>`를 `--force` 없이 사용/,
      /MCP `archive_agent`는 실행 중인 대상도 중단시키므로 쓰지 않는다/,
      /CLI의 running 거절은 대상 하나의 사전 검사[^\n]*후손의 running을 보호하는 원자적 보장은 아니다/,
      /이미 archive된 응답은[^\n]*그 밖의 거절 시 보존하고 거절 사유와 실제 상태를 기록한다/,
    ]],
    ['상태 변경 확인', [
      /대상 ID의 실제 상태를 다시 읽고 확인 결과를 기록한다[^\n]*성공 반환만으로 적용됐다고 쓰지 않는다/,
      /`Archived`·`ArchivedAt`과 부모 관계\(`ParentAgentId`\)를 대상 및 영향받는 하위에서 확인한다/,
      /활성 목록에서 사라진 것만으로 성공을 판정하지 않는다/,
      /이미 archive된 경우[^\n]*같은 readback으로 `Archived: true`와 `ArchivedAt`을 확인한 뒤 성공으로 처리하고, 확인할 수 없으면 보류한다/,
    ]],
    ['workspace 추가 조건', [
      /limit: 200\)`로 조회하고 결과가 200개면 보류한다/,
      /대상 workspaceId·cwd가 감독 자신이나 다른 살아 있는 감독의 workspace가 아닌지/,
      /모든 에이전트가 완료·소유 확인된 정리 대상 lane 소속인지, running agent·미커밋 변경·터미널이 없는지 대조한다/,
      /어느 조건이든 충족하지 못하거나 확인할 수 없으면 workspace를 남기고 보고한다/,
    ]],
  ];
  for (const [label, patterns] of checks) {
    const item = safety.split(`- **${label}:** `)[1]?.split('\n')[0];
    assert.ok(item, `${label}: 안전 항목 필요`);
    for (const pattern of patterns) assert.match(item, pattern, label);
  }
  const execution = safety.split('- **실행 직전 대조:** ')[1]?.split('\n- **')[0];
  assert.ok(execution, '참조: 실행 직전 대조 항목 필요');
  assertArchiveLoop(execution, '참조');
});

test('archive 본문: 세 진입점에 참조 읽기 조건과 실패·위험·권한·실행 순서 핵심이 남는다', () => {
  for (const [name, heading] of [
    ['yw-supervisor', 'archive 전 공통 안전 대조'],
    ['yw-chief-supervisor', '완료 판정과 세션 정리'],
    ['yw-paseo-cleanup', '자원별 정리 조건'],
  ]) {
    const skill = readFileSync(new URL(`../agents/skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    const safety = skill.split(`\n## ${heading}\n`)[1]?.split('\n## ')[0].split('\n### ')[0];
    assert.ok(safety, `${name}: 본문 안전 핵심 절 필요`);
    assert.match(safety, /archive 후보나 이를 위한 detach를 판단하기 전에 \[공통 안전 대조\]\([^)]+\)를 읽고 적용한다\. 참조를 읽을 수 없으면 보류한다/, name);
    assert.match(safety, /부모·workspace archive는 closed 후손도 연쇄 보관할 수 있으므로, 후손 전체·인계 체인에 범위 밖·미완료·소유 불명·필요한 알림 중계가 있거나 이를 확인할 수 없으면 보류/, name);
    assert.match(safety, /detach는 기존 권한 안에서만 하며 `--force`·MCP 우회는 금지한다/, name);
    assertArchiveLoop(safety, name);
    assert.match(safety, /부모 archive로 후손을 한꺼번에 정리하지 않는다/, name);
    assert.match(safety, /감독 자체의 detach 동의는 그 감독 자신이나 사용자에게 받으며, 부모의 동의로 대신하지 않는다/, name);
  }
  const supervisor = readFileSync(new URL('../agents/skills/yw-supervisor/SKILL.md', import.meta.url), 'utf8');
  assert.match(supervisor, /라벨·heartbeat\/schedule·archive 상태를 바꾼 뒤에는 대상 ID의 실제 상태를 다시 읽고 확인 결과를 기록한다\. 성공 반환만으로 적용됐다고 쓰지 않는다/);
  const cleanup = readFileSync(new URL('../agents/skills/yw-paseo-cleanup/SKILL.md', import.meta.url), 'utf8');
  const execution = cleanup.split('\n## 실행 순서와 직전 재확인\n')[1]?.split('\n## ')[0];
  assert.ok(execution, 'cleanup: 실행 절 필요');
  assert.match(execution, /에이전트:\*\* \[archive 재개 루프\]\(#자원별-정리-조건\) 1~5단계를 반복/);
  assert.match(execution, /workspace:\*\* 구성원 단계가 모두 적용 확인된 workspace만 위 재개 루프 6~7단계/);
  assert.match(execution, /그 항목과 그 항목에 의존하는 부모·workspace만[^\n]*보류한다\. 대상을 조용히 늘리지 않는다/);
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
    const assertInstalledReference = () => {
      const expected = readFileSync(new URL('../agents/skills/yw-supervisor/references/archive-safety.md', import.meta.url), 'utf8');
      for (const installed of [codex, claude]) {
        const skill = readFileSync(join(installed, 'SKILL.md'), 'utf8');
        const href = [...skill.matchAll(/\]\(([^)]+)\)/g)].map(([, target]) => target)
          .find(target => target.endsWith('/archive-safety.md'));
        assert.ok(href, `${installed}: 참조 링크 필요`);
        assert.equal(readFileSync(resolve(installed, href), 'utf8'), expected, `${installed}: 설치 경로에서 참조 내용 읽기`);
        assertDocumentLinks(join(installed, 'SKILL.md'), dirname(installed));
      }
    };
    try {
      assert.equal(run('--dry-run').status, 0);
      assert.equal(run('--check').status, 1);
      assert.equal(existsSync(join(dir, '.agents')), false);
      assert.equal(existsSync(join(dir, '.claude')), false);
      const result = run();
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readlinkSync(codex), source);
      assert.equal(readlinkSync(claude), source);
      assertInstalledReference();
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
      assertInstalledReference();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
