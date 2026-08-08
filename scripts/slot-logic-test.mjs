// Standalone simulation of the edited beginPendingInject/takePendingInject logic.
// Mirrors index.ts exactly (copied verbatim), then exercises the two required paths.
// Plain JS on purpose — runnable with `node scripts/slot-logic-test.mjs`.

const pendingInjectSlots = new Map();
const pendingInjectLeftovers = new Map();

function beginPendingInject(sessionId, inputText) {
	const prev = pendingInjectSlots.get(sessionId);
	if (prev && !(prev.settled && prev.verdict === null)) {
		pendingInjectLeftovers.set(sessionId, prev);
	}
	const slot = {
		inputText,
		createdAt: Date.now(),
		settled: false,
		verdict: null,
		resolve: () => {},
		promise: Promise.resolve(null),
	};
	slot.promise = new Promise((r) => {
		slot.resolve = (v) => {
			if (slot.settled) return;
			slot.settled = true;
			slot.verdict = v;
			r(v);
		};
	});
	pendingInjectSlots.set(sessionId, slot);
	return slot;
}

function takePendingInject(sessionId) {
	const slot = pendingInjectSlots.get(sessionId);
	if (slot && slot.settled) {
		pendingInjectSlots.delete(sessionId);
		return { slot, verdict: slot.verdict };
	}
	const leftover = pendingInjectLeftovers.get(sessionId);
	if (leftover && leftover.settled) {
		pendingInjectLeftovers.delete(sessionId);
		return { slot: leftover, verdict: leftover.verdict };
	}
	return null;
}

// ---- injectedTopics guard (mirrors index.ts 1076-1087) ----
const injectedTopics = new Set();
let injectedSessionKey;
function topicInjected(sessionId, topicId) {
	if (sessionId !== injectedSessionKey) return false;
	return injectedTopics.has(`${sessionId}|${topicId}`);
}
function markTopicInjected(sessionId, topicId) {
	if (sessionId !== injectedSessionKey) {
		injectedSessionKey = sessionId;
		injectedTopics.clear();
	}
	injectedTopics.add(`${sessionId}|${topicId}`);
}

// ---- sameRound (mirrors index.ts 2859-2866 verbatim) ----
function sameRound(raw, prompt) {
	const a = raw.trim();
	const b = prompt.trim();
	if (a === b) return true;
	if (a.length >= 4 && b.includes(a)) return true;
	if (b.length >= 4 && a.includes(b)) return true;
	return false;
}

// ---- harness state ----
const SESSION = "s1";
const logs = [];
function round(name, prompt) {
	// before_agent_start simulation (injectVerdict simplified)
	const taken = takePendingInject(SESSION);
	if (!taken) {
		logs.push(`${name}: no-inject`);
		return null;
	}
	const { slot, verdict } = taken;
	if (!verdict) {
		logs.push(`${name}: verdict-null`);
		return null;
	}
	if (topicInjected(verdict.sessionId, verdict.topic.id)) {
		logs.push(`${name}: skip-already-injected`);
		return null;
	}
	if (sameRound(slot.inputText, prompt)) {
		markTopicInjected(verdict.sessionId, verdict.topic.id);
		logs.push(`${name}: inject topic=${verdict.topic.id} source=same`);
		return verdict.topic.id;
	}
	// late path — fresh + loose token match (mirrors index.ts looseTopicMatch)
	if (looseMatch(prompt, verdict.topic.title)) {
		markTopicInjected(verdict.sessionId, verdict.topic.id);
		logs.push(`${name}: inject topic=${verdict.topic.id} source=late`);
		return verdict.topic.id;
	}
	logs.push(`${name}: dropped_stale`);
	return null;
}

// ---- looseMatch: token-overlap Dice ≥ 0.25 (mirrors index.ts looseTopicMatch) ----
// Per-char CJK + ascii-word tokenization, like the real tokenize().
function looseMatch(prompt, title) {
	const tokens = (s) =>
		s.toLowerCase().match(/[a-z0-9]+|[\u4e00-\u9fff]/g) ?? [];
	const a = tokens(prompt);
	const b = new Set(tokens(title));
	let shared = 0;
	for (const t of a) if (b.has(t)) shared++;
	return (2 * shared) / (a.length + b.size) >= 0.25;
}

