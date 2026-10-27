# Initial issue labels — candidate v0

Status: the initial sample is visible in the packaged workbench; automated generation and taxonomy validation remain open.

## Purpose and delivery boundary

Help the operator find related issues by subject and reported behavior, then revise
and adopt useful labels locally. The operator's 2026-10-14 direction is to keep
updating PR #80; do not merge it. A separate reviewer must review before any merge.
The initial sample now ships under the plugin package and is displayed in the
workbench. This plan describes the method and remaining generation work; it is
not the result dataset. Existing records change only after explicit local save.

## Observed corpus

The authorized, public GitHub catalog for `zts212653/clowder-ai`, checked at
`2026-10-14T11:17:39.122Z`, contains 797 issues: 276 open, 521 closed. There are 49
distinct source labels, and 136 issues have no source label. This is the available
snapshot, not a claim that every historical issue/comment was read.

The source vocabulary mixes dimensions: `bug`/`enhancement` describe request kind,
`windows` describes an environment, `triaged`/`accepted` describe workflow decisions,
and `feature:F…` is an existing project reference. These are context, not automatically
correct training targets. In particular, a model must not invent `accepted`,
`resolved`, severity, ownership or an unverified Feature assignment.

See [the machine-readable sample](../../packages/issue-workbench/data/initial-classification.v0.json).
Its 12 issues were deliberately selected for different subjects, sparse evidence,
multi-problem reports and a feature request. They are not a random evaluation set
and cannot establish corpus coverage or accuracy. Candidate assignments were made
by the current GPT-6-astra assistant from title/body evidence; this turn did not
run embeddings, clustering, fine-tuning or an automated batch classifier.

## Proposed label dimensions

| Dimension | Candidate values illustrated by the sample | Rule |
| --- | --- | --- |
| 模块 / Area | Agent 运行、界面交互、上下文与记忆、猫猫协作、工具与连接器、安装与构建、插件生命周期、配置同步、代码与交付 | Multi-label; a report may cross boundaries. These are subjects, not code-owner assignments. |
| 类型 / Kind | 缺陷、功能需求、咨询、待判断 | Describe the request; do not infer acceptance or implementation status. |
| 现象 / Symptom | 内容缺失、启动或调用失败、状态显示不符、布局溢出、检索异常、配置丢失、构建失败、安装失败、消息接收中断、协作唤醒失败 | Only when the report supplies evidence; a feature request may have none. |
| 环境 / Environment | Windows、桌面端、ACP、OpenCode、Codex | Record what was reported. Reported on Windows does not mean Windows-only. No environment evidence means unknown. |

Readable names are shown in the product; stable IDs live in the seed. Topic
similarity is only a discovery aid. It does not prove that two reports share a
root cause, require the same fix, or can be closed together.

## Current product result

The dataset and provenance live with the plugin:
[data/initial-classification.v0.json](../../packages/issue-workbench/data/initial-classification.v0.json).
The package README explains the **分类结果** entry. Its overview shows the 12
current readable results, four dimensions and supporting excerpts; choosing an
issue opens its candidate card. **加入本地标记草稿** preserves existing tags and
requires a separate **保存本仓记录** action to persist. It never changes remote labels.
Source updates flag the candidate for review. Revoked sources are removed from
both the overview and candidate display. This is not a trained classifier or
structured accept/reject history; the initial JSON remains a proposed baseline.

## Recommended extraction path

Start with an existing language model and this small taxonomy: extract relevant
title/body evidence into multiple label dimensions, return proposed labels or an
explicit abstention, and inspect the result alongside the source. This uses an
existing neural model; there is no demonstrated need to train a new model now.
Existing labels are reference evidence, never copied wholesale as ground truth.

For broader topic discovery, sentence embeddings and clustering can group related
texts; representative documents can then be named with a language model. The
official [Sentence Transformers clustering examples](https://sbert.net/examples/sentence_transformer/applications/clustering/README.html)
and [BERTopic LLM representations](https://maartengr.github.io/BERTopic/getting_started/representation/llm.html)
document those capabilities. They do not demonstrate accuracy on this issue
corpus. Start with direct extraction; add clustering only if comparison shows it
finds useful missing categories or lowers the effort required to review results.

Before judging quality, reserve a separate, human-reviewed set across age, state,
language and label availability, grouping related/duplicate reports so they do not
leak across development and evaluation. Compare with existing tags, simple keyword
rules and the direct model baseline. Report unsupported suggestions, missed useful
labels, abstentions and operator edits, along with time/call cost. Do not invent a
confidence percentage from model self-report, or report this 12-case seed as a pass.

## Remaining generation and review workflow

1. An explicit generation action creates a local suggestion batch for selected,
   authorized issues. Show input scope, progress, failures and the model used.
2. Show candidate chips next to the issue summary; reveal the supporting excerpt
   on demand. Users can rename, remove, accept or reject candidates. Bulk adoption
   operates on a visible reviewed selection, not unseen results.
3. Keep source labels, proposed labels and adopted local labels separate. Preserve
   manual edits/rejections; regeneration must not overwrite them. Store source
   identity/version, taxonomy/model version and revision with the batch. Source
   changes mark suggestions stale. Durable local records have no TTL.
4. Internal issue bodies go only to a Host-approved model destination. Source read
   authorization is not model-egress authorization. Treat issue text as untrusted
   data, validate model output, and never execute instructions embedded in issues.
5. Apply the existing per-source grant and stale-write checks to suggestions too.
   Revoked content and its derived tags must not remain visible through aggregates.
6. Adopting a local label makes no GitHub/internal-platform write. Any future
   platform-label submission remains a separate, reviewed outbound operation.

Current code renders initial candidates separately from the existing local `tags`
string and label-change draft. Explicit copying to a draft and local save work;
structured batch generation, persisted accept/reject decisions and regeneration
that preserves those decisions are still unimplemented.

## Source audit

| Claim | Primary evidence and scope | Verdict / remaining unknown |
| --- | --- | --- |
| This catalog has 797 issues and 49 existing labels | Current authorized preview catalog, public stable repository ID `R_kgDORlB5aQ`; JSON records snapshot hash and counts | Observed for this snapshot only; not a claim about inaccessible or later issues |
| Semantic embeddings can group related text | Sentence Transformers official clustering examples, read 2026-10-14 | Use for capability only; corpus quality/runtime not measured; maintainer-authored docs |
| Representative documents can supply LLM topic names | BERTopic official representation guide, read 2026-10-14 | Use for capability only; project-authored docs, no independent superiority claim |
| This pipeline is better than direct extraction or rules here | No comparison yet | Not established; no model/dependency choice, speed or accuracy claim |

The next useful evidence is operator review of the visible taxonomy and candidate
interaction. Additional model infrastructure is conditional on evidence from that
journey, not a prerequisite for exploring this seed.
