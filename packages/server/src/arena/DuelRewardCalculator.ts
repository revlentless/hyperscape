/**
 * DuelRewardCalculator — computes per-tick shaping rewards and
 * end-of-duel terminal rewards for combat trajectory training.
 *
 * Reward design:
 *   Per-tick shaping rewards are small signals that guide learning
 *   during the episode. Terminal rewards are large signals assigned
 *   once at duel end and backpropagated to every step.
 */

import type { CombatTickSnapshot } from "./DuelCombatAI";

// ─── Shaping reward weights ──────────────────────────────────────────

const REWARD_ATTACK_LANDED = 0.1;
const REWARD_HEAL_GOOD = 0.2; // ate food when HP < 40%
const REWARD_HEAL_WASTEFUL = -0.1; // ate food when HP > 70%
const REWARD_NO_ACTION = -0.05; // action failed (timeout/error)
const REWARD_TICK_SURVIVED = 0.01;

// ─── Terminal reward component weights ───────────────────────────────

const W_WIN_LOSS = 0.4;
const W_DAMAGE_EFFICIENCY = 0.2;
const W_FOOD_CONSERVATION = 0.15;
const W_KILL_SPEED = 0.15;
const W_SURVIVAL = 0.1;

// ─── Per-tick shaping ────────────────────────────────────────────────

export function computeTickReward(
  snapshot: CombatTickSnapshot,
  prevSnapshot: CombatTickSnapshot | null,
): number {
  let reward = REWARD_TICK_SURVIVED;

  if (!snapshot.actionSuccess) {
    reward += REWARD_NO_ACTION;
    return reward;
  }

  // Opponent took damage this tick (our attack landed)
  if (prevSnapshot) {
    const damageIncrease =
      snapshot.totalDamageDealt - prevSnapshot.totalDamageDealt;
    if (damageIncrease > 0 && snapshot.action === "ATTACK") {
      reward += REWARD_ATTACK_LANDED;
    }
  }

  // Eating evaluation
  if (snapshot.action === "EAT") {
    if (snapshot.healthPct < 40) {
      reward += REWARD_HEAL_GOOD;
    } else if (snapshot.healthPct > 70) {
      reward += REWARD_HEAL_WASTEFUL;
    }
  }

  return reward;
}

// ─── Terminal reward ─────────────────────────────────────────────────

export interface DuelOutcome {
  won: boolean;
  finalHealthPct: number;
  damageDealt: number;
  damageReceived: number;
  foodRemaining: number;
  foodStarted: number;
  tickCount: number;
  maxTicks: number;
}

export function computeTerminalReward(outcome: DuelOutcome): {
  total: number;
  components: {
    winLoss: number;
    damageEfficiency: number;
    foodConservation: number;
    killSpeed: number;
    survival: number;
  };
} {
  // Win/Loss: +1.0 for win, -0.5 for loss
  const winLossRaw = outcome.won ? 1.0 : -0.5;
  const winLoss = winLossRaw * W_WIN_LOSS;

  // Damage efficiency: dealt / max(received, 1), clamped to [0, 1]
  const efficiencyRatio =
    outcome.damageDealt / Math.max(outcome.damageReceived, 1);
  const damageEfficiency = Math.min(efficiencyRatio, 1.0) * W_DAMAGE_EFFICIENCY;

  // Food conservation: how much food is left
  const foodRatio =
    outcome.foodStarted > 0 ? outcome.foodRemaining / outcome.foodStarted : 1.0;
  const foodConservation = foodRatio * W_FOOD_CONSERVATION;

  // Kill speed: faster wins are better
  const speedRatio =
    outcome.maxTicks > 0 ? 1.0 - outcome.tickCount / outcome.maxTicks : 0;
  const killSpeed = Math.max(speedRatio, 0) * W_KILL_SPEED;

  // Survival: HP remaining at fight end
  const survival = (outcome.finalHealthPct / 100) * W_SURVIVAL;

  const total =
    winLoss + damageEfficiency + foodConservation + killSpeed + survival;

  return {
    total,
    components: {
      winLoss,
      damageEfficiency,
      foodConservation,
      killSpeed,
      survival,
    },
  };
}
