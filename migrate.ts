/**
 * One-time migration from the legacy pi-topic-memory JSON store
 * (`~/.pi/agent/topic-memory.json`) into the OKF topic bundle.
 *
 * Legacy shape (old index.ts): `{version, config, topics: [{id, title, type,
 * tags, derivedFrom, links, status, created, lastUpdated, project, decisions:
 * [{at, text}], outcome, source: {firstSeen, firstSession}}]}`. The legacy
 * `config` block is dropped (the new config has different keys and model
 * semantics).
 *
 * Per topic: title/tags ride the frontmatter; `in_progress`→`draft` and
 * `done`→`stable` (spec's "completed"; `blocked` also degrades to `draft`,
 * `dropped` to `deprecated`); `depends` = mapped slugs of `derivedFrom` +
 * `links` (dangling ids are dropped, never guessed); the Conclusion section
 * carries the `- `-joined decisions plus `Outcome:`; `generated.at` keeps the
 * legacy `lastUpdated` (wall clock would falsify recency scoring).
 *
 * Idempotency: skipped when the bundle already has topics OR the
 * `meta/.migrated` marker exists. On success the marker is written and the
 * old file is renamed to `topic-memory.json.migrated.bak`. Each topic lands
 * as its own saveTopic commit, so the import is per-topic revertible.
 *
 * @module migrate
 */

