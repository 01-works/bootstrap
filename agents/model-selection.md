# 모델 선택 근거

[Paseo 프로필](paseo.md#프로필)의 역할별 모델을 고른 근거다. 2026-11-23에 조사했다. 프로필 설정의 원장은 `paseo-profiles.json`이고, 이 문서는 근거와 다시 볼 조건만 적는다.

외부 수치는 대부분 모델 회사나 코드 리뷰 제품 회사가 직접 낸 것이고, 측정 환경이 서로 달라 사이트끼리 바로 비교할 수 없다. 그래서 여러 출처에서 같은 방향으로 나온 결론만 근거로 쓴다.

## 역할별 근거

| 프로필 | 모델 | 근거 | 약점과 대응 |
|---|---|---|---|
| Supervisor·Builder·Architect·Deep Reviewer | Claude Opus 5.5 | Terminal-Bench 4.0 66.4%(Anthropic 발표, Artificial Analysis 재측정 59.6%)로 에이전트 코딩 최상위권. 100만 토큰당 $4/$20 | Opus 결과에 다른 계열 검토가 필요하면 Reviewer(Sol)가 맡는다 |
| Frontend Builder | Claude Opus 5.5 | WebDev Arena 디자인 부문 1위(2026-11-11 기준 1850점, Fable 5.2 1841점) | Arena는 사용자 투표라 실제 화면 품질은 브라우저 검증으로 확인한다 |
| Reviewer | GPT-6.2 Sol | CodeRabbit 시험에서 알려진 문제 81개 중 60개(74.1%)를 찾았다. 코딩 점수가 Astra와 비슷한데 가격은 1/4($2/$10) | 같은 시험의 high 추론 실행에서 지적 수(187→290)와 비용이 함께 늘었지만, 파이프라인의 다른 모델도 바뀌어 추론 수준만의 효과로 볼 수 없다 |
| Policy Reviewer (Fable) | Claude Fable 5.2 | 에이전트 코딩(FrontierCode 2.0 49.1%)과 종합 지능 지표에서 Astra보다 앞선다 | 같은 토큰 단가($8/$40)에서도 추론이 길어 작업당 비용이 Astra의 약 6배($26.5 대 $4.0). 정책 변경 검토에만 쓴다 |
| Policy Reviewer (Astra) | GPT-6.2 Astra | 과학·전문 업무 과제에서 Fable보다 앞서고 작업당 비용이 낮다 | 정책 변경 검토에만 쓴다 |
| Scan Reviewer | DeepSeek V4.1 Flash | 코드 리뷰 벤치마크 두 곳에서 모두 "싸고 재현율이 높다". Macroscope 재현율 77.5~83.1%(설정별, 83.1%는 max)로 비교 모델 중 최고권, Kodus에서 버그 하나 찾는 비용 $0.082로 GLM-5.3 Flash($0.069) 다음으로 낮다(Kimi $0.45, Opus $0.42). OpenRouter의 1017 표시가는 100만 토큰당 약 $0.04/$0.50(경로별 변동) | 정밀도가 낮아(Macroscope 63.5~65.0%, Kodus 43.4%) 결과는 후보로만 쓴다. 두 시험 모두 PR diff 리뷰라 저장소 범위 스캔 성능은 따로 재지 않았다. 이전 V4 Flash(0731)에서 긴 세션 중 도구 호출 직전 문장이 반복되는 보고가 있었고, 1017에서 재현된 근거는 없다 |
| Bug Hunter | Kimi K3.1 Pro | Kodus에서 버그 121개 중 83개(68.6%)로 가장 많이 찾았다 | 정밀도 49.1%로 오탐이 많고 PR당 $1.24로 Scan보다 훨씬 비싸다. 놓치면 안 되는 변경에만 쓴다 |
| Gemini Cross-check | Gemini 4 Neon | Claude·GPT와 다른 계열. 외부 리뷰 시험에서 지적 359개 중 88%가 수정으로 이어졌고, 모르는 질문에 추측하는 비율이 약 14%로 낮다(Sol은 55~60%) | 리뷰가 느리다(중앙값 11.4분, Sol 5.8분). 이 저장소 운영에서 심각도를 높게 잡고 기존 결정을 새 발견처럼 내는 경향이 있어 Sol로 반박 검증한다 |

## 쓰지 않는 모델

- **Gemini 4 Argon**: 2026-11-21~23에 Scan Reviewer로 썼다. 같은 파일 비교에서 결함 후보 5개로 DeepSeek(6개)과 비슷했지만 코드 리뷰 벤치마크 근거가 없다. 주간 한도라 여러 세션을 동시에 돌리면 한도에 먼저 걸릴 수 있다(실측 기록은 없다). Antigravity는 full-access만 있어 OpenCode plan보다 덜 안전하다. 긴 문맥 추론(GraphWalks 84.2%, Opus 5.5 66.8%)이 강해 저장소 전체를 한 세션에 넣어 구조를 파악하는 데는 맞을 수 있지만, 실제로 쓸 일이 생기기 전에는 프로필을 두지 않는다.

## 다시 볼 조건

- Scan Reviewer의 OpenRouter 비용이 눈에 띄게 늘거나 긴 세션 실패가 잦으면 Argon 등 구독 쿼터 모델을 다시 비교한다.

## 출처

- 코드 리뷰: [Kodus 코드 리뷰 LLM 벤치마크](https://kodus.io/en/best-llms-for-code-review/), [Kodus 오픈소스 LLM](https://kodus.io/en/open-source-llms-for-code-review/), [Macroscope 벤치마크](https://macroscope.com/content/ai-code-review-benchmark-best-models), [CodeRabbit GPT-6.2 리뷰](https://www.coderabbit.ai/blog/gpt-6-2-sol-and-astra-review), [Gemini 4 Neon 리뷰 시험](https://www.huuhka.net/testing-gemini-4-neon-as-a-code-reviewer/)
- 모델별: [DeepSeek V4.1 Flash 1017 (OpenRouter)](https://openrouter.ai/deepseek/deepseek-v4.1-flash-1017), [DeepSeek V4 도구 호출 반복 보고](https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731/discussions/58), [Gemini 4 Argon vs Opus 5.5](https://www.datacamp.com/blog/gemini-4-argon-vs-claude-opus-5-5), [Claude Opus 5.5](https://www.digitalapplied.com/blog/claude-opus-5-5-launch-pricing-benchmarks-2026), [GPT-6.2 Sol·Astra](https://www.datacamp.com/blog/gpt-6-2-astra-and-sol), [Astra vs Fable 5.2 (DataCamp)](https://www.datacamp.com/blog/gpt-6-2-astra-vs-claude-fable-5-2), [Astra vs Fable 5.2 비용](https://kingy.ai/blog/gpt-6-2-astra-vs-claude-fable-5-2/), [Kimi K3.1 Pro (OpenRouter)](https://openrouter.ai/moonshotai/kimi-k3.1-pro), [Gemini 4 Neon 리뷰](https://www.eesel.ai/blog/gemini-4-neon-review)
- 프론트엔드: [WebDev Arena 디자인 부문](https://arena.ai/leaderboard/code/webdev/reference-based-design)