// --- PATH B: fast classify → same-round injection ---
{
	// input1 arrives, classify settles synchronously before before_agent_start
	const s1 = beginPendingInject(SESSION, "需求A工作");
	s1.resolve({
		kind: "matched",
		topic: { id: "T1", title: "需求A工作" },
		sessionId: SESSION,
		inputText: "需求A工作",
	});
	round("r1", "需求A工作 expanded");
}
// --- PATH A: slow classify input1 → pending round ignored → late inject at round2 ---
{
	const s1 = beginPendingInject(SESSION, "把支付网关从单体拆出来");
	// before_agent_start r2: slot still pending → nothing (NO pending log now)
	round("r2", "把支付网关从单体拆出来 expanded");
	// classify1 settles LATE, then input2 (same topic, rephrased) arrives
	s1.resolve({
		kind: "matched",
		topic: { id: "T2", title: "支付网关重构" },
		sessionId: SESSION,
		inputText: "把支付网关从单体拆出来",
	});
	const s2 = beginPendingInject(SESSION, "支付网关拆分的进度怎么样了"); // moves settled s1 to leftovers
	// before_agent_start r3: current slot2 pending → leftover consumed late
	round("r3", "支付网关拆分的进度怎么样了 expanded");
	// slot2 settles with the SAME topic (continuation) → r4 must NOT re-inject T2
	s2.resolve({
		kind: "matched",
		topic: { id: "T2", title: "支付网关重构" },
		sessionId: SESSION,
		inputText: "支付网关拆分的进度怎么样了",
	});
	round("r4", "支付网关拆分的进度怎么样了 expanded");
	// topic switch: input3 about a different topic → slot3 created (slot2 consumed at r4)
	const s3 = beginPendingInject(SESSION, "需求C工作");
	round("r5", "需求C工作 expanded");
	s3.resolve({
		kind: "matched",
		topic: { id: "T4", title: "需求C工作" },
		sessionId: SESSION,
		inputText: "需求C工作",
	});
	round("r6", "需求C工作 expanded");
}

console.log(logs.join("\n"));
console.log("---");
console.log(
	"slots left:",
	pendingInjectSlots.size,
	"leftovers left:",
	pendingInjectLeftovers.size,
);

// assertions
const assert = (c, m) => {
	if (!c) {
		console.error("FAIL:", m);
		process.exit(1);
	}
	console.log("PASS:", m);
};
assert(
	logs.includes("r1: inject topic=T1 source=same"),
	"fast classify → same-round inject",
);
assert(
	logs.includes("r2: no-inject"),
	"slow classify round → no inject, NO pending log",
);
assert(
	logs.includes("r3: inject topic=T2 source=late"),
	"settled leftover consumed late",
);
assert(
	logs.includes("r4: skip-already-injected"),
	"continuation round does not double-inject (topicInjected guard)",
);
assert(
	logs.includes("r6: inject topic=T4 source=same"),
	"fresh round after topic switch still same-injects",
);

// --- priority: settled current slot beats settled leftover ---
{
	const a = beginPendingInject(SESSION, "P1工作");
	a.resolve({
		kind: "matched",
		topic: { id: "T5", title: "P1工作" },
		sessionId: SESSION,
		inputText: "P1工作",
	});
	const b = beginPendingInject(SESSION, "P2工作"); // moves settled a to leftovers
	b.resolve({
		kind: "matched",
		topic: { id: "T6", title: "P2工作" },
		sessionId: SESSION,
		inputText: "P2工作",
	});
	const taken = takePendingInject(SESSION);
	assert(
		taken && taken.verdict.topic.id === "T6",
		"settled current slot takes priority over leftover",
	);
	assert(
		pendingInjectLeftovers.size === 1,
		"leftover preserved for a later round",
	);
}
assert(
	logs.filter((l) => l.includes("topic=T2")).length === 1,
	"T2 injected exactly once",
);
assert(
	!logs.some((l) => l.includes("outcome=pending")),
	"no outcome=pending anywhere",
);
console.log("\nALL ASSERTIONS PASSED");
