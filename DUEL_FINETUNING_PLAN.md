# Duel Arena Fine-Tuning Integration Plan

> Hyperscape x Eliza x Milady — Hackathon Submission
>
> Date: 2026-02-19 | Branch: `hackathon`
>
> **Status: IMPLEMENTED** — All phases complete, all three repos compile.

## Implementation Status

| Phase | Description | Status | Files |
|-------|-------------|--------|-------|
| **1a** | Pass AgentRuntime to DuelCombatAI | DONE | `StreamingDuelScheduler/index.ts` |
| **1b** | LLM decision path with 400ms timeout | DONE | `arena/DuelCombatAI.ts` |
| **2a** | DuelTrajectoryRecorder (Eliza-compatible JSON) | DONE | `arena/DuelTrajectoryRecorder.ts` (new) |
| **2b** | DuelRewardCalculator (shaping + terminal rewards) | DONE | `arena/DuelRewardCalculator.ts` (new) |
| **2c** | Hook recorders into StreamingDuelScheduler | DONE | `StreamingDuelScheduler/index.ts` |
| **3a** | Combat RULER rubric | DONE | `eliza/packages/training/src/rubrics/duel-combat.ts` (new) |
| **3b** | Trajectory ingestion service + API route | DONE | `milady/src/services/duel-trajectory-watcher.ts` (new), `milady/src/api/training-routes.ts` |
| **4a** | Duel Analytics dashboard tab | DONE | `milady/apps/app/src/components/DuelAnalyticsView.tsx` (new) |
| **5a** | spawnSingleModelAgent for hot-swap | DONE | `eliza/ModelAgentSpawner.ts` |
| **5b** | checkAndApplyModelUpdates (latest-model.json) | DONE | `StreamingDuelScheduler/index.ts` |

---

## 1. Goal

Make Hyperscape duel arena agents **learn from their fights**. Every duel generates training data; Eliza's training pipeline turns that data into fine-tuned combat models; Milady's dashboard lets you watch the whole loop. The result: **model vs model duels where agents measurably improve over time**.

The loop:

```
Fight → Record Trajectory → Score → Train → Deploy → Fight Again (better)
```

The hackathon deliverable is a live duel arena where each agent's combat decisions are driven by a fine-tuned model, with a dashboard showing training progress, model ELO, and per-fight analytics.

---

## 2. Current State Analysis

### What Exists

| System | Status | Key Files |
|--------|--------|-----------|
| **Duel Arena** (Hyperscape) | Working. OSRS-style rules, stakes, countdown, combat. | `server/src/systems/DuelSystem/`, `server/src/systems/StreamingDuelScheduler/` |
| **DuelCombatAI** (Hyperscape) | Working but rule-based. `useLlmTactics: false`. Priority: heal → buff → attack. | `server/src/arena/DuelCombatAI.ts` |
| **ModelAgentSpawner** (Hyperscape) | Working. Creates `AgentRuntime` per agent with model plugins. Stores `{ config, runtime, service }` per agent. | `server/src/eliza/ModelAgentSpawner.ts` |
| **Streaming Scheduler** (Hyperscape) | Working. 15-min cycles with auto-pairing, food prep, health restore, stat persistence. | `server/src/systems/StreamingDuelScheduler/index.ts` |
| **AgentManager** (Hyperscape) | Working but no runtime stored. Uses `getAgentService()` which returns `EmbeddedHyperscapeService` only. | `server/src/eliza/AgentManager.ts` |
| **`runtime.useModel()`** (Hyperscape) | Working. Used in `ai-helpers.ts`, `autonomous-behavior-manager.ts`, `HyperscapeService.ts`. Pattern: `runtime.useModel(ModelType.TEXT_SMALL, { prompt, maxTokens })`. | `plugin-hyperscape/src/utils/ai-helpers.ts` |
| **Training Pipeline** (Eliza) | Working. TrajectoryRecorder, RULER scoring, GRPO training, model deployment. Package: `@elizaos/training@2.0.0-alpha.26`. | `packages/training/src/training/` |
| **Training Dashboard** (Milady) | Working. Trajectory browser, dataset builder, job manager, model activation. | `apps/app/src/components/FineTuningView.tsx` |
| **Game Embedding** (Milady) | Working. Hyperscape iframe with PostMessage auth. | `apps/app/src/components/GameView.tsx` |

### What's Missing — Verified Gap Analysis

| Gap | Details | Verified Against |
|-----|---------|-----------------|
| **No `@elizaos/training` dependency in Hyperscape** | Hyperscape's `packages/server/package.json` has `@elizaos/plugin-sql` but NOT `@elizaos/core` or `@elizaos/training` as direct deps. `@elizaos/core` resolves transitively via `@hyperscape/plugin-hyperscape`. Cannot import `TrajectoryRecorder`. | `packages/server/package.json`, `packages/plugin-hyperscape/package.json` |
| **No trajectory recording adapter wired** | `TrajectoryRecorder` requires `setTrainingDataAdapter()` to be called before use. Hyperscape doesn't call this anywhere. | `eliza/packages/training/src/adapter.ts` — `getTrainingDataAdapter()` throws if not set |
| **`endTrajectory()` computes finance-specific metrics** | Hardcoded: `tradesExecuted` counts BUY/SELL actions, `postsCreated` counts POST actions. For combat, both would always be 0. `metricsJson` structure is finance-oriented. | `TrajectoryRecorder.ts` lines 241-249 |
| **DuelCombatAI doesn't receive `AgentRuntime`** | `StreamingDuelScheduler.startCombatAIs()` creates `DuelCombatAI(service, opponentId)` without runtime. Gets service from `AgentManager.getAgentService()` which returns `EmbeddedHyperscapeService` only. Runtime exists in `ModelAgentSpawner.runningAgents` but isn't accessible. | `StreamingDuelScheduler` lines 1283-1294, `AgentManager.getAgentService()` line 594 |
| **RULER selects rubrics by archetype, not scenarioId** | `RulerScoringService.buildJudgePrompt()` checks if all trajectories share an archetype, then calls `getRubric(archetype)`. No concept of scenario-based rubrics. | `RulerScoringService.ts` lines 469-477 |
| **Training pipeline doesn't filter by scenarioId** | `getTrajectoryIdsForTraining()` returns all ready trajectories. `ExportGroupedForGRPOFn` has no scenario filter parameter. Combat trajectories would mix with any other agent data. | `AutomationPipeline.ts` line 324, `dependencies.ts` lines 97-102 |
| **Model hot-swap doesn't work** | `ModelDeployer.deploy()` calls `runtimeManager.resetRuntime()` which only deletes from a Map cache. Does NOT update `character.settings.model`, recreate runtimes, or affect Hyperscape. `AgentRuntime` model is set at creation time and immutable. | `ModelDeployer.ts`, `ModelAgentSpawner.ts` line 446-451 |
| **No duel analytics in Milady** | No fight replay, model comparison, ELO, or combat-specific views. | Confirmed via full dashboard component survey |

