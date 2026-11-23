# 모델 선택 근거

[Paseo 프로필](paseo.md#프로필)의 역할별 모델을 고른 근거다. 2026-11-23에 자체 비교와 외부 조사로 정리했다. 프로필 설정의 원장은 `paseo-profiles.json`이고, 이 문서는 근거와 다시 볼 조건만 적는다.

## 자체 비교 (2026-11-23)

실제로 버그를 고친 커밋의 직전 코드를 git 기록 없이 주고, 정해진 파일 범위에서 결함을 찾게 했다. 정답은 그 커밋이 고친 버그다. 뒤 시점 코드에는 앞 케이스의 수정이 들어 있으므로, 모델마다 전용 폴더에 케이스를 시간순으로 하나씩만 풀었다. 모델마다 한 번씩 돌렸고 채점은 Opus가 했다.

| 모델 | bootstrap (셸, 정답 13) | 01-software (TypeScript, 정답 10) | 합계 |
|---|---|---|---|
| Gemini 4 Neon | 6 | 4 | 10/23 |
| GPT-6.2 Sol | 5 | 4 | 9/23 |
| Claude Opus 5.5 | 5 | 2 | 7/23 |
| DeepSeek V4.1 Flash | 2 | 2 | 4/23 |
| Gemini 4 Argon | 5 | 주간 한도 소진으로 못 돌림 | 5/13 |
| Kimi K3.1 Pro | 2 | 제외 | 2/13 |

- Neon과 Sol이 가장 많이 찾았다. Sol은 지적 수가 가장 많고(bootstrap 61개) 거의 모두 확신도 높음으로 매긴다.
- Opus는 지적이 적고 후보를 스스로 결함이 아니라고 걸러 내는 편이었다. 확정 정밀도는 재지 않았다.
- DeepSeek은 가장 싸지만(01-software 5케이스 약 $0.22) 적게 찾았고, bootstrap에서 코드의 `-t 60`을 `-t 0`으로 잘못 읽고 실측했다고 보고했다.
- Argon은 이 계정에서 bootstrap 7케이스 만에 주간 한도가 찼다.
- 로케일 의존 해시 정렬, 깊이가 다른 관계 비교, 소유 정보 변경 금지처럼 도메인 지식이 필요한 버그는 어느 모델도 찾지 못했다. 스캔은 테스트와 리뷰를 대신하지 않는다.
- 한계: 버그 23개, 모델당 한 번 실행이라 한두 개 차이(예: Neon 10, Sol 9)는 우연일 수 있다. 채점자 Opus도 참가 모델이다. DeepSeek·Kimi는 OpenCode, Gemini는 Antigravity에서 돌아 실행 환경 차이를 분리하지 못했다. 외부 코드 리뷰 벤치마크(Kodus·Macroscope)는 DeepSeek·Kimi의 재현율을 높게 봤지만 이 비교에서는 반대였다.

## 역할별 근거

| 프로필 | 모델 | 근거 | 약점과 대응 |
|---|---|---|---|
| Supervisor·Builder·Architect | Claude Opus 5.5 | Terminal-Bench 4.0 66.4%(Anthropic 발표, Artificial Analysis 재측정 59.6%)로 에이전트 코딩 최상위권 | 구현·설계 능력은 자체 비교로 재지 않았다 |
| Frontend Builder | Claude Opus 5.5 | WebDev Arena 디자인 부문 1위(2026-11-11 기준) | Arena는 사용자 투표라 실제 화면은 브라우저로 검증한다 |
| Reviewer | GPT-6.2 Sol | 자체 비교 9/23. Astra와 코딩 점수가 비슷하고 가격은 1/4 | 지적이 많고 확신도를 높게 매기므로 지적마다 근거를 확인한다 |
| Deep Reviewer | Claude Opus 5.5 | 에이전트 코딩 최상위권이고, 자체 비교에서 지적이 적고 근거를 따져 후보를 걸러 냈다 | 확정 정밀도는 재지 않았다. Opus 결과에 다른 계열 검토가 필요하면 Reviewer(Sol)가 맡는다 |
| Policy Reviewer (Fable / Astra) | Claude Fable 5.2 / GPT-6.2 Astra | Fable은 에이전트 코딩, Astra는 과학·전문 업무에서 앞선다 | 작업당 비용이 Fable이 약 6배라 둘 다 정책 변경 검토에만 쓴다 |
| Scan Reviewer | Gemini 4 Neon | 자체 비교 10/23으로 가장 많이 찾음. 구독 쿼터라 추가 비용이 없다 | Gemini Cross-check와 같은 쿼터를 나눠 쓴다. 결과는 후보로만 쓴다 |
| Gemini Cross-check | Gemini 4 Neon | Claude·GPT와 다른 계열로 반례와 빠진 맥락을 찾는다 | 심각도를 높게 잡고 기존 결정을 새 발견처럼 내므로 Sol로 반박 검증한다 |

## 쓰지 않는 모델

- **DeepSeek V4.1 Flash**(이전 Scan Reviewer): 싸지만 자체 비교에서 가장 적게 찾고 코드를 잘못 읽었다.
- **Kimi K3.1 Pro**(이전 Bug Hunter): bootstrap 2/13으로 가장 적게 찾아 역할을 없앴다. 넓게 찾는 역할은 Neon이 맡는다.
- **Gemini 4 Argon**(2026-11-21~23 Scan Reviewer): 찾은 수는 상위권이지만 이 계정에서 7케이스 만에 주간 한도가 차, 여러 세션을 동시에 돌리는 스캔에는 맞지 않다고 봤다.

## 다시 볼 조건

- Scan Reviewer와 Gemini Cross-check를 함께 쓰다가 Gemini 쿼터에 자주 막히면 스캔 모델을 다시 비교한다.

## 출처

- 코드 리뷰: [Kodus](https://kodus.io/en/best-llms-for-code-review/), [Macroscope](https://macroscope.com/content/ai-code-review-benchmark-best-models)
- 모델별: [Claude Opus 5.5](https://www.digitalapplied.com/blog/claude-opus-5-5-launch-pricing-benchmarks-2026), [GPT-6.2 Sol·Astra](https://www.datacamp.com/blog/gpt-6-2-astra-and-sol), [Astra vs Fable 5.2](https://www.datacamp.com/blog/gpt-6-2-astra-vs-claude-fable-5-2), [Astra vs Fable 5.2 비용](https://kingy.ai/blog/gpt-6-2-astra-vs-claude-fable-5-2/), [Gemini 4 Neon 리뷰](https://www.eesel.ai/blog/gemini-4-neon-review)
- 프론트엔드: [WebDev Arena 디자인 부문](https://arena.ai/leaderboard/code/webdev/reference-based-design)
