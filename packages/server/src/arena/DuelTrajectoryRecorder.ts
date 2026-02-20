/**
 * DuelTrajectoryRecorder — records combat trajectories to JSON files
 * compatible with Eliza's TrajectoryRecorder simulation mode output.
 *
 * One recorder instance per agent per duel. Hooks into DuelCombatAI
 * via the onTick callback and writes a single JSON file at duel end.
 *
 * Output format matches exactly:
 *   Omit<TrajectoryRecord, 'createdAt' | 'updatedAt'>
 *   (from eliza/packages/training/src/adapter.ts)
 */

import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import type {
  CombatTickSnapshot,
  CombatAction,
  LlmCallRecord,
} from "./DuelCombatAI";
import {
  computeTickReward,
  computeTerminalReward,
  type DuelOutcome,
} from "./DuelRewardCalculator";

// ─── Eliza-compatible types (replicated to avoid cross-repo import) ──

/**
 * Matches Eliza's TrajectoryStep shape.
 * See: eliza/packages/training/src/training/types.ts
 */
interface ElizaTrajectoryStep {
  stepNumber: number;
  timestamp: number;
  environmentState: {
    agentBalance: number;
    agentPnL: number;
    openPositions: number;
    // Combat-specific fields via index signature
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
  providerAccesses: never[];
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
    actionType: string;
    parameters: Record<string, unknown>;
    success: boolean;
    result: Record<string, unknown>;
  };
  reward: number;
}

/**
 * Matches the simulation mode JSON file structure:
 *   { trajectory: Omit<TrajectoryRecord, 'createdAt'|'updatedAt'>, llmCalls: [...] }
 */
