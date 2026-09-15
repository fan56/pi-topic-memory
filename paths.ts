/**
 * Path resolution for the local bundle (dsh ADR 0008 layout): the Cache lives
 * at `~/.pi/agent/topics/` (override with $PI_TOPICS_HOME for tests), laid out
 * as an OKF bundle:
 *
 *   <root>/topics/<slug>.md      concept documents
 *   <root>/index.md              auto-generated bundle index
 *   <root>/meta/observations.jsonl   undistilled observations (M2)
 *   <root>/meta/injections.jsonl     injection log (dsh ADR 0007)
 *   <root>/meta/conflicts.json       rebase-conflicted topics (dsh ADR 0003)
 *   <root>/meta/config.json      plugin configuration
 *
 * No legacy-rename dance: pi-topic-memory has no pre-rename data location.
 *
 * @module paths
 */

import { homedir, hostname as osHostname } from "node:os"
import { dirname, join } from "node:path"

export function resolveBundleRoot(): string {
	const env = process.env.PI_TOPICS_HOME?.trim()
	if (env !== undefined && env !== "") return env
	return join(homedir(), ".pi", "agent", "topics")
}

export function topicsDir(root: string): string {
	return join(root, "topics")
}

export function metaDir(root: string): string {
	return join(root, "meta")
}

export function topicFile(root: string, slug: string): string {
	return join(root, "topics", `${slug}.md`)
}

export function indexFile(root: string): string {
	return join(root, "index.md")
}

export function observationsFile(root: string): string {
	return join(metaDir(root), "observations.jsonl")
}

export function injectionsFile(root: string): string {
	return join(metaDir(root), "injections.jsonl")
}

export function conflictsFile(root: string): string {
	return join(metaDir(root), "conflicts.json")
}

/** Plugin configuration (plain JSON here, not a YAML settings service). */
export function configJsonFile(root: string): string {
	return join(metaDir(root), "config.json")
}

/**
 * Legacy pre-OKF JSON store, resolved beside the bundle root: with the default
 * root this is exactly `~/.pi/agent/topic-memory.json`; an explicit
 * $PI_TOPICS_HOME keeps the legacy path next to the test bundle so migration
 * never touches the real store.
 */
export function legacyJsonStorePath(root: string): string {
	return join(dirname(root), "topic-memory.json")
}

/** Sanitized host name recorded in `generated.by` for multi-machine provenance. */
export function hostId(): string {
	return osHostname().replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+|-+$/g, "") || "unknown-host"
}

/** The actor string stamped into `generated.by` for machine-written topics. */
export function actorFor(): string {
	return `agent:pi-topic-memory@${hostId()}`
}
