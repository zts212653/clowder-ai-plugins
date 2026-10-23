# One issue category with explicit boundaries

Accepted source: `thread_mucwsgsjtlbabfcq#0001792653729551-000064-2ee79a8f`.
Continue the existing workbench and PR80. The operator wants unambiguous tagging:
the two free-text fields for module and local tags currently overlap and do not
tell humans or cats how to decide.

## User journey

Open an issue, see its origin/system and current suggested category, select one
category if needed, read its inclusion/exclusion/example, and explicitly save.
The saved category drives the queue, overview and detail after reload. Opening
or selecting alone does not persist. A source Feature binding remains the primary
route. Existing notes, custom tags and repair history survive unchanged.

The plugin's `src/classification/taxonomy.ts` is the vocabulary and boundary
source used by the selector and new cat task instructions. Categories retain
the established names/IDs. Classify by the explicitly affected/requested capability,
not a keyword, guessed root cause, UI location, provider or implementation carrier.
Multiple equally primary subjects, unrecognized names and insufficient evidence
remain undecided. Old datasets are suggestions with their original provenance;
this change does not silently rewrite them or claim their accuracy improved.

Examples: a failing developer test command belongs to code/delivery; a product
installer failure belongs to installation/build. An upgrade followed by failed
conversation belongs to Agent runtime when that is the stated main issue. ACP
dropping an Agent image input is runtime; an MCP tool call failure is tools.
Configuration of memory compression is a memory feature; the word configuration
does not make it configuration sync. A report with multiple independent problems
needs its main concern clarified.

`module` remains the backwards-compatible stored category slot. `tags` is retained
as historical data and is no longer automatically populated or a competing editor.
Saved values are called saved classifications, not retrospectively declared human
decisions. Unknown legacy names remain visible for deliberate replacement. No data
migration, storage schema, dependency or production Host change is introduced.

Local saved categories govern local grouping. Existing team recommendation and
automatic assignment retain their persisted analysis/rules authority; a differing
team analysis is explicitly shown rather than misrepresented as already updated.
The new cat prompt supplies the same boundary table, without changing provider
write authority or the public analysis contract. Real model classification quality
and production Host installation remain separate unfinished acceptance work.

Validation: category partition/Feature precedence/multi-subject abstention;
component save and historical preservation; packed save/reload/grouping/revocation,
column resizing and mobile journeys; retained real READ preview and two-member
sandbox; original Core export reproducibility and repository-required full gate.