---

## 3. Architecture

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        HYPERSCAPE SERVER                         │
│                                                                  │
│  StreamingDuelScheduler                                          │
│       │                                                          │
│       ├─► DuelCombatAI (per agent, receives runtime + service)   │
│       │      │                                                   │
│       │      ├─► runtime.useModel(TEXT_SMALL) → action choice    │
│       │      │      (same pattern as ai-helpers.ts)              │
│       │      │                                                   │
│       │      └─► service.executeAttack / executeUse              │
│       │                                                          │
│       └─► DuelTrajectoryRecorder (writes JSON files)             │
│              │                                                   │
│              ├─► Per-tick: environment state + LLM call + action  │
│              └─► On duel end: reward signal + save to JSON        │
│                                                                  │
│  JSON trajectory files on disk ─────────────────────────────────►│
│                                                                  │
└───────────────┬──────────────────────────────────────────────────┘
                │ Trajectories on shared filesystem (or API push)
                ▼
┌─────────────────────────────────────────────────────────────────┐
│              MILADY + ELIZA (same process)                        │
│                                                                  │
│  TrajectoryIngestService (new)                                   │
│       │ reads JSON files or receives via API                     │
│       │ calls setTrainingDataAdapter() on startup                │
│       ▼                                                          │
│  TrajectoryRecorder (Eliza) ─► writes to Eliza's DB              │
│       │                                                          │
│       ▼                                                          │
│  RULER Scoring (archetype: "duel-combat")                        │
│       │ uses combat rubric registered in RUBRICS map             │
│       ▼                                                          │
│  AutomationPipeline                                              │
│       │ configured with archetype filter                         │
│       ▼                                                          │
│  GRPO Training (Python)                                          │
│       │                                                          │
│       ▼                                                          │
│  Ollama model import ──► hyperscape-combat-v{N}                  │
│                                                                  │
└───────────────┬──────────────────────────────────────────────────┘
                │ Model available in Ollama
                ▼
┌─────────────────────────────────────────────────────────────────┐
│              HYPERSCAPE SERVER (model reload)                     │
│                                                                  │
│  Between fights, ModelAgentSpawner:                               │
│       1. stopAgent(characterId)                                  │
│       2. Update character.settings.model → new Ollama tag        │
│       3. spawnSingleAgent(config) with new model                 │
│       4. Agent resumes with trained model                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Don't import `@elizaos/training` into Hyperscape.** The repos have different `@elizaos/core` versions (`^2.0.0-alpha.2` vs `2.0.0-alpha.26`). Instead, Hyperscape writes trajectory JSON files to disk. Milady/Eliza ingests them. This avoids cross-repo version conflicts entirely.

2. **Use `runtime.useModel()` — already proven in codebase.** The pattern `runtime.useModel(ModelType.TEXT_SMALL, { prompt })` is used in 6+ places across `plugin-hyperscape`. DuelCombatAI uses the same API. No new LLM integration needed. **Caveat**: `@elizaos/core` is NOT a direct dependency of `packages/server` — it resolves transitively through `@hyperscape/plugin-hyperscape`. The `ModelType` const must be imported as a runtime value (not just a type). Either add `@elizaos/core` as a direct dependency of `packages/server`, or use the string literal `"TEXT_SMALL"` directly to avoid fragile transitive resolution.

3. **Agent restart for model swap, not hot-swap.** `AgentRuntime` model is immutable after creation. Between duel cycles (during IDLE state), the scheduler stops the agent, updates the config, and restarts with the new model. This takes ~2 seconds and happens while no duel is active.

4. **Rubrics via archetype, not scenarioId.** RULER's rubric system dispatches by archetype. We set `archetype: "duel-combat"` on trajectories and register a `"duel-combat"` rubric in the `RUBRICS` map. No RULER code changes needed.

5. **JSON file output mimics Eliza's simulation mode format.** Hyperscape's custom `DuelTrajectoryRecorder` writes JSON files to `$TRAJECTORY_OUTPUT_DIR` in the exact same `{ trajectory, llmCalls }` shape that Eliza's `TrajectoryRecorder` produces when `setSimulationMode(true)` is active (verified against `TrajectoryRecorder.ts` lines 302-320). This means Milady's ingestion service can parse them with zero format translation.

---

## 4. Implementation Plan

### Phase 1: LLM-Driven Combat Decisions (Hyperscape)

**Goal**: Replace rule-based DuelCombatAI decisions with `runtime.useModel()` calls.

**Why first**: This is the core mechanic. Without LLM calls, there's nothing to fine-tune.

#### 4.1.1 — Pass `AgentRuntime` to DuelCombatAI

**Problem verified**: `StreamingDuelScheduler.startCombatAIs()` (line 1277-1301) gets the service from `AgentManager.getAgentService()` but the runtime lives in `ModelAgentSpawner.runningAgents`.

**Fix**: `ModelAgentSpawner` already exports `getRunningAgents()` which returns `Map<string, RunningAgent>` where `RunningAgent` has `{ runtime, service, characterId }`. The scheduler needs to look up the runtime from there.

**File**: `packages/server/src/systems/StreamingDuelScheduler/index.ts`

Change in `startCombatAIs()`:
```typescript
// BEFORE (broken — no runtime passed):
const service1 = manager?.getAgentService(agent1.characterId) ?? null;
const ai1 = new DuelCombatAI(service1, agent2.characterId);

// AFTER (working — runtime from ModelAgentSpawner):
import { getRunningAgents } from "../../eliza/ModelAgentSpawner.js";

const runningAgents = getRunningAgents();
// RunningAgent key format: "{provider}-{model}" 
// Must find by characterId match
let runtime1: AgentRuntime | null = null;
let service1: EmbeddedHyperscapeService | null = null;
for (const [, agent] of runningAgents) {
  if (agent.characterId === agent1.characterId) {
    runtime1 = agent.runtime;
    service1 = agent.service;
    break;
  }
}
// Fallback to AgentManager for non-ModelAgentSpawner agents
if (!service1) {
  service1 = manager?.getAgentService(agent1.characterId) ?? null;
}

if (service1) {
  const ai1 = new DuelCombatAI(service1, agent2.characterId, 
    { useLlmTactics: !!runtime1 }, runtime1 ?? undefined);
  ai1.start();
  this.combatAIs.set(agent1.characterId, ai1);
}
```

