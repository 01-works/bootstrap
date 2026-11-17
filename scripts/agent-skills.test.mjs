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

test('chief 순찰·재개: 공통 결정 계약·새 권한 금지·만료 안전 불변식', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  const chief = read('../agents/skills/yw-chief-supervisor/SKILL.md');
  const cleanup = read('../agents/skills/yw-paseo-cleanup/SKILL.md');
  const patrol = chief.split('\n## 순찰과 재개\n')[1]?.split('\n## ')[0] ?? '';
  const bullet = (text, name) => text.split(`- **${name}:** `)[1]?.split('\n- ')[0] ?? '';
  assert.match(bullet(patrol, '순찰'), /^사용자가 요청하면[^\n]*`maxRuns` 또는 `expiresIn`[^\n]*자동으로 연장하지 않는다/);
  const progress = bullet(patrol, '감독 lane 진행 요청');
  for (const required of [/보관되지 않았고/, /보류·중지 지시·사용자 질문·pending·기록된 대기 사유 없이/, /전송 직전 상태를 확인/, /기존 승인 범위 안의 것만/, /한 번 보낸다/, /새 권한·범위를 담지 않고/]) assert.match(progress, required);
  assert.doesNotMatch(progress, /archive|detach|인수|merge|병합|머지|배포|--force|삭제|중단|승인 없이/);
  const independent = bullet(patrol, '독립 대화');
  for (const required of [/계약 7번의 기존 또는 새 결정 범위만/, /새 권한·범위 없음/, /한 번 재개/, /소유 인수·작업자 배정·중단은 하지 않는다/, /감사 편입도 계약 7번으로/, /하위 세션에는 메시지를 보내지 않고/]) assert.match(independent, required);
  assert.match(bullet(patrol, '결정 큐'), /"추천대로"는 보여 준 항목에만[^\n]*실행 직전 상태를 다시 확인/);
  assert.match(chief, /안전 조건으로 지정된 도구[^\n]*보류하고 보고하며, 보호 수준이 낮은 경로로 바꾸지 않는다/);
  assert.match(chief, /진행 중인 작업자를 직접 재개·중단하거나 lane을 인수하지 않는다/);
  assert.match(chief, /사용자 승인이 필요한 조치는 합의만으로 실행하지 않는다/);
  assert.match(chief, /관리 중인 에이전트는 전체 ID로 적는다/);
  assert.match(cleanup, /`-chief\/tasks\.md`\(현재 관리 범위\)와 `-chief\/log\.md`\(완료 판정 근거\)/);
  assert.match(cleanup.split('\n## 하지 않는 것\n')[1] ?? '', /다른 세션에 질문이나 재개 요청을 보내지 않는다/);
});

test('감독 계약: 닫힌 사용자 결정 목록의 안전 대상을 보존한다', () => {
  const supervisor = readFileSync(new URL('../agents/skills/yw-supervisor/SKILL.md', import.meta.url), 'utf8');
  const contract = supervisor.split('\n## 에스컬레이션 계약\n')[1]?.split('\n## ')[0] ?? '';
  const decisions = [...contract.matchAll(/^(\d+)\. (.+)$/gm)];
  assert.deepEqual(decisions.map(([, id]) => id), ['1', '2', '3', '4', '5', '6', '7']);
  const requiredByDecision = [
    ['새 목표', '목표 항목 밖 확장', '범위 축소·연기', '우선순위 충돌',
      '알려진 중요 미해결의 수용', '미수정 회귀', '보안·데이터 손실·실 사용자 영향 결함',
      '리뷰 P0/P1(또는 동급) 지적', '브리프의 필수 검증 미충족'],
    ['기본·보호·공유 브랜치 병합', '배포·릴리스', 'force-push', '외부 전송·공개 코멘트',
      '미커밋 작업·stash·원격 브랜치 삭제', 'push 안 된 브랜치·worktree 삭제', 'PR·이슈 닫기',
      '실 DB 변경', '자격·권한 변경', '다른 소유자의 프로세스 종료', '비용 발생 외부 자원',
      '기기 전역 설정 변경', '예시', '되돌리는 법을 구체 명령으로 적을 수 없으면 2번'],
    ['정체 claim 인수', '풀리지 않은 소유 충돌', '소유 세션 동의를 얻지 못한 종료·정리·detach',
      '다른 lane detach의 총괄 직접 실행', '사용자 대화 중인 감독의 누적 목표 완료 전의 교체·중단·archive'],
    ['고정 핵심 안전 규칙·스킬 정책의 삭제·완화', '저장소 소유자 결정',
      '작업자 권한 모드 상향', '분류기 거부 우회'],
    ['교차 모델 미합의', '선호·권한·정책 쟁점', '증거 부족'],
    ['동시성·모델 등급·운영 상한 상향', '모든 계정 소진 시 대체'],
    ['독립 대화의 재개·감사 편입'],
  ];
  for (const [index, required] of requiredByDecision.entries()) {
    for (const target of required) {
      assert.ok(decisions[index][2].includes(target), `계약 ${index + 1}번 안전 대상 누락: ${target}`);
    }
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