import { existsSync } from "node:fs"
import { readFile, rename, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import * as okf from "./okf"
import type { BundleStore } from "./store"
import { legacyJsonStorePath, metaDir } from "./paths"

export interface MigrateResult {
	migrated: number
	backup?: string
	/** Per-topic import failures (reason surfaced; the topic stays only in the legacy backup). */
	failures: { title: string; error: string }[]
}

interface LegacyDecision {
	at?: number
	text?: string
}

interface LegacyTopic {
	id?: string
	title?: string
	type?: string
	tags?: unknown
	derivedFrom?: string
	links?: unknown
	status?: string
	created?: number
	lastUpdated?: number
	project?: string
	decisions?: unknown
	outcome?: string
	source?: { firstSeen?: string; firstSession?: string }
}

interface LegacyStore {
	version?: number
	topics?: unknown
}

/** Legacy status → OKF TopicStatus (spec: in_progress→draft, completed→stable). */
function mapStatus(s: unknown): okf.TopicStatus {
	if (s === "done" || s === "completed") return "stable"
	if (s === "dropped") return "deprecated"
	// in_progress / blocked / unknown all start over as draft.
	return "draft"
}

/** Epoch-ms number → ISO string; undefined when absent/invalid. */
function toIso(ms: unknown): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return undefined
	const d = new Date(ms)
	return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

async function atomicWriteFile(file: string, content: string): Promise<void> {
	const tmp = `${file}.tmp-${randomUUID()}`
	await writeFile(tmp, content, "utf8")
	await rename(tmp, file)
}

/**
 * Migrate the legacy JSON store into the bundle. Returns the migrated topic
 * count and — when the old file was successfully renamed — its backup path.
 * Never throws for "nothing to do": a missing/unreadable legacy file yields
 * `{migrated: 0}`.
 */
export async function migrateLegacyJsonStore(store: BundleStore): Promise<MigrateResult> {
	const markerPath = join(metaDir(store.root), ".migrated")
	if (existsSync(markerPath)) return { migrated: 0, failures: [] }
	if ((await store.listTopics()).length > 0) return { migrated: 0, failures: [] }

	const legacyPath = legacyJsonStorePath(store.root)
	let raw: string
	try {
		raw = await readFile(legacyPath, "utf8")
	} catch {
		return { migrated: 0, failures: [] } // no legacy store — nothing to migrate
	}
	let legacy: LegacyStore
	try {
		legacy = JSON.parse(raw) as LegacyStore
	} catch {
		return { migrated: 0, failures: [] } // corrupt legacy file — leave it alone, keep serving the (empty) bundle
	}
	const topics: LegacyTopic[] = Array.isArray(legacy.topics)
		? (legacy.topics as unknown[]).filter((t): t is LegacyTopic => t !== null && typeof t === "object")
		: []
	const usable = topics.filter((t) => typeof t.id === "string" && t.id !== "")

	// Phase 1 — assign each legacy topic a collision-free slug up front, so
	// derivedFrom/links ids can be mapped to final slugs before any write
	// (uniqueSlug alone would collide for same-titled topics: the files are
	// not on disk yet while we enumerate).
	const slugById = new Map<string, string>()
	const taken = new Set<string>()
	const planned: { t: LegacyTopic; slug: string; title: string }[] = []
	for (const t of usable) {
		const id = t.id as string
		const title = typeof t.title === "string" && t.title.trim() !== "" ? t.title : id
		const clean = okf.slugify(title)
		let slug = clean
		if ((await store.exists(slug)) || taken.has(slug)) {
			slug = `${clean}-2`
			for (let i = 3; (await store.exists(slug)) || taken.has(slug); i += 1) {
				slug = `${clean}-${i}`
			}
		}
		taken.add(slug)
		slugById.set(id, slug)
		planned.push({ t, slug, title })
	}

	// Phase 2 — one saveTopic commit per topic (per-topic revertible).
	let migrated = 0
	const failures: { title: string; error: string }[] = []
	for (const { t, slug, title } of planned) {
		try {
			const depends: string[] = []
			const seen = new Set<string>()
			const refs = [t.derivedFrom, ...(Array.isArray(t.links) ? t.links : [])]
			for (const ref of refs) {
				if (typeof ref !== "string" || ref === "") continue
				const target = slugById.get(ref)
				if (target === undefined || target === slug) continue
				const p = okf.slugToPath(target)
				if (!seen.has(p)) {
					seen.add(p)
					depends.push(p)
				}
			}
			const decisions: LegacyDecision[] = Array.isArray(t.decisions)
				? (t.decisions as unknown[]).filter((d): d is LegacyDecision => {
						if (d === null || typeof d !== "object") return false
						const text = (d as LegacyDecision).text
						return typeof text === "string" && text.trim() !== ""
					})
				: []
			let conclusion = decisions.map((d) => `- ${d.text}`).join("\n")
			const outcome = typeof t.outcome === "string" ? t.outcome.trim() : ""
			if (outcome !== "") {
				conclusion = conclusion === "" ? `Outcome: ${outcome}` : `${conclusion}\n\nOutcome: ${outcome}`
			}
			const status = mapStatus(t.status)
			const fm: okf.TopicFrontmatter = {
				type: typeof t.type === "string" && t.type !== "" ? t.type : "topic",
				title,
				tags: Array.isArray(t.tags) ? (t.tags as unknown[]).filter((x): x is string => typeof x === "string") : [],
				depends,
				open_questions: [],
				impact: [],
				status,
				generated: { by: "", at: "" }, // stamped by saveTopic (actor + generatedAt below)
			}
			// Dropped legacy topics map to deprecated, and generated.at is the
			// TTL sweep's clock — keep the original timestamp and a 40-day-old
			// drop would be swept the moment the first session starts. Stamp
			// the migration time instead: full grace period, git still has the
			// original provenance in the legacy backup.
			const generatedAt =
				status === "deprecated"
					? new Date().toISOString()
					: (toIso(t.lastUpdated) ?? toIso(t.created) ?? new Date().toISOString())
			await store.saveTopic(
				{ slug, doc: { fm, body: okf.setSection("", okf.CONCLUSION_HEADING, conclusion) } },
				{ message: `topics(topic): create ${slug}`, created: true, generatedAt },
			)
			migrated += 1
		} catch (err) {
			// A single malformed topic must not abort the import; it stays only
			// in the legacy file (renamed to .bak only on overall success, so a
			// failed run can be retried after a fix). The reason is recorded —
			// a silently partial import with a success marker is
			// undiagnosable (a live dry-run hit an environmental git failure
			// mid-import and undercounted without a trace).
			failures.push({ title: title.slice(0, 80), error: String((err as Error)?.message ?? err).slice(0, 200) })
		}
	}

	// Nothing landed: leave the legacy file in place so a later run can retry.
	if (migrated === 0 && planned.length > 0) return { migrated: 0, failures }

	// Success marker first, then archive the old file (best-effort: a failed
	// rename still reports the migration — the bundle now owns the data).
	await atomicWriteFile(
		markerPath,
		`${JSON.stringify({ migratedAt: new Date().toISOString(), count: migrated, failed: failures.length }, null, 2)}\n`,
	)
	const backupPath = `${legacyPath}.migrated.bak`
	let backup: string | undefined
	try {
		await rename(legacyPath, backupPath)
		backup = backupPath
	} catch {
		// old file missing/unrenamable — migration itself already succeeded
	}
	return { migrated, backup, failures }
}
