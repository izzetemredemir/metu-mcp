# Data freshness

University information changes often: dates move, rules are edited, menus change. Every piece of data therefore
carries when it was verified, and every answer says so.

## What is stored

Per record (`records` table):

| Field | Meaning | Source |
|---|---|---|
| `fetched_at` | When we last verified the source (content re-read, changed or not) | collector run |
| `source_updated_at` | The page's own "Son güncelleme / Last updated" stamp | Drupal `time[datetime]` after the label, D7 "Son Güncelleme:" text, RSS `pubDate` |
| `published_at` | Publication date of an announcement | list `time[datetime]` / RSS |
| `first_seen_at` | When we first saw it | insert time |
| `last_changed_at` | When we last observed the content change | `content_hash` differs |
| `content_hash` | SHA-256 of normalized title + text + data | after sanitizing |
| `valid_for` | Period it applies to (`2026-2027`, `2026-10-03`) | collector |
| `lang` | `tr` or `en` | collector |

Per collector unit (`collector_runs`): last run, last success, consecutive failures, last error.
Per catalog link (`link_checks`): last check result (`ok` / `redirect` / `broken`).

## Status rules (`src/store/freshness.ts`)

| Status | When |
|---|---|
| `fresh` | verified within the threshold for its kind |
| `stale` | older than the threshold: announcements 2 h, menus 1 day, calendar/pages 7 days, map 30 days, links 30 days |
| `source_unreachable` | the collector failed ≥ 3 times in a row |
| `no_data` | never fetched |

Anything but `fresh` adds a ⚠️ warning with the official URL ("confirm on the official page").

## What the user sees

Every tool text ends with a line such as:

```
— Kaynak: oidb.metu.edu.tr · son kontrol 2026-09-30 14:05 (İstanbul saati) · sayfanın güncellenme tarihi 2026-09-23 · geçerlilik: 2026-2027
— Source: oidb.metu.edu.tr · last checked 2026-09-30 14:05 (Istanbul time) · page last updated 2026-09-23 · valid for: 2026-2027
```

and `structuredContent.freshness[]` carries the same fields.

## Change tracking

When `content_hash` changes, the previous version is stored in `record_versions` with a bilingual summary:

- calendar: per-event diff — `Date changed: "Add - Drop": 05 - 09 OCTOBER 2026 → 06 - 10 OCTOBER 2026`, added, removed;
- pages: new/changed lines;
- announcements: new items (not during a source's first load).

`metu_recent_changes` exposes this ("anything new this week?"). The parking tool also checks whether the official
rules page changed after `data/parking_rules.yaml` was last verified and warns if so.