#### 4.1.2 — Add LLM decision path in DuelCombatAI

**File**: `packages/server/src/arena/DuelCombatAI.ts`

The `tick()` method currently runs: `tryHeal() → tryBuff() → tryAttack()`. We add an LLM path that replaces this when `useLlmTactics` is true.

```typescript
private async tick(): Promise<void> {
  if (!this.isRunning) return;
  this.tickCount++;

  const state = this.service.getGameState();
  if (!state || !state.alive) { this.stop(); return; }

  // Track damage (existing code, unchanged)
  this.trackDamage(state);
  const healthPct = state.maxHealth > 0 ? (state.health / state.maxHealth) * 100 : 100;
  const phase = this.determineCombatPhase(healthPct, this.getOpponentData(state));

  // LLM decision path
  if (this.config.useLlmTactics && this.runtime) {
    const action = await this.getLlmDecision(state, healthPct, phase);
    if (action) {
      await this.executeAction(action, state);
      return;
    }
    // LLM failed/timed out → fall through to rule-based
  }

  // Rule-based fallback (existing code, unchanged)
  if (await this.tryHeal(state, healthPct, phase)) { this.healsUsed++; return; }
  if (await this.tryBuff(state, phase)) { return; }
  await this.tryAttack(state, phase);
}
```

The LLM call:
```typescript
private async getLlmDecision(
  state: EmbeddedGameState,
  healthPct: number,
  phase: CombatPhase,
): Promise<CombatAction | null> {
  if (!this.runtime) return null;

  const opponentData = this.getOpponentData(state);
  const foodCount = state.inventory.filter(item => 
    FOOD_PATTERNS.some(p => (item.itemId || "").toLowerCase().includes(p))
  ).length;
  const potionCount = state.inventory.filter(item =>
    POTION_PATTERNS.some(p => (item.itemId || "").toLowerCase().includes(p))
  ).length;

  const prompt = [
    `COMBAT TICK ${this.tickCount} | Phase: ${phase}`,
    `Your HP: ${Math.round(healthPct)}% (${state.health}/${state.maxHealth})`,
    `Opponent HP: ${opponentData ? Math.round((opponentData.health / Math.max(opponentData.maxHealth, 1)) * 100) : '?'}%`,
    `Food: ${foodCount} | Potions: ${potionCount}`,
    `Damage dealt: ${this.totalDamageDealt} | Damage taken: ${this.totalDamageReceived}`,
    `Ticks without attack: ${this.ticksSinceLastAttack}`,
    ``,
    `Choose ONE action: ATTACK | EAT | DRINK_POTION | SWITCH_AGGRESSIVE | SWITCH_DEFENSIVE`,
    `Reply with ONLY the action name.`,
  ].join("\n");

  const startMs = Date.now();
  try {
    // 400ms timeout — if LLM is too slow, fall back to rules
    // Note: use string literal "TEXT_SMALL" or add @elizaos/core as direct dep
    // to packages/server. Type cast matches pattern from ai-helpers.ts.
    const response = await Promise.race([
      this.runtime.useModel("TEXT_SMALL" as const, {
        prompt,
        maxTokens: 10,
        temperature: 0.3,
      } as Parameters<typeof this.runtime.useModel>[1]),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 400)),
    ]);

    if (!response) return null; // timeout

    const text = ((response as { text?: string }).text || String(response)).trim().toUpperCase();
    const latencyMs = Date.now() - startMs;

    // Record LLM call for trajectory
    this.lastLlmCall = { prompt, response: text, latencyMs, model: "agent-model" };

    if (text.includes("EAT")) return "EAT";
    if (text.includes("DRINK") || text.includes("POTION")) return "DRINK_POTION";
    if (text.includes("AGGRESSIVE")) return "SWITCH_AGGRESSIVE";
    if (text.includes("DEFENSIVE")) return "SWITCH_DEFENSIVE";
    if (text.includes("ATTACK")) return "ATTACK";
    return "ATTACK"; // default
  } catch {
    return null; // LLM error → fall back to rules
  }
}
```

**Latency note**: `maxTokens: 10` with `temperature: 0.3` for a single token response. Via Ollama with a 4B quantized model, this typically completes in 50-200ms on GPU, 200-800ms on CPU. The 400ms timeout with rule-based fallback handles both cases. **This latency claim needs to be validated on the target hardware before committing to the tick budget.** Add a startup benchmark: run 10 test prompts on boot, log p50/p95 latency, warn if p95 > 400ms.

#### 4.1.3 — Action Execution

```typescript
type CombatAction = "ATTACK" | "EAT" | "DRINK_POTION" | "SWITCH_AGGRESSIVE" | "SWITCH_DEFENSIVE";

private async executeAction(action: CombatAction, state: EmbeddedGameState): Promise<void> {
  switch (action) {
    case "EAT": {
      const food = this.findBestFood(state.inventory);
      if (food) {
        try { await this.service.executeUse(food.itemId); this.healsUsed++; } catch {}
      } else {
        // No food — attack instead
        await this.tryAttackOpponent();
      }
      break;
    }
    case "DRINK_POTION": {
      const potion = this.findPotion(state.inventory);
      if (potion) {
        try { await this.service.executeUse(potion.itemId); } catch {}
      } else {
        await this.tryAttackOpponent();
      }
      break;
    }
    case "ATTACK":
      await this.tryAttackOpponent();
      break;
    case "SWITCH_AGGRESSIVE":
    case "SWITCH_DEFENSIVE":
      // Style switching requires combat system integration — 
      // for hackathon, treat as attack + log the intent
      await this.tryAttackOpponent();
      break;
  }
}

private async tryAttackOpponent(): Promise<void> {
  try {
    await this.service.executeAttack(this.opponentId);
    this.ticksSinceLastAttack = 0;
    this.attacksLanded++;
  } catch {}
}
```

---

### Phase 2: Trajectory Recording (Hyperscape)

**Goal**: Capture every tick's game state, LLM call, and action as a trajectory.

**Key decision**: We do NOT import `@elizaos/training` into Hyperscape. Instead, we write Eliza-compatible JSON files to disk using simulation mode's format. This avoids cross-repo dependency conflicts.

#### 4.2.1 — DuelTrajectoryRecorder (Self-Contained)

**File**: `packages/server/src/arena/DuelTrajectoryRecorder.ts` (new)

This is a standalone recorder that writes JSON files matching the format `TrajectoryRecorder` produces in simulation mode. No external dependencies.

