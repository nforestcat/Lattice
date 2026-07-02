# CONTEXT.md — Lattice 도메인 용어

코드/리뷰/리팩터 판단 시 기준이 되는 핵심 용어. 상세 구현은 각 파일 참조.

## Vault
로컬 Markdown 노트 폴더. 유일한 durable source of truth.
Lattice 런타임 파일은 vault 안 `.lattice/`(config.json, embeddings.json, runs/)에 격리되며 노트 스캔에서 제외된다. 인덱스·그래프·번들·건강 리포트는 전부 vault + 캐시에서 재생성 가능해야 한다.
→ `src/core/indexer.ts`, `src/api/tauriVault.ts`

## Note
vault 안의 Markdown 파일 하나. frontmatter, tags, wiki links(`[[...]]`), backlinks를 파싱해 `ParsedNote`로 다룬다. 노트 본문은 사용자 소유 — 자동화가 사용자 prose를 임의로 고치지 않는다(리뷰를 거친다).
→ `src/core/types.ts`, `src/core/markdown.ts`

## Ingest
외부 원문(URL, PDF, 붙여넣은 텍스트, LLM 대화)을 vault에 넣을 수 있는 초안으로 변환하는 과정. 결과는 바로 노트가 되지 않고 review queue의 draft로 들어간다. 중복 검사(exact/similar) 포함.
→ `src/core/ingest.ts`, `src/api/ingestReviewTypes.ts` (`IngestRaw` → `IngestResult`)

## Review Queue
vault를 바꾸는 모든 자동/AI 제안이 통과하는 관문. 캡처, ingest 초안, proposed edit, 유지보수 제안(dead link, orphan, stale, duplicate 등)이 `ReviewItemKind`로 큐에 쌓이고, 사용자가 승인해야 vault에 적용된다. **"리뷰 없이 vault에 쓰지 않는다"가 이 제품의 핵심 불변식.**
→ `src/ui/reviewWorkflow/`, `src/ui/hooks/useReviewQueue.ts`

## Context Bundle
LLM 프롬프트에 넣을 관련 노트 모음. focus 노트 기준으로 outgoing link, backlink, 추천(시맨틱 유사도 등) 후보를 점수화해 토큰 예산 안에서 선별하고, 하나의 Markdown으로 조립한다. 어떤 노트가 왜 포함됐는지(reason) 감사 가능하다.
→ `src/core/contextBundle.ts`, `src/ui/hooks/useContextBundle.ts`

## Provenance
AI가 적용한 편집의 출처 기록. 노트 frontmatter의 `ai_edits:` 아래에 editId·model·promptRunId·시각·confidence를 스탬프한다. editId 기준 멱등이며, 사용자 prose나 다른 frontmatter 키는 건드리지 않는다.
→ `src/core/provenance.ts`, `AiProvenance` in `src/api/ingestReviewTypes.ts`

## 관계 요약

```
외부 소스 ──ingest──▶ review queue ──승인──▶ note (vault)
                                              │
note들 ──선별/점수화──▶ context bundle ──▶ LLM ──▶ proposed edit ──▶ review queue
                                                       (적용 시 provenance 스탬프)
```
