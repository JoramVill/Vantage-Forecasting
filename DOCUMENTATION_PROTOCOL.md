# DOCUMENTATION_PROTOCOL.md

**Standard:** iEnergy Documentation Protocol v1.0
**Applies to:** All iEnergy projects (embedded per-project)
**Purpose:** Prevent stale documentation from corrupting AI agent decisions and human understanding.

---

## 1. The Core Rule

**Documentation is not a deliverable. It is part of the code change.**

Every code change includes its documentation update in the same session. Not after. Not later. Not in a separate task. If the code changed and the docs didn't, the work is incomplete.

This is non-negotiable. An agent that changes code without updating affected documentation has failed the task, regardless of whether the code itself works.

---

## 2. Document Classification

Every document in the project falls into exactly one of these categories. The category determines its update rules, staleness threshold, and lifecycle.

### Category A: Living Documents (update with every relevant code change)

These documents describe the CURRENT state of the system. They must always reflect reality.

| Document | Purpose | Update Trigger |
|----------|---------|---------------|
| `CLAUDE.md` | Agent instructions, architecture rules, project structure | Any structural change, new commands, new subsystems, changed patterns |
| `context.md` | Current session task and status | Every session start and throughout |
| `README.md` | User-facing setup and usage guide | Any change to install steps, commands, configuration, or requirements |
| `CHANGELOG.md` | Version history | Every code change |

**Staleness rule:** If the code referenced by a Living Document has changed since the document's `Last-Updated` header, the document is STALE and must be updated before any other work proceeds.

### Category B: Decision Records (append-only, never edit past entries)

These documents capture WHY decisions were made. They accumulate over time and are never modified retroactively.

| Document | Purpose | Update Trigger |
|----------|---------|---------------|
| `DECISIONS.md` | Architectural decisions, bug discoveries, corrections, project direction | When a decision is made, a bug is found, or the AI is corrected |

**Staleness rule:** Decision records cannot go stale — they are historical. But they MUST have dates and context. An undated decision entry is invalid.

### Category C: Reference Documents (verify on use, update on drift)

These documents describe specific subsystems, APIs, or interfaces in detail. They are not updated on every change — only when their specific subject matter changes.

| Document | Purpose | Update Trigger |
|----------|---------|---------------|
| `ARCHITECTURE.md` | Full system architecture | When architecture changes (new components, changed data flow, removed subsystems) |
| `API_REFERENCE.md` | Endpoint documentation | When endpoints are added, removed, or changed |
| `AGENTS.md` | Cross-project coordination | When projects, agents, or protocols change |
| Any `reference/*.md` | Subsystem deep-dives | When that specific subsystem changes |

**Staleness rule:** Reference Documents carry a `Last-Verified` date AND a `Verified-Against` field (the git commit or version they were checked against). If the current version is ahead of `Verified-Against`, the document is POTENTIALLY STALE and must be spot-checked before relying on it.

### Category D: Plans and Proposals (expire and archive)

These documents describe FUTURE work that may or may not happen. They are the most dangerous source of staleness because agents read them as current intent.

| Document | Purpose | Update Trigger |
|----------|---------|---------------|
| `*_PLAN.md` | Implementation plans | When work begins (status → In Progress), when work completes (status → Done → Archive) |
| `*_PROPOSAL.md` | Design proposals | When accepted (→ becomes reference doc or plan) or rejected (→ Archive) |
| `*_SPEC.md` | Specifications for upcoming work | When implemented (→ Archive) or abandoned (→ Archive) |

**Staleness rule:** Plans have a mandatory `Status` header: `Draft`, `Approved`, `In Progress`, `Done`, `Abandoned`. Any plan with status `Done` or `Abandoned` MUST be moved to the `archive/` directory within the same session that completes or abandons it. Plans in `Draft` or `Approved` status that have not been touched for 30+ days should be flagged for review.

**CRITICAL: The `archive/` directory exists specifically for completed and abandoned plans. Agents MUST NOT read `archive/` for current project understanding. It exists only for historical reference if explicitly requested.**

---

## 3. Document Headers (Mandatory)

Every document (except `CHANGELOG.md` and `context.md`) must begin with a metadata header. The format depends on the category.

### Living Documents (Category A)
```markdown
---
Status: Active
Last-Updated: 2026-03-22
Updated-By: [agent or person name]
---
```

### Decision Records (Category B)
```markdown
---
Status: Active
Created: 2026-03-22
Type: Decision Record (append-only)
---
```

### Reference Documents (Category C)
```markdown
---
Status: Active
Last-Verified: 2026-03-22
Verified-Against: v2.9.0 (or commit hash)
Updated-By: [agent or person name]
---
```

### Plans and Proposals (Category D)
```markdown
---
Status: Draft | Approved | In Progress | Done | Abandoned
Created: 2026-03-22
Last-Updated: 2026-03-22
Updated-By: [agent or person name]
---
```

---