```typescript
interface CombatTickRecord {
  stepNumber: number;
  timestamp: number;
  environmentState: {
    // Required by Eliza's EnvironmentState (with index signature)
    agentBalance: number; // 0 — not applicable, but field is required
    agentPnL: number;     // 0 — not applicable
    openPositions: number; // 0 — not applicable
    // Combat-specific fields (via index signature [key: string])
    healthPct: number;
    currentHealth: number;
    maxHealth: number;
    opponentHealthPct: number;
    opponentCurrentHealth: number;
    opponentMaxHealth: number;
    foodCount: number;
    potionCount: number;
    combatPhase: string;
    tickNumber: number;
    totalDamageDealt: number;
    totalDamageReceived: number;
    ticksSinceLastAttack: number;
  };
  providerAccesses: []; // empty — agents don't use Eliza providers in combat
  llmCalls: Array<{
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    temperature: number;
    maxTokens: number;
    latencyMs: number;
    purpose: "action";
    actionType: string;
  }>;
  action: {
    actionType: string; // "ATTACK", "EAT", "DRINK_POTION", etc.
    parameters: Record<string, unknown>;
    success: boolean;
    result: Record<string, unknown>;
  };
  reward: number; // per-tick shaping reward
}

interface DuelTrajectoryFile {
  // Must match Omit<TrajectoryRecord, 'createdAt' | 'updatedAt'> exactly.
  // Verified against eliza/packages/training/src/adapter.ts lines 31-64.
  trajectory: {
    id: string; // Generate a unique ID (uuid v4 or snowflake)
    trajectoryId: string;
    agentId: string;
    archetype: "duel-combat"; // matches RUBRICS key
    startTime: string; // ISO 8601 (Date serialized via JSON.stringify)
    endTime: string; // ISO 8601
    durationMs: number;
    windowId: string | null; // Set to null for combat trajectories
    windowHours: number; // Set to 1 (default)
    episodeId: string | null; // "duel:{cycleId}-{timestamp}"
    scenarioId: string; // "duel:{cycleId}" — both agents share this
    batchId: string | null; // null
    stepsJson: string; // JSON.stringify(steps)
    rewardComponentsJson: string;
    metricsJson: string; // JSON.stringify of:
    //   { episodeLength, finalStatus, won, damageDealt, damageReceived,
    //     healsUsed, attacksLanded, foodRemaining, tickCount, errorCount,
    //     finalBalance: null, finalPnL: null, tradesExecuted: 0, postsCreated: 0 }
    metadataJson: string;
    totalReward: number;
    episodeLength: number;
    finalStatus: string; // "completed" | "completed_with_errors"
    finalBalance: number | null; // null — not applicable
    finalPnL: number | null; // null — not applicable
    tradesExecuted: number | null; // null — not applicable
    postsCreated: number | null; // null — not applicable
    aiJudgeReward: number | null; // null — set by RULER later
    aiJudgeReasoning: string | null; // null — set by RULER later
    judgedAt: string | null; // null (Date serialized) — set by RULER later
    isTrainingData: boolean; // true
    isEvaluation: boolean; // false
    usedInTraining: boolean; // false — updated after training
    trainedInBatch: string | null; // null — updated after training
  };
  llmCalls: Array<{
    stepNumber: number;
    callIndex: number;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    response: string;
    temperature: number;
    maxTokens: number;
    latencyMs: number;
    purpose: string;
    actionType: string;
  }>;
}
```

The recorder:
- Creates a unique `trajectoryId` per agent per duel
- Sets `scenarioId` to `duel:{cycleId}` so both agents share the scenario (enables RULER relative comparison)
- Sets `archetype` to `"duel-combat"` (matches the rubric key)
- Writes to `./training-data-output/trajectories/{trajectoryId}.json`
- File format exactly matches `TrajectoryRecorder`'s simulation mode output

#### 4.2.2 — Reward Function

Multi-component reward with verified game state access:

**Per-tick shaping rewards** (small, from game state available in `EmbeddedGameState`):

| Condition | Reward | Verification |
|-----------|--------|-------------|
| Attack landed (opponent HP decreased) | +0.1 | Verified: `opponentData.health` tracked each tick in `DuelCombatAI.tick()` |
| Ate food when HP < 40% | +0.2 | Verified: `healthPct` computed, food detected via `FOOD_PATTERNS` |
| Ate food when HP > 70% | -0.1 | Same as above, opposite condition |
| No action taken (timeout/error) | -0.05 | Detected via `action.success === false` |
| Tick survived | +0.01 | Always, as long as alive |

**End-of-duel terminal rewards** (large, from `StreamingDuelScheduler` resolution data):

| Component | Weight | Signal | Verification |
|-----------|--------|--------|-------------|
| Win/Loss | 0.40 | +1.0 win, -0.5 loss | Verified: `startResolution(winnerId, loserId)` called with explicit IDs |
| Damage Efficiency | 0.20 | `dealt / max(received, 1)` clamped [0, 1] | Verified: `damageDealtThisFight` tracked on `AgentContestant` |
| Food Conservation | 0.15 | `foodRemaining / foodStarted` | Verified: `duelFoodSlotsByAgent` tracks food given, inventory system tracks current |
| Kill Speed | 0.15 | `1 - (tickCount / maxTicks)` | Verified: `tickCount` on DuelCombatAI, `STREAMING_TIMING.FIGHTING_DURATION` for max |
| Survival | 0.10 | `currentHp / maxHp` at fight end | Verified: `agent.currentHp`, `agent.maxHp` on `AgentContestant` |

#### 4.2.3 — Hook into StreamingDuelScheduler

**File**: `packages/server/src/systems/StreamingDuelScheduler/index.ts`

```
startFight() → create DuelTrajectoryRecorder per agent, pass to DuelCombatAI
DuelCombatAI.tick() → recorder.recordTick(state, llmCall, action, reward)
startResolution() → recorder.endDuel(won, stats) → writes JSON file
```

Storage location: Configurable via `TRAJECTORY_OUTPUT_DIR` env var, defaulting to `path.resolve(process.cwd(), "training-data-output/trajectories/")`. **Critical**: This resolves relative to the server's CWD (typically `packages/server/`), producing an absolute path like `/home/dev/Dev/hyperscape/packages/server/training-data-output/trajectories/`. Milady's `TrajectoryIngestService` must be configured with the same absolute path via its own env var `TRAJECTORY_WATCH_DIR`.

---

### Phase 3: Training Pipeline Integration (Eliza + Milady)

**Goal**: Ingest combat trajectories into Eliza's training pipeline and produce fine-tuned models.

#### 4.3.1 — Trajectory Ingestion Service (Milady)

**Problem**: Hyperscape writes JSON files. Eliza's pipeline reads from its database via `ITrainingDataAdapter`. We need a bridge.

**File**: `src/services/trajectory-ingest.ts` (new, in Milady repo root)