interface ElizaTrajectoryFile {
  trajectory: {
    id: string;
    trajectoryId: string;
    agentId: string;
    archetype: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    windowId: string | null;
    windowHours: number;
    episodeId: string | null;
    scenarioId: string;
    batchId: string | null;
    stepsJson: string;
    rewardComponentsJson: string;
    metricsJson: string;
    metadataJson: string;
    totalReward: number;
    episodeLength: number;
    finalStatus: string;
    finalBalance: number | null;
    finalPnL: number | null;
    tradesExecuted: number | null;
    postsCreated: number | null;
    aiJudgeReward: number | null;
    aiJudgeReasoning: string | null;
    judgedAt: string | null;
    isTrainingData: boolean;
    isEvaluation: boolean;
    usedInTraining: boolean;
    trainedInBatch: string | null;
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

// ─── DuelTrajectoryRecorder ──────────────────────────────────────────

export class DuelTrajectoryRecorder {
  private agentId: string;
  private scenarioId: string;
  private trajectoryId: string;
  private startTime: number;
  private steps: ElizaTrajectoryStep[] = [];
  private llmCallsFlat: ElizaTrajectoryFile["llmCalls"] = [];
  private prevSnapshot: CombatTickSnapshot | null = null;
  private outputDir: string;
  private ended = false;

  constructor(agentId: string, cycleId: string, outputDir?: string) {
    this.agentId = agentId;
    this.scenarioId = `duel:${cycleId}`;
    this.trajectoryId = `duel-${cycleId}-${agentId}-${uuidv4().slice(0, 8)}`;
    this.startTime = Date.now();
    this.outputDir =
      outputDir ??
      process.env.TRAJECTORY_OUTPUT_DIR ??
      path.resolve(process.cwd(), "training-data-output", "trajectories");
  }

  /**
   * onTick callback — pass this to DuelCombatAI.setOnTick().
   * Arrow function to preserve `this` binding.
   */
  readonly recordTick = (snapshot: CombatTickSnapshot): void => {
    if (this.ended) return;

    const tickReward = computeTickReward(snapshot, this.prevSnapshot);
    this.prevSnapshot = snapshot;

    const step: ElizaTrajectoryStep = {
      stepNumber: snapshot.tickNumber,
      timestamp: snapshot.timestamp,
      environmentState: {
        agentBalance: 0,
        agentPnL: 0,
        openPositions: 0,
        healthPct: snapshot.healthPct,
        currentHealth: snapshot.currentHealth,
        maxHealth: snapshot.maxHealth,
        opponentHealthPct: snapshot.opponentHealthPct,
        opponentCurrentHealth: snapshot.opponentCurrentHealth,
        opponentMaxHealth: snapshot.opponentMaxHealth,
        foodCount: snapshot.foodCount,
        potionCount: snapshot.potionCount,
        combatPhase: snapshot.phase,
        tickNumber: snapshot.tickNumber,
        totalDamageDealt: snapshot.totalDamageDealt,
        totalDamageReceived: snapshot.totalDamageReceived,
        ticksSinceLastAttack: snapshot.ticksSinceLastAttack,
      },
      providerAccesses: [],
      llmCalls: snapshot.llmCall
        ? [
            {
              model: snapshot.llmCall.model,
              systemPrompt: "",
              userPrompt: snapshot.llmCall.prompt,
              response: snapshot.llmCall.response,
              temperature: 0.3,
              maxTokens: 10,
              latencyMs: snapshot.llmCall.latencyMs,
              purpose: "action" as const,
              actionType: snapshot.action,
            },
          ]
        : [],
      action: {
        actionType: snapshot.action,
        parameters: {
          source: snapshot.source,
          tickNumber: snapshot.tickNumber,
        },
        success: snapshot.actionSuccess,
        result: {
          healthPctAfter: snapshot.healthPct,
        },
      },
      reward: tickReward,
    };

    this.steps.push(step);

    // Accumulate flattened LLM calls for the top-level llmCalls array
    if (snapshot.llmCall) {
      this.llmCallsFlat.push({
        stepNumber: snapshot.tickNumber,
        callIndex: 0,
        model: snapshot.llmCall.model,
        systemPrompt: "",
        userPrompt: snapshot.llmCall.prompt,
        response: snapshot.llmCall.response,
        temperature: 0.3,
        maxTokens: 10,
        latencyMs: snapshot.llmCall.latencyMs,
        purpose: "action",
        actionType: snapshot.action,
      });
    }
  };

  /**
   * End the trajectory and write the JSON file to disk.
   * Call this when the duel resolves (win/loss/draw).
   */
  endDuel(outcome: DuelOutcome): string {
    if (this.ended) return "";
    this.ended = true;

    const endTime = Date.now();
    const durationMs = endTime - this.startTime;
    const shapingRewardSum = this.steps.reduce((s, step) => s + step.reward, 0);
    const terminal = computeTerminalReward(outcome);
    const totalReward = shapingRewardSum + terminal.total;

    const errorCount = this.steps.filter((s) => !s.action.success).length;
    const finalStatus = errorCount > 0 ? "completed_with_errors" : "completed";

    const fileData: ElizaTrajectoryFile = {
      trajectory: {
        id: uuidv4(),
        trajectoryId: this.trajectoryId,
        agentId: this.agentId,
        archetype: "duel-combat",
        startTime: new Date(this.startTime).toISOString(),
        endTime: new Date(endTime).toISOString(),
        durationMs,
        windowId: null,
        windowHours: 1,
        episodeId: `${this.scenarioId}-${endTime}`,
        scenarioId: this.scenarioId,
        batchId: null,
        stepsJson: JSON.stringify(this.steps),
        rewardComponentsJson: JSON.stringify({
          environmentReward: shapingRewardSum,
          terminalReward: terminal.total,
          ...terminal.components,
        }),
        metricsJson: JSON.stringify({
          episodeLength: this.steps.length,
          finalStatus,
          won: outcome.won,
          damageDealt: outcome.damageDealt,
          damageReceived: outcome.damageReceived,
          healsUsed: this.steps.filter(
            (s) => s.action.actionType === "EAT" && s.action.success,
          ).length,
          attacksLanded: this.steps.filter(
            (s) => s.action.actionType === "ATTACK" && s.action.success,
          ).length,
          foodRemaining: outcome.foodRemaining,
          tickCount: outcome.tickCount,
          errorCount,
          finalBalance: null,
          finalPnL: null,
          tradesExecuted: 0,
          postsCreated: 0,
        }),
        metadataJson: JSON.stringify({
          isTrainingData: true,
          gameKnowledge: {},
          combatMetadata: {
            scenarioId: this.scenarioId,
            agentId: this.agentId,
            maxTicks: outcome.maxTicks,
            foodStarted: outcome.foodStarted,
          },
        }),
        totalReward,
        episodeLength: this.steps.length,
        finalStatus,
        finalBalance: null,
        finalPnL: null,
        tradesExecuted: null,
        postsCreated: null,
        aiJudgeReward: null,
        aiJudgeReasoning: null,
        judgedAt: null,
        isTrainingData: true,
        isEvaluation: false,
        usedInTraining: false,
        trainedInBatch: null,
      },
      llmCalls: this.llmCallsFlat,
    };

    // Write file
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    const filePath = path.join(this.outputDir, `${this.trajectoryId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2));

    console.log(
      `[DuelTrajectoryRecorder] Saved trajectory ${this.trajectoryId} ` +
        `(${this.steps.length} steps, reward: ${totalReward.toFixed(3)}, won: ${outcome.won}) → ${filePath}`,
    );

    return filePath;
  }

  getTrajectoryId(): string {
    return this.trajectoryId;
  }

  getStepCount(): number {
    return this.steps.length;
  }
}
