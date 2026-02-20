/**
 * DuelCombatAI - Tick-based PvP combat controller for embedded agents
 *
 * Takes over an agent's behavior during arena duels. Uses
 * EmbeddedHyperscapeService directly for game actions (executeAttack,
 * executeUse). Reads game state each tick and makes priority-based
 * combat decisions: heal, attack, or switch style.
 *
 * When useLlmTactics is enabled and an AgentRuntime is available,
 * each tick queries the agent's LLM for a combat action before
 * falling back to the rule-based priority system. The LLM call has
 * a hard timeout (LLM_TIMEOUT_MS) to prevent stalling combat.
 *
 * Lifecycle:
 *   ArenaService creates DuelCombatAI when a duel starts.
 *   DuelCombatAI.start() begins ticking at COMBAT_TICK_MS (600ms).
 *   ArenaService calls DuelCombatAI.stop() when the duel ends.
 */

import { TICK_DURATION_MS } from "@hyperscape/shared";
import type { EmbeddedHyperscapeService } from "../eliza/EmbeddedHyperscapeService";
import type { EmbeddedGameState } from "../eliza/types";
import type { AgentRuntime } from "@elizaos/core";

// ─── Types ───────────────────────────────────────────────────────────────

export interface DuelCombatConfig {
  healThresholdPct: number;
  aggressiveThresholdPct: number;
  defensiveThresholdPct: number;
  maxTicksWithoutAttack: number;
  useLlmTactics: boolean;
}

const DEFAULT_CONFIG: DuelCombatConfig = {
  healThresholdPct: 40,
  aggressiveThresholdPct: 70,
  defensiveThresholdPct: 30,
  maxTicksWithoutAttack: 5,
  useLlmTactics: false,
};

export type CombatAction =
  | "ATTACK"
  | "EAT"
  | "DRINK_POTION"
  | "SWITCH_AGGRESSIVE"
  | "SWITCH_DEFENSIVE";

export type CombatPhase = "opening" | "trading" | "finishing" | "desperate";

/** Recorded LLM call data — exposed for trajectory recording. */
export interface LlmCallRecord {
  prompt: string;
  response: string;
  latencyMs: number;
  model: string;
  timedOut: boolean;
}

/**
 * Per-tick snapshot exposed to the trajectory recorder.
 * Everything needed to reconstruct a training sample.
 */
export interface CombatTickSnapshot {
  tickNumber: number;
  timestamp: number;
  healthPct: number;
  currentHealth: number;
  maxHealth: number;
  opponentHealthPct: number;
  opponentCurrentHealth: number;
  opponentMaxHealth: number;
  foodCount: number;
  potionCount: number;
  phase: CombatPhase;
  totalDamageDealt: number;
  totalDamageReceived: number;
  ticksSinceLastAttack: number;
  action: CombatAction;
  actionSuccess: boolean;
  llmCall: LlmCallRecord | null;
  source: "llm" | "rules";
}

// ─── Constants ───────────────────────────────────────────────────────────

/** Hard cap on how long we wait for the LLM before falling back to rules. */
const LLM_TIMEOUT_MS = 400;

const FOOD_PATTERNS = [
  "shrimp",
  "trout",
  "salmon",
  "lobster",
  "swordfish",
  "shark",
  "monkfish",
  "bread",
  "meat",
  "cooked",
  "fish",
  "pie",
  "cake",
  "stew",
  "potato",
  "tuna",
  "bass",
  "karambwan",
  "manta",
  "anglerfish",
];

const POTION_PATTERNS = [
  "potion",
  "brew",
  "restore",
  "prayer",
  "super",
  "ranging",
  "magic",
  "antifire",
  "antidote",
  "stamina",
];

// ─── Callback type for trajectory recording ──────────────────────────────

export type OnTickCallback = (snapshot: CombatTickSnapshot) => void;

// ─── DuelCombatAI ────────────────────────────────────────────────────────

export class DuelCombatAI {
  private service: EmbeddedHyperscapeService;
  private runtime: AgentRuntime | null;
  private opponentId: string;
  private config: DuelCombatConfig;

  private tickTimer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private tickCount = 0;
  private ticksSinceLastAttack = 0;
  private lastHealthPct = 100;
  private opponentLastHealthPct = 100;
  private totalDamageDealt = 0;
  private totalDamageReceived = 0;
  private healsUsed = 0;
  private attacksLanded = 0;

  private llmCallCount = 0;
  private llmTimeoutCount = 0;
  private llmErrorCount = 0;
  private rulesFallbackCount = 0;

  /** Optional per-tick callback for trajectory recording. */
  private onTick: OnTickCallback | null = null;