This service:
1. Watches the directory specified by `TRAJECTORY_WATCH_DIR` env var (must match Hyperscape's `TRAJECTORY_OUTPUT_DIR` absolute path, e.g. `/home/dev/Dev/hyperscape/packages/server/training-data-output/trajectories/`)
2. Parses each file (format matches `TrajectoryRecorder` simulation mode output)
3. Calls the registered `ITrainingDataAdapter.insertTrajectory()` to write to Eliza's database
4. Moves processed files to a `processed/` sibling directory

**Why in Milady**: Milady already has `@elizaos/core` and the training service wired up (`src/services/training-service.ts`, verified at `milady/src/services/training-service.ts`). It's the natural home for the ingestion bridge. New file goes at `milady/src/services/trajectory-ingest.ts`, alongside existing services.

**Alternative (faster for hackathon)**: If Milady and Hyperscape share a filesystem (same machine), Eliza's `TrajectoryRecorder.setSimulationMode(true)` could be used and the JSON files consumed directly by the training scripts. The Python GRPO trainer can read JSON trajectory files.

#### 4.3.2 — Combat RULER Rubric

**File**: `eliza/packages/training/src/rubrics/combat.ts` (new)

The rubric must be registered with the key `"duel-combat"` in the `RUBRICS` map (file: `eliza/packages/training/src/rubrics/index.ts`).

**Verified integration path**: `RulerScoringService` checks if all trajectories in a scenario group share an archetype (line 469-477). If so, it calls `getRubric(archetype)`. Our trajectories have `archetype: "duel-combat"`, so the rubric is selected automatically.

```typescript
// rubrics/combat.ts
export const DUEL_COMBAT_RUBRIC = `
You are evaluating PvP combat trajectories from a duel arena.
Score each trajectory 0-1 relative to others in the same duel.

Criteria (in order of importance):

1. OUTCOME (40%): Winner scores higher. Margin of victory matters — 
   winning with high HP remaining > barely winning.

2. DAMAGE EFFICIENCY (25%): Ratio of damage dealt to damage received.
   An agent that dealt 200 damage and took 100 is more efficient than
   one that dealt 300 but took 400.

3. TACTICAL DECISIONS (20%):
   - Ate food at appropriate HP thresholds (30-50%), not too early
   - Used potions in opening ticks for buff advantage
   - Maintained attack pressure (few idle ticks)
   - Did not waste food eating at high HP

4. RESOURCE MANAGEMENT (15%):
   - Winning with food remaining shows efficiency
   - Running out of food and dying = poor management
   - Potion usage timing (opening phase = good, mid-fight = neutral)

CRITICAL: A losing agent that fought efficiently should score higher
than a winning agent that got lucky (e.g., opponent ran out of food
due to bad RNG, not skill). Focus on DECISION QUALITY over outcomes.
`;
```

**File change**: `eliza/packages/training/src/rubrics/index.ts` — add to `RUBRICS` map:
```typescript
import { DUEL_COMBAT_RUBRIC } from './combat';
// In RUBRICS object:
'duel-combat': DUEL_COMBAT_RUBRIC,
```

#### 4.3.3 — Training Configuration

The `AutomationPipeline` does NOT filter by archetype or scenarioId when selecting trajectories for training. For the hackathon, we handle this one of two ways:

**Option A (Recommended — No Eliza code changes)**: Use a dedicated Eliza database for combat training. Milady's training service connects to a separate database that only contains duel trajectories. This is configured via `DATABASE_URL` in Milady's environment.

**Option B (Requires Eliza change)**: Add an `archetype` filter to `getTrajectoryIdsForTraining()` in the adapter interface. This is cleaner long-term but requires modifying Eliza.

**AutomationPipeline configuration** (via environment variables, set in Milady's `.env`):
```env
TRAINING_MIN_TRAJECTORIES=30
TRAINING_BASE_MODEL=unsloth/Qwen3-4B-128K
TRAINING_MODEL_ID_PREFIX=hyperscape-combat
TRAINING_MODE=atropos
```

#### 4.3.4 — Model Deployment (Agent Restart, Not Hot-Swap)

**Problem verified**: `AgentRuntime` model is immutable. Set in `character.settings.model` at construction time (`ModelAgentSpawner.ts` line 446). No API to change it.

**Solution**: Between duel cycles, restart the agent with the new model.

**File**: `packages/server/src/systems/StreamingDuelScheduler/index.ts`

In `endCycle()`, before starting a new cycle, check for model updates:

```typescript
private async endCycle(): Promise<void> {
  // ... existing resolution logic ...
  this.currentCycle = null;
  this.schedulerState = "IDLE";

  // Check for model updates and restart agents if needed
  await this.checkAndApplyModelUpdates();

  // Continue to next cycle
  if (this.availableAgents.size >= config.minAgents) {
    this.schedulerState = "ACTIVE";
    this.startNewCycle();
  }
}

private async checkAndApplyModelUpdates(): Promise<void> {
  // Read model version file written by training pipeline
  // e.g., ./training-data-output/latest-model.json
  // Contains: { ollamaTag: "hyperscape-combat-v2", version: 2, timestamp: ... }
  
  const modelInfoPath = process.env.TRAJECTORY_OUTPUT_DIR 
    ? `${process.env.TRAJECTORY_OUTPUT_DIR}/../latest-model.json`
    : "./training-data-output/latest-model.json";
  try {
    const raw = await fs.promises.readFile(modelInfoPath, "utf-8");
    const modelInfo = JSON.parse(raw);
    
    if (modelInfo.ollamaTag && modelInfo.ollamaTag !== this.currentModelTag) {
      Logger.info("StreamingDuelScheduler", 
        `New model available: ${modelInfo.ollamaTag}. Restarting agents...`);
      
      // Stop and restart each agent with the new model
      for (const agentId of this.availableAgents) {
        await this.restartAgentWithModel(agentId, modelInfo.ollamaTag);
      }
      
      this.currentModelTag = modelInfo.ollamaTag;
    }
  } catch {
    // No model file or parse error — continue with current model
  }
}
```

**`restartAgentWithModel()` must be written — no existing single-agent restart function exists.** The current `ModelAgentSpawner` API is:
- `stopModelAgent(provider: string, model: string)` — stops by provider+model key, NOT by characterId
- `spawnModelAgents(world: World)` — spawns ALL configured agents, no single-agent variant
- `getRunningAgents()` — returns `Map<string, RunningAgent>` keyed by `"{provider}-{model}"`

Implementation of `restartAgentWithModel()` in the scheduler:
```typescript
private async restartAgentWithModel(agentId: string, newOllamaTag: string): Promise<void> {
  // Find the running agent entry by characterId
  const runningAgents = getRunningAgents();
  let targetKey: string | null = null;
  let targetAgent: RunningAgent | null = null;
  for (const [key, agent] of runningAgents) {
    if (agent.characterId === agentId) {
      targetKey = key;
      targetAgent = agent;
      break;
    }
  }
  if (!targetKey || !targetAgent) return;

  // Stop the existing agent using its provider+model key
  await stopModelAgent(targetAgent.config.provider, targetAgent.config.model);
  this.availableAgents.delete(agentId);

  // Re-spawn with modified config pointing to the Ollama model
  // Override the model to use the Ollama fine-tuned version
  const updatedConfig = { ...targetAgent.config, model: newOllamaTag, provider: "ollama" as const };
  // This requires a new exported function: spawnSingleModelAgent(world, config)
  // which is a subset of spawnModelAgents() for one config entry.
  await spawnSingleModelAgent(this.world, updatedConfig);
}
```

**New function needed in `ModelAgentSpawner.ts`**: `spawnSingleModelAgent(world, config)` — extract the per-agent spawn logic from the loop body of `spawnModelAgents()` into a standalone exported function. This is a ~20-line refactor of existing code, not new logic.

**Communication**: The training pipeline (running in Milady/Eliza) writes a `latest-model.json` file after importing a model to Ollama. Hyperscape reads this file between cycles. Simple, no cross-process communication needed.

---

### Phase 4: Milady Dashboard (Milady)

**Goal**: Duel-specific analytics and training visualization.

#### 4.4.1 — DuelAnalyticsView Component

**File**: `milady/apps/app/src/components/DuelAnalyticsView.tsx` (new)

Data sources:
- **Trajectories**: Already available via existing `client.listTrainingTrajectories()` — filter by archetype `"duel-combat"` client-side
- **Training jobs/models**: Already available via existing `client.listTrainingJobs()`, `client.listTrainingModels()`
- **Duel results**: Parsed from trajectory `metricsJson` (contains `won`, `damageDealt`, etc.)
- **Leaderboard**: Computed client-side from trajectory data grouped by `agentId`

Sections:
1. **Model Leaderboard** — Win rate, total fights, damage efficiency per agent. Computed from trajectory `metricsJson`.
2. **Fight History** — List of duel scenarios (grouped by `scenarioId`). Shows both agents, outcome, stats.
3. **Fight Replay** — Expand a trajectory to see tick-by-tick `stepsJson`. Shows game state + LLM response per tick.
4. **Training Status** — Reuses FineTuningView's job/model sections, filtered to combat datasets.

**No new API endpoints needed for hackathon.** All data comes through existing training routes. The filtering happens in the React component.

#### 4.4.2 — Navigation

**File**: `milady/apps/app/src/navigation.ts`

Add `duel-analytics` tab between `fine-tuning` and `trajectories`.

#### 4.4.3 — GameView Enhancement

**File**: `milady/apps/app/src/components/GameView.tsx`

Add a small overlay panel that shows:
- Current model version being used
- Last 5 LLM decisions (from WebSocket events)
- Training status badge (collecting / training / deployed)

This uses the existing WebSocket infrastructure (`client.onWsEvent()`). Hyperscape server emits `duel_tick` events (new) during fights.

---

### Phase 5: End-to-End Loop

#### 4.5.1 — Startup Script

**File**: `packages/server/scripts/hackathon-demo.ts` (new, in Hyperscape)

Not a magic `bun run hackathon:demo` — a documented startup sequence:

```bash
# Terminal 1: Start Hyperscape server with agents
cd /home/dev/Dev/hyperscape
STREAMING_DUEL_ENABLED=true \
ENABLE_AI=true \
TRAJECTORY_OUTPUT_DIR=/tmp/hyperscape-trajectories \
bun run dev:server
# Dev timing: ~3.25min/cycle (30s announce + 150s fight + 10s warning + 5s resolution)
# Configurable via STREAMING_FIGHTING_MS, STREAMING_ANNOUNCEMENT_MS etc.

# Terminal 2: Start Milady dashboard with training
cd /home/dev/Dev/milady
HYPERSCAPE_CLIENT_URL=http://localhost:3333 \
HYPERSCAPE_SERVER_URL=ws://localhost:5555/ws \
TRAJECTORY_WATCH_DIR=/tmp/hyperscape-trajectories \
TRAINING_MIN_TRAJECTORIES=30 \
bun run dev

# After ~30 duels (~100 minutes in dev mode), trajectories accumulate.
# Trigger training from the dashboard UI (FineTuningView)
# Or via API: curl -X POST http://localhost:2138/api/training/jobs
```

#### 4.5.2 — Demo Flow (Realistic)

1. **Start** — Agents spawn, use existing provider models (GPT-4.1, Claude, etc.) for LLM combat decisions
2. **First 10-15 duels** (~33-49 minutes at ~3.25min/cycle in dev mode; ~15min/cycle in production) — Agents fight with base models, trajectories accumulate
3. **Training trigger** — User clicks "Start Training Job" in Milady dashboard, or API call
4. **GRPO training** — Runs for 10-30 minutes depending on hardware
5. **Model import** — User imports to Ollama via dashboard ("Import to Ollama" button already exists in FineTuningView)
6. **Model deployment** — User writes model tag to `latest-model.json` (or automated via post-training hook)
7. **Agents restart** — Scheduler picks up new model between cycles, restarts agents
8. **Comparison** — Dashboard shows performance of v1 vs v2 model trajectories

**Honest assessment**: Steps 3-7 are semi-manual for the hackathon. Full automation requires more work but the data pipeline is end-to-end.

---

## 5. File Changes Summary

### Hyperscape (packages/server/)

| File | Action | Description |
|------|--------|-------------|
| `src/arena/DuelCombatAI.ts` | **Modify** | Add `getLlmDecision()`, `executeAction()`, `lastLlmCall` tracking. Enable `useLlmTactics` when runtime is available. |
| `src/arena/DuelTrajectoryRecorder.ts` | **New** | Self-contained trajectory recorder. Writes JSON files in Eliza-compatible format. No external dependencies. |
| `src/arena/DuelRewardCalculator.ts` | **New** | Multi-component reward function. Takes game state + outcome, returns number. |
| `src/systems/StreamingDuelScheduler/index.ts` | **Modify** | Pass runtime to DuelCombatAI. Create trajectory recorders per fight. Check for model updates between cycles. Add `restartAgentWithModel()` method. |
| `src/eliza/ModelAgentSpawner.ts` | **Modify** | Extract single-agent spawn logic from `spawnModelAgents()` loop into new exported `spawnSingleModelAgent(world, config)` function. ~20-line refactor. |

### Eliza (packages/training/)

| File | Action | Description |
|------|--------|-------------|
| `src/rubrics/combat.ts` | **New** | `DUEL_COMBAT_RUBRIC` constant |
| `src/rubrics/index.ts` | **Modify** | Add `"duel-combat": DUEL_COMBAT_RUBRIC` to `RUBRICS` map |

### Milady (apps/app/)

| File | Action | Description |
|------|--------|-------------|
| `src/components/DuelAnalyticsView.tsx` | **New** | Duel analytics dashboard (leaderboard, fight history, replay) |
| `src/components/GameView.tsx` | **Modify** | Add model version / training status overlay |
| `src/navigation.ts` | **Modify** | Add `duel-analytics` tab |

### Milady (src/services/ — repo root level)

| File | Action | Description |
|------|--------|-------------|
| `src/services/trajectory-ingest.ts` | **New** | File watcher that ingests Hyperscape trajectory JSONs into Eliza's training DB. Lives alongside `training-service.ts`, `app-manager.ts`, etc. |

---

## 6. Dependencies & Version Compatibility

### Verified Dependencies

| Package | Hyperscape Version | Eliza Version | Compatible? |
|---------|-------------------|---------------|-------------|
| `@elizaos/core` | `^2.0.0-alpha.2` (transitive via `plugin-hyperscape`, **not** direct dep of `packages/server`) | `2.0.0-alpha.26` (internal) | Type imports work; runtime imports fragile without adding as direct dep |
| `@elizaos/plugin-sql` | `^2.0.0-alpha.2` (direct dep of `packages/server`) | Used internally | N/A |
| `@elizaos/training` | **Not installed** | `2.0.0-alpha.26` | **Not imported into Hyperscape** |

### New Dependencies Required

| Repo | Package | Why |
|------|---------|-----|
| Hyperscape (`packages/server`) | `@elizaos/core` (direct dep, optional) | Currently resolves transitively via `plugin-hyperscape`. Adding as direct dep is cleaner for `ModelType` import. Alternatively use string literal `"TEXT_SMALL"` to avoid. |
| Eliza | None | Only adding a rubric file |
| Milady | `chokidar` (or `fs.watch`) | File watching for trajectory ingestion (if not using polling) |

### Runtime Requirements

| Requirement | For | Validated? |
|-------------|-----|-----------|
| Ollama running locally | LLM inference in DuelCombatAI | **Needs validation**: Run `ollama run qwen3:4b` and benchmark inference latency. Must be <400ms for `maxTokens: 10`. |
| GPU with ≥8GB VRAM | GRPO training | **Needs validation**: Test with `unsloth/Qwen3-4B-128K` on target hardware. CPU fallback possible but ~4x slower. |
| PostgreSQL | Milady/Eliza training DB | Already required by Eliza. Hyperscape can use SQLite locally. |
| Shared filesystem | Trajectory JSON file transfer | Assumed: all three repos on same machine for hackathon. Coordinated via `TRAJECTORY_OUTPUT_DIR` / `TRAJECTORY_WATCH_DIR` env vars. If separate machines, need rsync/API push. |

---

## 7. Risks, Unknowns, and Mitigations

| # | Risk | Severity | Status | Mitigation |
|---|------|----------|--------|------------|
| 1 | **Ollama inference latency > 400ms** | HIGH | **UNVALIDATED** | Benchmark on boot. If p95 > 400ms, reduce prompt length or increase tick duration to 1200ms. Rule-based fallback always works. |
| 2 | **GRPO doesn't converge on 30-50 short trajectories** | HIGH | **UNVALIDATED** | Start with 30 as minimum. If results are poor, increase to 100+. Can also use SFT (supervised fine-tuning) instead of GRPO for hackathon — simpler, works with less data. |
| 3 | **Model v2 not measurably better than v1** | MEDIUM | **UNVALIDATED** | Success criterion is "different behavior," not necessarily "better." Dashboard shows decision distribution changes (more heals, fewer wasted actions). If no improvement, show the infrastructure works even if the model needs more data. |
| 4 | **Trajectory JSON format doesn't match Eliza expectations** | MEDIUM | MITIGATED | Initial plan's `DuelTrajectoryFile` was missing 12 fields from `TrajectoryRecord` (`id`, `windowId`, `windowHours`, `episodeId`, `batchId`, `aiJudgeReward`, `aiJudgeReasoning`, `judgedAt`, `isTrainingData`, `isEvaluation`, `usedInTraining`, `trainedInBatch`). Now corrected to match `Omit<TrajectoryRecord, 'createdAt' | 'updatedAt'>` exactly. Test by ingesting one manually before full pipeline. |
| 5 | **Agent restart between cycles disrupts scheduler** | LOW | MITIGATED | Restart happens during IDLE state only. Scheduler waits for agents to re-register before starting new cycle. Existing `WAITING_FOR_AGENTS` state handles this. |
| 6 | **Python training scripts require specific environment** | LOW | MITIGATED | Document exact Python version, pip packages, CUDA version in setup instructions. Provide a `requirements.txt` or Docker container. |
| 7 | **RULER groups have only 2 trajectories each** | LOW | ACKNOWLEDGED | Each duel produces exactly 2 trajectories (one per agent) sharing a `scenarioId`. RULER does relative scoring within groups — 2 is the minimum viable size. Scoring is effectively "winner vs loser" with no broader comparison. If RULER quality is poor, add synthetic groups by comparing across duels (requires Eliza adapter change). |
| 8 | **`@elizaos/core` is a transitive dependency of server** | MEDIUM | MITIGATED | `DuelCombatAI.ts` already type-imports `AgentRuntime` from `@elizaos/core`, but `ModelType` needs runtime import. Works today via `plugin-hyperscape` transitive resolution. Fix: either add `@elizaos/core` as direct dep or use string literal `"TEXT_SMALL"`. Plan code uses string literal approach. |
| 9 | **No `spawnSingleModelAgent()` exists yet** | MEDIUM | MITIGATED | `ModelAgentSpawner.ts` only has `spawnModelAgents(world)` which spawns all configured agents. Need to refactor to extract single-agent spawn logic (~20 lines). Plan specifies this as an explicit file change. |

---

## 8. Success Criteria (Realistic)

### Must-Have (Hackathon Demo)

1. **Agents make LLM-driven combat decisions** — `DuelCombatAI.useLlmTactics = true`, verified by seeing LLM call logs in trajectory JSON files.
2. **Every duel produces trajectory files** — JSON files appear in `$TRAJECTORY_OUTPUT_DIR` (default: `./training-data-output/trajectories/`) after each fight, with all 30+ `TrajectoryRecord` fields populated.
3. **Trajectories are viewable in Milady** — FineTuningView (existing) or DuelAnalyticsView shows trajectory data with combat metrics.
4. **At least one training job completes** — GRPO training runs on combat trajectories and produces adapter weights.
5. **Trained model loads in Ollama** — `ollama list` shows `hyperscape-combat-v1`.

### Nice-to-Have (Stretch)

6. **Trained model deployed to agents** — Agents restart with fine-tuned model and fight using it.
7. **Measurable behavior change** — Decision distribution of v2 differs from v1 (e.g., heals at lower HP, fewer idle ticks).
8. **DuelAnalyticsView with full replay** — Tick-by-tick decision viewer in Milady dashboard.
9. **Automated training trigger** — Training starts automatically after N duels without manual intervention.

### NOT Success Criteria (Avoid Overpromising)

- Model v2 has a higher win rate than v1. (May not happen with limited data.)
- Training completes in under 5 minutes. (Depends on hardware.)
- Zero manual steps in the pipeline. (Semi-automated is realistic.)

---

## 9. Implementation Order

Ordered by dependency chain. Each phase has a **concrete verification step** before moving on.

```
Phase 1: LLM Combat Decisions (2-3 days)
├── 1a: Pass runtime to DuelCombatAI from ModelAgentSpawner
│   └── VERIFY: Log runtime.character.settings.model in DuelCombatAI constructor
│
├── 1b: Implement getLlmDecision() with 400ms timeout
│   └── VERIFY: DuelCombatAI logs show "LLM chose ATTACK" / "LLM timeout, using rules"
│
├── 1c: Benchmark Ollama latency on target hardware
│   └── VERIFY: 10-prompt benchmark logs p50/p95 latency. BLOCKER if p95 > 600ms.
│
└── 1d: Full fight with LLM decisions
    └── VERIFY: Watch a streaming duel. Both agents make LLM calls per tick.

Phase 2: Trajectory Recording (1-2 days)
├── 2a: DuelTrajectoryRecorder with JSON output
│   └── VERIFY: After one duel, JSON file exists with correct structure
│
├── 2b: Reward function implementation
│   └── VERIFY: JSON file has non-zero per-tick rewards and terminal reward
│
└── 2c: Hook into StreamingDuelScheduler
    └── VERIFY: After 5 duels, 10 JSON files exist (2 per duel)

Phase 3: Training Pipeline (2-3 days)
├── 3a: Combat RULER rubric in Eliza
│   └── VERIFY: `getRubric("duel-combat")` returns the combat rubric string
│
├── 3b: Trajectory ingestion in Milady
│   └── VERIFY: Trajectories appear in Milady's FineTuningView trajectory list
│
├── 3c: GRPO training job
│   └── VERIFY: Training job starts, shows progress, completes without error
│
└── 3d: Model import to Ollama
    └── VERIFY: `ollama run hyperscape-combat-v1 "ATTACK or EAT?"` returns a response

Phase 4: Dashboard (1-2 days)
├── 4a: DuelAnalyticsView with leaderboard + fight history
│   └── VERIFY: View renders with real trajectory data
│
└── 4b: GameView overlay with model version
    └── VERIFY: Overlay shows current model tag during live duel

Phase 5: Model Deployment Loop (1-2 days)
├── 5a: Refactor ModelAgentSpawner to export spawnSingleModelAgent()
│   └── VERIFY: Can call spawnSingleModelAgent(world, config) for one agent without affecting others
│
├── 5b: Implement restartAgentWithModel() in StreamingDuelScheduler
│   └── VERIFY: Uses stopModelAgent(provider, model) + spawnSingleModelAgent(world, newConfig)
│
├── 5c: latest-model.json writer in training pipeline
│   └── VERIFY: File created after Ollama import
│
├── 5d: Scheduler reads latest-model.json and restarts agents
│   └── VERIFY: Agents restart with new model between cycles (during IDLE phase)
│
└── 5e: End-to-end test
    └── VERIFY: Full loop: fight → JSON → ingest → train → deploy → fight with new model
```

---

## 10. Resolved Questions

| Question | Answer | Basis |
|----------|--------|-------|
| How does Hyperscape import TrajectoryRecorder? | It doesn't. Writes JSON files to disk instead. | Version conflict: `@elizaos/core` `^2.0.0-alpha.2` vs `2.0.0-alpha.26` |
| How does ModelDeployer affect Hyperscape? | It doesn't directly. Model tag communicated via `latest-model.json` file. | `resetRuntime()` only clears Map cache, doesn't update model config |
| How does the trained model reach agents? | Agent restart with new `character.settings.model` pointing to Ollama tag. | `AgentRuntime` model is immutable after construction |
| How are rubrics selected for combat? | Via archetype `"duel-combat"` — trajectories set `archetype: "duel-combat"`, RULER calls `getRubric("duel-combat")`. | `RulerScoringService.ts` lines 469-477 |
| How do we stop/restart a single agent? | `stopModelAgent(provider, model)` exists but `spawnSingleAgent` does not. Must refactor `spawnModelAgents()` to extract single-agent logic into `spawnSingleModelAgent(world, config)`. Stop uses the `{provider}-{model}` key, found by scanning `getRunningAgents()` for matching `characterId`. | `ModelAgentSpawner.ts` lines 504-546, 386-498 |
| Can we filter training to only combat trajectories? | Via dedicated database (recommended) or archetype filter (requires Eliza change). | `getTrajectoryIdsForTraining()` has no archetype parameter |
| Where do LLM calls come from in DuelCombatAI? | `runtime.useModel(ModelType.TEXT_SMALL, { prompt })` — same pattern used in 6+ places in plugin-hyperscape. | `ai-helpers.ts` line 105, `autonomous-behavior-manager.ts` line 585 |

---

## 11. Open Questions (Remaining)

1. **Shared filesystem assumption** — For hackathon, all three repos run on the same machine. Trajectory directory is coordinated via `TRAJECTORY_OUTPUT_DIR` (Hyperscape) and `TRAJECTORY_WATCH_DIR` (Milady) env vars pointing to the same absolute path. For production, trajectory transfer needs rsync, S3, or an API endpoint. Which do we want?

2. **Ollama model for combat** — `Qwen3-4B-128K` is the Eliza default. For combat decisions (single token output), a smaller model like `Qwen3-1.7B` might be faster with equivalent quality. Worth benchmarking both.

3. **SFT vs GRPO for first iteration** — GRPO requires reward signals and comparison. SFT just needs input/output pairs. For hackathon speed, SFT might produce results faster with less data. The trajectory format supports both.