## 4. The Documentation Index

Every project maintains a **Documentation Index** in `CLAUDE.md`. This is the single authoritative list of all documents in the project, their category, and their status.

```markdown
## Documentation Index

| Document | Category | Status | Last Updated | Purpose |
|----------|----------|--------|-------------|---------|
| `CLAUDE.md` | A - Living | Active | 2026-03-22 | Agent instructions and project structure |
| `context.md` | A - Living | Active | 2026-03-22 | Current session task and status |
| `README.md` | A - Living | Active | 2026-03-18 | User-facing documentation |
| `CHANGELOG.md` | A - Living | Active | 2026-03-22 | Version history |
| `DECISIONS.md` | B - Decision | Active | 2026-03-22 | Architectural decisions and corrections |
| `AGENTS.md` | C - Reference | Active | 2026-03-20 | Cross-project coordination |
| `ARCHITECTURE.md` | C - Reference | Active | 2026-03-22 | Full system architecture |
| `archive/PHASE1_PLAN.md` | D - Plan | Done | 2026-03-15 | Phase 1 implementation (completed) |
```

**Rules for the index:**
- Every `.md` file in the project MUST appear in this index
- The `Last Updated` column must match the document's header
- Documents in `archive/` are listed with their final status
- If a document exists but is NOT in the index, it is an orphan and must be indexed or deleted
- The index itself is updated whenever any document is added, removed, or changes status

---

## 5. Session Protocol (How Agents Use This)

### Session Start (MANDATORY — before any work)

```
Step 1: Read CLAUDE.md
        → Establishes project rules and architecture understanding

Step 2: Read context.md
        → Establishes what's currently in progress, what was last done

Step 3: Read DECISIONS.md (latest 10 entries minimum)
        → Establishes recent decisions, known bugs, corrections to avoid repeating

Step 4: Staleness Check
        → Scan Documentation Index in CLAUDE.md
        → For each Category A (Living) document: compare Last-Updated to recent git history
        → For each Category D (Plan) document NOT in archive/: check if Status is Done or Abandoned
        → If ANY staleness detected: HARD BLOCK — update stale documents before proceeding

Step 5: Read task-relevant reference documents (Category C)
        → Based on the task, read relevant ARCHITECTURE.md sections, API docs, etc.
        → Check Verified-Against header — if behind current version, spot-check before relying on it

Step 6: Begin work
```

### During Work (MANDATORY — as part of every code change)

```
For every code change:
  1. Make the code change
  2. Immediately ask: "Which documents does this affect?"
  3. Update ALL affected documents NOW — not later
  4. Update CHANGELOG.md with the change
  5. Update context.md with progress

The code change and its documentation update are ONE unit of work.
They are committed together. They are completed together.
```

### Session End (MANDATORY — before closing)

```
Step 1: Update context.md with:
        → What was completed this session
        → What is still in progress
        → What blockers exist
        → What the next session should start with

Step 2: Check for any plans that were completed:
        → Move completed plans to archive/
        → Update their Status header to Done
        → Update Documentation Index in CLAUDE.md

Step 3: Review DECISIONS.md:
        → Add any decisions made this session
        → Add any bugs discovered
        → Add any corrections made (especially if the AI was wrong about something)

Step 4: Verify Documentation Index is current:
        → All documents listed
        → All Last Updated dates accurate
        → No orphan documents
```

---

## 6. Staleness Detection Rules

### Hard Block Triggers (agent MUST stop and fix before proceeding)

1. **Category A document** has a `Last-Updated` date older than the most recent code change affecting its subject matter
2. **Category D plan** with status `Done` or `Abandoned` is NOT in `archive/` directory
3. **Category D plan** with status `Draft` or `Approved` references code or features that already exist (plan is outdated — work was done without updating the plan)
4. **A document exists in the project** that is NOT listed in the Documentation Index
5. **A document is listed in the Documentation Index** but does not exist on disk
6. **`context.md`** references a task as "In Progress" that was completed in a previous session (detected via CHANGELOG.md or git history)

### Soft Warning Triggers (agent flags but may proceed with caution)

1. **Category C reference document** has `Verified-Against` more than 2 minor versions behind current
2. **Category D plan** in `Draft` or `Approved` status has not been updated in 30+ days
3. **DECISIONS.md** has no entries in the last 30 days (suggests decisions are being made but not recorded)

### Resolution Actions

| Trigger | Required Action |
|---------|----------------|
| Stale Living Document | Read the document, compare to current code, update content and Last-Updated header |
| Completed plan not archived | Move to `archive/`, update Status header, update Documentation Index |
| Orphan document | Add to Documentation Index with correct category, or delete if no longer relevant |
| Missing document | Remove from Documentation Index, or recreate if needed |
| Stale context.md | Clear completed tasks, update with current state |
| Old plan describing current features | Update Status to Done, move to `archive/`, verify no contradictions with Living Documents |

---

## 7. Directory Structure Standard