  constructor(
    service: EmbeddedHyperscapeService,
    opponentId: string,
    config?: Partial<DuelCombatConfig>,
    runtime?: AgentRuntime,
  ) {
    this.service = service;
    this.opponentId = opponentId;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.runtime = runtime ?? null;
  }

  /** Register a per-tick callback (used by DuelTrajectoryRecorder). */
  setOnTick(cb: OnTickCallback): void {
    this.onTick = cb;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.tickCount = 0;
    this.ticksSinceLastAttack = 0;
    this.totalDamageDealt = 0;
    this.totalDamageReceived = 0;
    this.healsUsed = 0;
    this.attacksLanded = 0;
    this.llmCallCount = 0;
    this.llmTimeoutCount = 0;
    this.llmErrorCount = 0;
    this.rulesFallbackCount = 0;

    const modelName =
      this.runtime && "character" in this.runtime
        ? ((
            this.runtime as AgentRuntime & {
              character?: { settings?: { model?: string } };
            }
          ).character?.settings?.model ?? "unknown")
        : "none";
    console.log(
      `[DuelCombatAI] Started combat against ${this.opponentId} | LLM: ${this.config.useLlmTactics} | Model: ${modelName}`,
    );

    this.tickTimer = setInterval(() => {
      this.tick().catch((err) => {
        console.error(
          "[DuelCombatAI] Tick error:",
          err instanceof Error ? err.message : String(err),
        );
      });
    }, TICK_DURATION_MS);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }

    console.log(
      `[DuelCombatAI] Stopped after ${this.tickCount} ticks. ` +
        `Attacks: ${this.attacksLanded}, Heals: ${this.healsUsed}, ` +
        `Dmg dealt: ${this.totalDamageDealt}, Dmg received: ${this.totalDamageReceived} | ` +
        `LLM calls: ${this.llmCallCount}, timeouts: ${this.llmTimeoutCount}, errors: ${this.llmErrorCount}, rules fallback: ${this.rulesFallbackCount}`,
    );
  }

  getStats(): {
    tickCount: number;
    attacksLanded: number;
    healsUsed: number;
    totalDamageDealt: number;
    totalDamageReceived: number;
    llmCallCount: number;
    llmTimeoutCount: number;
    llmErrorCount: number;
    rulesFallbackCount: number;
  } {
    return {
      tickCount: this.tickCount,
      attacksLanded: this.attacksLanded,
      healsUsed: this.healsUsed,
      totalDamageDealt: this.totalDamageDealt,
      totalDamageReceived: this.totalDamageReceived,
      llmCallCount: this.llmCallCount,
      llmTimeoutCount: this.llmTimeoutCount,
      llmErrorCount: this.llmErrorCount,
      rulesFallbackCount: this.rulesFallbackCount,
    };
  }

  // ─── Core tick loop ──────────────────────────────────────────────────

  private async tick(): Promise<void> {
    if (!this.isRunning) return;
    this.tickCount++;

    const state = this.service.getGameState();
    if (!state) return;
    if (!state.alive) {
      this.stop();
      return;
    }

    // Track damage
    const healthPct =
      state.maxHealth > 0 ? (state.health / state.maxHealth) * 100 : 100;

    const damageThisTick = this.lastHealthPct - healthPct;
    if (damageThisTick > 0) {
      this.totalDamageReceived += Math.round(
        (damageThisTick / 100) * state.maxHealth,
      );
    }
    this.lastHealthPct = healthPct;

    const opponentData = this.getOpponentData(state);
    if (opponentData) {
      const oppHealthPct =
        opponentData.maxHealth > 0
          ? (opponentData.health / opponentData.maxHealth) * 100
          : 100;
      const oppDamage = this.opponentLastHealthPct - oppHealthPct;
      if (oppDamage > 0 && opponentData.maxHealth) {
        this.totalDamageDealt += Math.round(
          (oppDamage / 100) * opponentData.maxHealth,
        );
      }
      this.opponentLastHealthPct = oppHealthPct;
    }

    const phase = this.determineCombatPhase(healthPct, opponentData);
    const foodCount = this.countFood(state.inventory);
    const potionCount = this.countPotions(state.inventory);

    // LLM decision path
    let action: CombatAction | null = null;
    let llmCall: LlmCallRecord | null = null;
    let source: "llm" | "rules" = "rules";

    if (this.config.useLlmTactics && this.runtime) {
      const result = await this.getLlmDecision(
        state,
        healthPct,
        phase,
        opponentData,
        foodCount,
        potionCount,
      );
      if (result) {
        action = result.action;
        llmCall = result.llmCall;
        source = "llm";
      } else {
        this.rulesFallbackCount++;
      }
    }

    // Rule-based fallback
    if (!action) {
      action = this.getRuleBasedAction(state, healthPct, phase);
    }

    // Execute the chosen action
    const actionSuccess = await this.executeAction(action, state);

    // Notify trajectory recorder
    if (this.onTick) {
      this.onTick({
        tickNumber: this.tickCount,
        timestamp: Date.now(),
        healthPct,
        currentHealth: state.health,
        maxHealth: state.maxHealth,
        opponentHealthPct: opponentData
          ? opponentData.maxHealth > 0
            ? (opponentData.health / opponentData.maxHealth) * 100
            : 100
          : -1,
        opponentCurrentHealth: opponentData?.health ?? 0,
        opponentMaxHealth: opponentData?.maxHealth ?? 0,
        foodCount,
        potionCount,
        phase,
        totalDamageDealt: this.totalDamageDealt,
        totalDamageReceived: this.totalDamageReceived,
        ticksSinceLastAttack: this.ticksSinceLastAttack,
        action,
        actionSuccess,
        llmCall,
        source,
      });
    }
  }

  // ─── LLM decision ───────────────────────────────────────────────────

  private async getLlmDecision(
    state: EmbeddedGameState,
    healthPct: number,
    phase: CombatPhase,
    opponentData: OpponentData | null,
    foodCount: number,
    potionCount: number,
  ): Promise<{ action: CombatAction; llmCall: LlmCallRecord } | null> {
    if (!this.runtime) return null;

    const oppHealthPct =
      opponentData && opponentData.maxHealth > 0
        ? Math.round((opponentData.health / opponentData.maxHealth) * 100)
        : -1;

    const prompt = [
      `COMBAT TICK ${this.tickCount} | Phase: ${phase}`,
      `Your HP: ${Math.round(healthPct)}% (${state.health}/${state.maxHealth})`,
      `Opponent HP: ${oppHealthPct >= 0 ? `${oppHealthPct}%` : "unknown"}`,
      `Food: ${foodCount} | Potions: ${potionCount}`,
      `Damage dealt: ${this.totalDamageDealt} | Damage taken: ${this.totalDamageReceived}`,
      `Ticks without attack: ${this.ticksSinceLastAttack}`,
      ``,
      `Choose ONE action: ATTACK | EAT | DRINK_POTION | SWITCH_AGGRESSIVE | SWITCH_DEFENSIVE`,
      `Reply with ONLY the action name.`,
    ].join("\n");

    const startMs = Date.now();
    this.llmCallCount++;

    // Race the LLM call against a hard timeout.
    // This is NOT defensive programming — it's a hard real-time constraint.
    // Without it, a slow provider stalls the entire combat tick pipeline.
    const timeoutPromise = new Promise<"__TIMEOUT__">((resolve) =>
      setTimeout(() => resolve("__TIMEOUT__"), LLM_TIMEOUT_MS),
    );

    let rawResponse: string | "__TIMEOUT__";
    try {
      rawResponse = (await Promise.race([
        this.runtime.useModel(
          "TEXT_SMALL" as const,
          {
            prompt,
            maxTokens: 10,
            temperature: 0.3,
          } as Parameters<typeof this.runtime.useModel>[1],
        ),
        timeoutPromise,
      ])) as string | "__TIMEOUT__";
    } catch {
      this.llmErrorCount++;
      return null;
    }

    const latencyMs = Date.now() - startMs;

    if (rawResponse === "__TIMEOUT__") {
      this.llmTimeoutCount++;
      return null;
    }

    const text = (
      typeof rawResponse === "string"
        ? rawResponse
        : ((rawResponse as { text?: string }).text ?? String(rawResponse))
    )
      .trim()
      .toUpperCase();

    const modelName =
      "character" in this.runtime
        ? ((
            this.runtime as AgentRuntime & {
              character?: { settings?: { model?: string } };
            }
          ).character?.settings?.model ?? "unknown")
        : "unknown";

    const llmCall: LlmCallRecord = {
      prompt,
      response: text,
      latencyMs,
      model: modelName,
      timedOut: false,
    };

    const action = this.parseLlmAction(text);
    return { action, llmCall };
  }

  private parseLlmAction(text: string): CombatAction {
    if (text.includes("EAT")) return "EAT";
    if (text.includes("DRINK") || text.includes("POTION"))
      return "DRINK_POTION";
    if (text.includes("AGGRESSIVE")) return "SWITCH_AGGRESSIVE";
    if (text.includes("DEFENSIVE")) return "SWITCH_DEFENSIVE";
    return "ATTACK";
  }

  // ─── Rule-based fallback ────────────────────────────────────────────

  private getRuleBasedAction(
    state: EmbeddedGameState,
    healthPct: number,
    phase: CombatPhase,
  ): CombatAction {
    // Heal check
    const healThreshold =
      phase === "desperate"
        ? this.config.healThresholdPct + 15
        : this.config.healThresholdPct;

    if (healthPct < healThreshold && this.findBestFood(state.inventory)) {
      return "EAT";
    }

    // Buff check (opening phase only, first 2 ticks)
    if (
      phase === "opening" &&
      this.tickCount <= 2 &&
      this.findPotion(state.inventory)
    ) {
      return "DRINK_POTION";
    }

    return "ATTACK";
  }

  // ─── Action execution ──────────────────────────────────────────────

  private async executeAction(
    action: CombatAction,
    state: EmbeddedGameState,
  ): Promise<boolean> {
    switch (action) {
      case "EAT": {
        const food = this.findBestFood(state.inventory);
        if (food) {
          try {
            await this.service.executeUse(food.itemId);
            this.healsUsed++;
            return true;
          } catch {
            // Food item may have been consumed between state read and execution
            return false;
          }
        }
        // No food available — attack instead
        return this.executeAttackOnOpponent();
      }

      case "DRINK_POTION": {
        const potion = this.findPotion(state.inventory);
        if (potion) {
          try {
            await this.service.executeUse(potion.itemId);
            return true;
          } catch {
            return false;
          }
        }
        return this.executeAttackOnOpponent();
      }

      case "ATTACK":
        return this.executeAttackOnOpponent();

      case "SWITCH_AGGRESSIVE":
      case "SWITCH_DEFENSIVE":
        // Combat style switching not yet wired in the game engine.
        // Execute an attack so the agent isn't idle.
        return this.executeAttackOnOpponent();
    }
  }

  private async executeAttackOnOpponent(): Promise<boolean> {
    this.ticksSinceLastAttack++;
    try {
      await this.service.executeAttack(this.opponentId);
      this.ticksSinceLastAttack = 0;
      this.attacksLanded++;
      return true;
    } catch {
      // Opponent may be dead or out of range between state check and attack
      return false;
    }
  }

  // ─── Combat phase ──────────────────────────────────────────────────

  private determineCombatPhase(
    healthPct: number,
    opponentData: OpponentData | null,
  ): CombatPhase {
    if (healthPct < this.config.defensiveThresholdPct) return "desperate";

    const oppHealthPct = opponentData
      ? opponentData.maxHealth > 0
        ? (opponentData.health / opponentData.maxHealth) * 100
        : 100
      : 100;

    if (oppHealthPct < 25) return "finishing";
    if (this.tickCount < 5) return "opening";
    return "trading";
  }

  // ─── Inventory helpers ─────────────────────────────────────────────

  private getOpponentData(state: EmbeddedGameState): OpponentData | null {
    const opp = state.nearbyEntities.find((e) => e.id === this.opponentId);
    if (!opp) return null;
    return {
      health: opp.health ?? 0,
      maxHealth: opp.maxHealth ?? 0,
      distance: opp.distance,
    };
  }

  private findBestFood(
    inventory: EmbeddedGameState["inventory"],
  ): InventorySlot | null {
    for (const item of inventory) {
      const name = (item.itemId || "").toLowerCase();
      if (FOOD_PATTERNS.some((pattern) => name.includes(pattern))) {
        return item;
      }
    }
    return null;
  }

  private findPotion(
    inventory: EmbeddedGameState["inventory"],
  ): InventorySlot | null {
    for (const item of inventory) {
      const name = (item.itemId || "").toLowerCase();
      if (POTION_PATTERNS.some((pattern) => name.includes(pattern))) {
        return item;
      }
    }
    return null;
  }

  private countFood(inventory: EmbeddedGameState["inventory"]): number {
    let count = 0;
    for (const item of inventory) {
      const name = (item.itemId || "").toLowerCase();
      if (FOOD_PATTERNS.some((pattern) => name.includes(pattern))) {
        count++;
      }
    }
    return count;
  }

  private countPotions(inventory: EmbeddedGameState["inventory"]): number {
    let count = 0;
    for (const item of inventory) {
      const name = (item.itemId || "").toLowerCase();
      if (POTION_PATTERNS.some((pattern) => name.includes(pattern))) {
        count++;
      }
    }
    return count;
  }
}

interface OpponentData {
  health: number;
  maxHealth: number;
  distance: number;
}

type InventorySlot = EmbeddedGameState["inventory"][number];