Every project following this protocol uses this documentation layout:

```
project-root/
├── CLAUDE.md                   # Category A — Agent instructions (includes Documentation Index)
├── context.md                  # Category A — Current session state
├── DECISIONS.md                # Category B — Decision record (append-only)
├── AGENTS.md                   # Category C — Cross-project coordination
├── CHANGELOG.md                # Category A — Version history
├── README.md                   # Category A — User-facing documentation
├── ARCHITECTURE.md             # Category C — System architecture reference
│
├── reference/                  # Category C — Subsystem deep-dives
│   ├── api-reference.md
│   ├── database-schema.md
│   └── ...
│
└── archive/                    # Category D (completed) — Historical plans and proposals
    ├── PHASE1_PLAN.md          # Status: Done
    ├── OLD_PROPOSAL.md         # Status: Abandoned
    └── ...
```

**Rules:**
- Active plans (Category D, status Draft/Approved/In Progress) live in project root or a `plans/` directory
- Completed or abandoned plans ALWAYS move to `archive/`
- `archive/` is for reading only when explicitly asked — agents do not proactively read `archive/`
- `reference/` is for detailed docs that support `ARCHITECTURE.md` — agents read these based on task relevance

---

## 8. Human Engineer Compatibility

This protocol is designed to work for both AI agents and human developers. The standards are compatible with:

- **Keep a Changelog** format for CHANGELOG.md
- **Architecture Decision Records (ADR)** pattern for DECISIONS.md
- **Semantic Versioning** for version references
- **Conventional file naming** that any developer would recognize

A human engineer joining the project can:
1. Read `README.md` for setup and usage
2. Read `ARCHITECTURE.md` for system understanding
3. Read `DECISIONS.md` for historical context and rationale
4. Read `CHANGELOG.md` for recent changes
5. Ignore `CLAUDE.md`, `context.md`, and `AGENTS.md` (these are agent-specific but not harmful to read)

The Documentation Index in `CLAUDE.md` serves as a sitemap for both humans and agents.

---

## 9. Anti-Patterns (Things That Cause Staleness)

### DO NOT

- **Write documentation "later."** If the code changed, the docs change now. There is no later.
- **Leave completed plans in the root directory.** They WILL be read as current intent. Archive them.
- **Create documentation files without adding them to the Documentation Index.** Orphan docs become invisible or misleading.
- **Update code in one session and docs in another.** Context is lost between sessions. The update will be incomplete or wrong.
- **Copy-paste old documentation to create new docs without updating content.** This creates internally inconsistent documentation where some sections reflect old state.
- **Delete DECISIONS.md entries.** They are historical records. Even if a decision was reversed, the original entry stays and a new entry records the reversal.
- **Reference specific line numbers in documentation.** Line numbers change constantly. Reference functions, classes, files, or sections instead.
- **Write aspirational documentation.** Docs describe what IS, not what WILL BE. Future plans go in Category D documents with explicit Plan/Proposal status.
- **Let the Documentation Index get out of sync.** If you're unsure, do a full reconciliation: list all .md files on disk, compare to the index, fix discrepancies.

### DO

- **Treat documentation updates as part of the same commit as code changes.**
- **Archive plans the moment they're completed or abandoned.**
- **Date everything.** Every header, every decision entry, every verification.
- **Record why, not just what.** DECISIONS.md captures reasoning, not just outcomes.
- **Keep context.md ruthlessly current.** Clear completed items. Update blockers. This is the short-term memory of the project.
- **Verify before trusting.** When a Reference Document seems relevant, check its Verified-Against version before relying on it.
- **Flag staleness immediately.** If you detect stale documentation during a session, fixing it takes priority over the original task. Stale docs will cause more damage than a delayed feature.

---

## 10. Protocol Adoption Checklist

When adding this protocol to an existing project:

1. [ ] Copy `DOCUMENTATION_PROTOCOL.md` to project root
2. [ ] Add metadata headers to all existing `.md` files
3. [ ] Create `DECISIONS.md` if it doesn't exist (seed with known past decisions)
4. [ ] Create `context.md` if it doesn't exist
5. [ ] Create `AGENTS.md` if cross-project coordination is needed
6. [ ] Create `archive/` directory
7. [ ] Move any completed/abandoned plans to `archive/`
8. [ ] Build Documentation Index in `CLAUDE.md`
9. [ ] Reconcile: ensure every `.md` file on disk appears in the index
10. [ ] Verify all Living Documents (Category A) are current
11. [ ] Add Session Protocol to `CLAUDE.md` (session start, during work, session end steps)
12. [ ] First session under new protocol: run full staleness check

---

## 11. Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-03-22 | Initial protocol |

---

*This protocol is embedded in each project, not maintained centrally. Each project's copy may diverge slightly to accommodate project-specific needs, but the core rules (document classification, mandatory headers, session protocol, staleness detection, and the anti-patterns) are universal.*
