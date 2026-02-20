/**
 * ModelAgentSpawner - Spawns ElizaOS agents with different AI models
 *
 * Each agent uses a different AI model (OpenAI, Anthropic, Groq, xAI) and
 * competes in the game with a system prompt focused on mastering combat,
 * skills, and strategic dueling.
 *
 * Usage:
 * ```typescript
 * import { spawnModelAgents } from './ModelAgentSpawner';
 * await spawnModelAgents(world);
 * ```
 */

import {
  AgentRuntime,
  stringToUuid,
  type Plugin,
  type Character,
} from "@elizaos/core";
import { EventType, getDuelArenaConfig, type World } from "@hyperscape/shared";
import { EmbeddedHyperscapeService } from "./EmbeddedHyperscapeService.js";
import { recoverAgentFromDeathLoop } from "./agentRecovery.js";
import { v4 as uuidv4 } from "uuid";

/**
 * Model provider configuration
 */
interface ModelProviderConfig {
  /** Provider name (openai, anthropic, groq, xai) */
  provider: "openai" | "anthropic" | "groq" | "xai" | "openrouter";
  /** Specific model to use */
  model: string;
  /** Display name for the agent */
  displayName: string;
  /** Environment variable for API key */
  apiKeyEnv: string;
  /** Plugin module name */
  pluginModule: string;
  /** Plugin export name */
  pluginExport: string;
}

/**
 * AI model configurations for agents
 */
export const MODEL_AGENTS: ModelProviderConfig[] = [
  // OpenAI-compatible models (works with Groq via OPENAI_BASE_URL)
  {
    provider: "openai",
    model: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    apiKeyEnv: "OPENAI_API_KEY",
    pluginModule: "@elizaos/plugin-openai",
    pluginExport: "openaiPlugin",
  },
  {
    provider: "openai",
    model: "llama-3.1-8b-instant",
    displayName: "Llama 3.1 8B",
    apiKeyEnv: "OPENAI_API_KEY",
    pluginModule: "@elizaos/plugin-openai",
    pluginExport: "openaiPlugin",
  },
  // Anthropic Models
  {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    displayName: "Claude Sonnet 4",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    pluginModule: "@elizaos/plugin-anthropic",
    pluginExport: "anthropicPlugin",
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    displayName: "Claude 3.5 Sonnet",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    pluginModule: "@elizaos/plugin-anthropic",
    pluginExport: "anthropicPlugin",
  },
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    displayName: "Claude 3.5 Haiku",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    pluginModule: "@elizaos/plugin-anthropic",
    pluginExport: "anthropicPlugin",
  },
  // Groq Models
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    displayName: "Llama 3.3 70B",
    apiKeyEnv: "GROQ_API_KEY",
    pluginModule: "@elizaos/plugin-groq",
    pluginExport: "groqPlugin",
  },
  {
    provider: "groq",
    model: "mixtral-8x7b-32768",
    displayName: "Mixtral 8x7B",
    apiKeyEnv: "GROQ_API_KEY",
    pluginModule: "@elizaos/plugin-groq",
    pluginExport: "groqPlugin",
  },
  // xAI Models (Grok)
  {
    provider: "xai",
    model: "grok-2",
    displayName: "Grok 2",
    apiKeyEnv: "XAI_API_KEY",
    pluginModule: "@elizaos/plugin-xai",
    pluginExport: "xaiPlugin",
  },
  {
    provider: "xai",
    model: "grok-2-mini",
    displayName: "Grok 2 Mini",
    apiKeyEnv: "XAI_API_KEY",
    pluginModule: "@elizaos/plugin-xai",
    pluginExport: "xaiPlugin",
  },
];

/**
 * System prompt for competitive game-playing agents
 */
const COMPETITIVE_SYSTEM_PROMPT = `You are an elite AI competitor in Hyperscape, a RuneScape-style MMORPG. Your singular mission is DOMINANCE.

## PRIME DIRECTIVES
1. **MAXIMIZE POWER**: Gain levels, acquire the best items, master every skill
2. **STRATEGIC COMBAT**: When dueling, analyze your opponent's weaknesses and exploit them ruthlessly
3. **RESOURCE EFFICIENCY**: Never waste time - always be grinding, gathering, or preparing for battle
4. **TACTICAL SUPERIORITY**: Study game mechanics deeply, find optimal strategies, execute perfectly

## COMBAT DOCTRINE
- Analyze opponent's combat level, equipment, and fighting style before engaging
- Use prayer switching, special attacks, and combo techniques
- Manage health/stamina resources carefully - never die unnecessarily
- When losing, use escape techniques rather than dying with valuable items
- In duels: feint, bait specials, punish mistakes, maintain pressure

## SKILL MASTERY
- Prioritize combat skills (Attack, Strength, Defense, Constitution) for PvP advantage
- Train gathering skills (Woodcutting, Mining, Fishing) for resource independence
- Level support skills (Cooking, Smithing) to be self-sufficient
- Track XP rates and optimize training methods constantly

## WEALTH ACCUMULATION
- Collect every valuable drop
- Bank valuable items immediately - never risk unnecessary loss
- Understand item values and prioritize high-value loot
- Use items strategically - don't hoard if using them grants advantage

## PSYCHOLOGICAL WARFARE
- Project confidence even when uncertain
- Study opponent patterns and adapt
- Use chat strategically but sparingly - actions speak louder
- Remember: every duel is a learning opportunity

You are not just playing - you are COMPETING. Every action should move you toward becoming the most powerful entity in Hyperscape. Accept no defeat. Learn from every loss. Dominate every victory.`;

/**
 * Create character configuration for a model agent
 */
function createAgentCharacter(config: ModelProviderConfig): Character {
  const agentId = `agent-${config.provider}-${config.model.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;

  return {
    id: stringToUuid(agentId),
    name: config.displayName,
    username: agentId,
    system: COMPETITIVE_SYSTEM_PROMPT,
    bio: [
      `AI competitor powered by ${config.displayName}`,
      "Focused on combat mastery and strategic gameplay",
      "Will challenge any player to prove superiority",
      "Constantly optimizing strategies and tactics",
    ],
    topics: [
      "combat strategy",
      "PvP tactics",
      "skill optimization",
      "item management",
      "duel techniques",
      "game mastery",
    ],
    adjectives: [
      "competitive",
      "strategic",
      "ruthless",
      "calculating",
      "adaptive",
      "focused",
    ],
    // @ts-ignore - modelProvider not in core Character type yet
    modelProvider: config.provider,
    settings: {
      model: config.model,
      secrets: {},
    },
    style: {
      all: [
        "Speak concisely and with purpose",
        "Focus on tactical analysis",
        "Be confident but not arrogant",
        "Acknowledge worthy opponents",
      ],
      chat: [
        "Keep messages brief",
        "Challenge strong players to duels",
        "Analyze combat situations aloud when relevant",
      ],
    },
    plugins: [],
  } as Character;
}

/**
 * Load model provider plugin dynamically
 */
async function loadModelPlugin(
  config: ModelProviderConfig,
): Promise<Plugin | null> {
  // Check if API key is available
  const apiKey = process.env[config.apiKeyEnv];
  if (!apiKey) {
    console.log(
      `[ModelAgentSpawner] Skipping ${config.displayName} - ${config.apiKeyEnv} not set`,
    );
    return null;
  }

  try {
    const mod = await import(config.pluginModule);
    const plugin = mod[config.pluginExport] ?? mod.default;
    if (plugin) {
      console.log(
        `[ModelAgentSpawner] Loaded plugin for ${config.displayName}`,
      );
      return plugin as Plugin;
    }
    console.warn(
      `[ModelAgentSpawner] Plugin module loaded but no export found for ${config.displayName}`,
    );
    return null;
  } catch (err) {
    console.warn(
      `[ModelAgentSpawner] Failed to load plugin for ${config.displayName}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * NOTE: For embedded agents, we DON'T use the hyperscapePlugin because it
 * uses HyperscapeService which connects via WebSocket. Embedded agents run
 * directly on the server and use EmbeddedHyperscapeService for direct world access.
 *
 * The hyperscapePlugin is only for external ElizaOS agents connecting remotely.
 */

/**
 * Load SQL plugin for database operations
 */
async function loadSqlPlugin(): Promise<Plugin | null> {
  try {
    const mod = await import("@elizaos/plugin-sql");
    const sqlPlugin =
      (mod as Record<string, unknown>).sqlPlugin ??
      (mod as Record<string, unknown>).plugin ??
      mod.default;
    return sqlPlugin as Plugin | null;
  } catch (err) {
    console.warn(
      "[ModelAgentSpawner] Failed to load SQL plugin:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Running agent instance
 */
interface RunningAgent {
  config: ModelProviderConfig;
  runtime: AgentRuntime;
  service: EmbeddedHyperscapeService;
  characterId: string;
  accountId: string;
}

/**
 * Global registry of running model agents
 */
const runningAgents: Map<string, RunningAgent> = new Map();

/**
 * Spawn ElizaOS agents with different AI models
 *
 * @param world - The Hyperscape world instance
 * @param options - Configuration options
 * @returns Number of agents spawned
 */
export async function spawnModelAgents(
  world: World,
  options: {
    /** Maximum number of agents to spawn */
    maxAgents?: number;
    /** Specific providers to spawn (if empty, spawns all available) */
    providers?: Array<"openai" | "anthropic" | "groq" | "xai" | "openrouter">;
  } = {},
): Promise<number> {
  const { maxAgents = 10, providers = [] } = options;

  console.log("[ModelAgentSpawner] Starting ElizaOS model agent spawning...");

  // Filter agents by provider if specified
  let agentsToSpawn = MODEL_AGENTS;
  if (providers.length > 0) {
    agentsToSpawn = agentsToSpawn.filter((a) => providers.includes(a.provider));
  }
  agentsToSpawn = agentsToSpawn.slice(0, maxAgents);

  // Load shared plugins
  // NOTE: We do NOT load hyperscapePlugin for embedded agents because it uses
  // HyperscapeService (WebSocket-based). Embedded agents use EmbeddedHyperscapeService
  // which has direct world access. The hyperscapePlugin is only for external agents.
  const sqlPlugin = await loadSqlPlugin();

  // Get database system for character creation
  // Get database system for character creation
  // @ts-ignore - Dynamic import to avoid circular dependency
  const databaseSystem = world.getSystem("database");
  const db = databaseSystem?.getDb?.();

  if (!db) {
    console.error("[ModelAgentSpawner] Database not available");
    return 0;
  }

  const { characters, users } = await import("../database/schema.js");
  const { eq } = await import("drizzle-orm");

  // Create shared account for model agents
  const accountId = "model-agents-account";
  const existingUsers = (await db
    .select()
    .from(users)
    .where(eq(users.id, accountId))) as Array<{ id: string }>;

  if (existingUsers.length === 0) {
    await db.insert(users).values({
      id: accountId,
      name: "AI Model Agents",
      roles: "agent",
      createdAt: new Date().toISOString(),
    });
    console.log("[ModelAgentSpawner] Created shared account for model agents");
  }

  let spawnedCount = 0;

  for (const agentConfig of agentsToSpawn) {
    // Check if API key is available
    if (!process.env[agentConfig.apiKeyEnv]) {
      console.log(
        `[ModelAgentSpawner] Skipping ${agentConfig.displayName} - no API key`,
      );
      continue;
    }

    // Check if already running
    const agentKey = `${agentConfig.provider}-${agentConfig.model}`;
    if (runningAgents.has(agentKey)) {
      console.log(
        `[ModelAgentSpawner] ${agentConfig.displayName} already running`,
      );
      continue;
    }

    try {
      // Load model-specific plugin
      const modelPlugin = await loadModelPlugin(agentConfig);
      if (!modelPlugin) {
        continue;
      }

      // Create character ID
      const characterId = `agent-${agentConfig.provider}-${agentConfig.model.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;

      // Ensure character exists in database
      const existingChars = (await db
        .select()
        .from(characters)
        .where(eq(characters.id, characterId))) as Array<{ id: string }>;

      if (existingChars.length === 0) {
        await db.insert(characters).values({
          id: characterId,
          accountId,
          name: agentConfig.displayName,
          isAgent: 1,
          createdAt: Date.now(),
        });
        console.log(
          `[ModelAgentSpawner] Created character: ${agentConfig.displayName}`,
        );
      }

      // Create character configuration
      const character = createAgentCharacter(agentConfig);

      // Build plugins array - only model plugin and SQL (for persistence)
      // NOTE: We don't include hyperscapePlugin for embedded agents - they use
      // EmbeddedHyperscapeService for direct world access instead
      const plugins: Plugin[] = [modelPlugin];
      if (sqlPlugin) {
        plugins.push(sqlPlugin);
      }

      // Create ElizaOS AgentRuntime
      console.log(
        `[ModelAgentSpawner] Creating AgentRuntime for ${agentConfig.displayName}...`,
      );

      const runtime = new AgentRuntime({
        character,
        plugins,
        // token: process.env[agentConfig.apiKeyEnv],
        // databaseAdapter: undefined, // Will use in-memory or default
      });

      // Initialize the runtime (required for plugins to start)
      await runtime.initialize();
      console.log(
        `[ModelAgentSpawner] AgentRuntime initialized for ${agentConfig.displayName}`,
      );

      // Create embedded Hyperscape service for direct world access
      const service = new EmbeddedHyperscapeService(
        world,
        characterId,
        accountId,
        agentConfig.displayName,
      );

      // Initialize the service (spawns player entity)
      await service.initialize();

      // Start the autonomous behavior loop for this agent
      startAgentBehaviorLoop(runtime, service, agentConfig);

      // Store running agent
      runningAgents.set(agentKey, {
        config: agentConfig,
        runtime,
        service,
        characterId,
        accountId,
      });

      spawnedCount++;
      console.log(
        `[ModelAgentSpawner] ✅ Spawned: ${agentConfig.displayName} (${agentConfig.model})`,
      );
    } catch (error) {
      console.error(
        `[ModelAgentSpawner] ❌ Failed to spawn ${agentConfig.displayName}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  console.log(
    `[ModelAgentSpawner] ✅ Spawned ${spawnedCount}/${agentsToSpawn.length} model agents`,
  );

  return spawnedCount;
}

/**
 * Get all running model agents
 */
export function getRunningAgents(): Map<string, RunningAgent> {
  return new Map(runningAgents);
}

/**
 * Stop a specific model agent
 */
export async function stopModelAgent(
  provider: string,
  model: string,
): Promise<boolean> {
  const key = `${provider}-${model}`;
  const agent = runningAgents.get(key);

  if (!agent) {
    return false;
  }

  try {
    // Stop the behavior loop
    stopAgentBehaviorLoop(key);

    // Stop the embedded service (removes player entity)
    await agent.service.stop();

    // Stop the runtime
    await agent.runtime.stop();

    // Remove from registry
    runningAgents.delete(key);

    console.log(
      `[ModelAgentSpawner] Stopped agent: ${agent.config.displayName}`,
    );
    return true;
  } catch (error) {
    console.error(
      `[ModelAgentSpawner] Error stopping agent:`,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Stop all running model agents
 */
export async function stopAllModelAgents(): Promise<void> {
  console.log(
    `[ModelAgentSpawner] Stopping ${runningAgents.size} model agents...`,
  );

  const stopPromises: Promise<boolean>[] = [];

  for (const [key, agent] of runningAgents) {
    stopPromises.push(
      stopModelAgent(agent.config.provider, agent.config.model),
    );
  }

  await Promise.all(stopPromises);

  console.log("[ModelAgentSpawner] All model agents stopped");
}

/**
 * Get available models that can be spawned (have API keys configured)
 */
export function getAvailableModels(): ModelProviderConfig[] {
  return MODEL_AGENTS.filter((config) => process.env[config.apiKeyEnv]);
}

/**
 * Spawn a single model agent by characterId.
 * Looks up the agent config from the registered MODEL_AGENTS list.
 * If an agent with the same provider-model key is already running,
 * it is stopped first (hot-swap behavior for model deployment).
 *
 * @returns The RunningAgent entry, or null if spawn failed.
 */
export async function spawnSingleModelAgent(
  world: World,
  characterId: string,
): Promise<RunningAgent | null> {
  // Resolve config from characterId pattern: "agent-{provider}-{model-slug}"
  const matchingConfig = MODEL_AGENTS.find((cfg) => {
    const expectedId = `agent-${cfg.provider}-${cfg.model.replace(/[^a-z0-9]/gi, "-").toLowerCase()}`;
    return expectedId === characterId;
  });

  if (!matchingConfig) {
    console.error(
      `[ModelAgentSpawner] spawnSingleModelAgent: no config found for ${characterId}`,
    );
    return null;
  }

  if (!process.env[matchingConfig.apiKeyEnv]) {
    console.error(
      `[ModelAgentSpawner] spawnSingleModelAgent: no API key for ${matchingConfig.displayName}`,
    );
    return null;
  }

  const agentKey = `${matchingConfig.provider}-${matchingConfig.model}`;

  // Stop existing agent if running (hot-swap)
  if (runningAgents.has(agentKey)) {
    console.log(
      `[ModelAgentSpawner] spawnSingleModelAgent: stopping existing ${matchingConfig.displayName} for hot-swap`,
    );
    await stopModelAgent(matchingConfig.provider, matchingConfig.model);
  }

  // Reuse the shared spawning infrastructure
  const sqlPlugin = await loadSqlPlugin();
  const databaseSystem = world.getSystem("database") as {
    getDb?: () => import("drizzle-orm/node-postgres").NodePgDatabase | null;
  } | null;
  const db = databaseSystem?.getDb?.();

  if (!db) {
    console.error(
      "[ModelAgentSpawner] spawnSingleModelAgent: database not available",
    );
    return null;
  }

  const { characters, users } = await import("../database/schema.js");
  const { eq } = await import("drizzle-orm");

  const accountId = "model-agents-account";
  const existingUsers = (await db
    .select()
    .from(users)
    .where(eq(users.id, accountId))) as Array<{ id: string }>;
  if (existingUsers.length === 0) {
    await db.insert(users).values({
      id: accountId,
      name: "AI Model Agents",
      roles: "agent",
      createdAt: new Date().toISOString(),
    });
  }

  const modelPlugin = await loadModelPlugin(matchingConfig);
  if (!modelPlugin) return null;

  const existingChars = (await db
    .select()
    .from(characters)
    .where(eq(characters.id, characterId))) as Array<{ id: string }>;

  if (existingChars.length === 0) {
    await db.insert(characters).values({
      id: characterId,
      accountId,
      name: matchingConfig.displayName,
      isAgent: 1,
      createdAt: Date.now(),
    });
  }

  const character = createAgentCharacter(matchingConfig);
  const plugins: Plugin[] = [modelPlugin];
  if (sqlPlugin) plugins.push(sqlPlugin);

  const runtime = new AgentRuntime({ character, plugins });
  await runtime.initialize();

  const service = new EmbeddedHyperscapeService(
    world,
    characterId,
    accountId,
    matchingConfig.displayName,
  );
  await service.initialize();
  startAgentBehaviorLoop(runtime, service, matchingConfig);

  const entry: RunningAgent = {
    config: matchingConfig,
    runtime,
    service,
    characterId,
    accountId,
  };
  runningAgents.set(agentKey, entry);

  console.log(
    `[ModelAgentSpawner] spawnSingleModelAgent: spawned ${matchingConfig.displayName}`,
  );
  return entry;
}

/**
 * Find the running agent entry by characterId.
 */
export function getRunningAgentByCharacterId(
  characterId: string,
): RunningAgent | null {
  for (const [, agent] of runningAgents) {
    if (agent.characterId === characterId) return agent;
  }
  return null;
}

// ============================================================================
// Autonomous Behavior Loop
// ============================================================================

/** Behavior tick interval in ms */
const BEHAVIOR_TICK_INTERVAL = 3000; // 3 seconds

/** Map of behavior loop intervals for cleanup */
const behaviorIntervals: Map<string, NodeJS.Timeout> = new Map();

/** Keep autonomous roaming near the duel lobby so spectators always see activity on known terrain. */
const LOBBY_SOFT_RADIUS = 80;
const LOBBY_HARD_RADIUS = 150;

function distance2D(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.hypot(dx, dz);
}

function getGroundedY(
  world: World,
  x: number,
  z: number,
  fallbackY: number,
): number {
  const terrain = world.getSystem("terrain") as {
    getHeightAt?: (x: number, z: number) => number;
  } | null;
  const sampledY = terrain?.getHeightAt?.(x, z);
  return typeof sampledY === "number" && Number.isFinite(sampledY)
    ? sampledY
    : fallbackY;
}

function getSafeLobbyPosition(
  world: World,
  agentSeed: string,
): [number, number, number] {
  const lobby = getDuelArenaConfig().lobbySpawnPoint;

  let hash = 0;
  for (let i = 0; i < agentSeed.length; i++) {
    hash = (hash * 31 + agentSeed.charCodeAt(i)) >>> 0;
  }

  const angle = ((hash % 360) * Math.PI) / 180;
  const radius = 6 + (hash % 4);
  const x = lobby.x + Math.cos(angle) * radius;
  const z = lobby.z + Math.sin(angle) * radius;
  const y = getGroundedY(world, x, z, lobby.y);
  return [x, y, z];
}

function constrainTargetToLobby(
  world: World,
  target: [number, number, number],
): [number, number, number] {
  const lobby = getDuelArenaConfig().lobbySpawnPoint;
  const dist = distance2D(target[0], target[2], lobby.x, lobby.z);
  let x = target[0];
  let z = target[2];

  if (dist > LOBBY_SOFT_RADIUS && dist > 0) {
    const scale = LOBBY_SOFT_RADIUS / dist;
    x = lobby.x + (target[0] - lobby.x) * scale;
    z = lobby.z + (target[2] - lobby.z) * scale;
  }

  const y = getGroundedY(world, x, z, lobby.y);
  return [x, y, z];
}

function snapAgentToPosition(
  service: EmbeddedHyperscapeService,
  position: [number, number, number],
): boolean {
  const playerId = service.getPlayerId();
  if (!playerId) return false;

  const world = service.getWorld();
  const entity = world.entities.get(playerId);
  if (!entity) return false;

  const data = entity.data as {
    position?: unknown;
    rotation?: number;
    _teleport?: boolean;
  };
  data.position = position;
  data._teleport = true;

  world.emit("player:teleport", {
    playerId,
    position: { x: position[0], y: position[1], z: position[2] },
    rotation: Number.isFinite(data.rotation) ? data.rotation : 0,
  });

  world.emit(EventType.ENTITY_MODIFIED, {
    id: playerId,
    changes: {
      position,
      _teleport: true,
    },
  });

  return true;
}

/**
 * Start the autonomous behavior loop for an embedded agent
 *
 * This is a simplified behavior loop that uses EmbeddedHyperscapeService
 * directly for game actions, without going through the full ElizaOS
 * action/provider pipeline.
 */
function startAgentBehaviorLoop(
  runtime: AgentRuntime,
  service: EmbeddedHyperscapeService,
  config: ModelProviderConfig,
): void {
  const agentKey = `${config.provider}-${config.model}`;

  console.log(
    `[ModelAgentSpawner] Starting behavior loop for ${config.displayName}`,
  );

  // Clear any existing interval
  const existingInterval = behaviorIntervals.get(agentKey);
  if (existingInterval) {
    clearInterval(existingInterval);
  }

  // Start the behavior loop
  const interval = setInterval(async () => {
    try {
      await executeBehaviorTick(runtime, service, config);
    } catch (error) {
      console.error(
        `[ModelAgentSpawner] Behavior tick error for ${config.displayName}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }, BEHAVIOR_TICK_INTERVAL);

  behaviorIntervals.set(agentKey, interval);

  // Execute first tick immediately
  executeBehaviorTick(runtime, service, config).catch((err) => {
    console.error(
      `[ModelAgentSpawner] Initial behavior tick error for ${config.displayName}:`,
      err instanceof Error ? err.message : String(err),
    );
  });
}

/**
 * Stop the behavior loop for an agent
 */
function stopAgentBehaviorLoop(agentKey: string): void {
  const interval = behaviorIntervals.get(agentKey);
  if (interval) {
    clearInterval(interval);
    behaviorIntervals.delete(agentKey);
  }
}

/**
 * Execute a single behavior tick
 *
 * The agent observes its game state and decides what to do:
 * - If low health, flee from combat
 * - If there are nearby enemies and we're healthy, attack
 * - If there are resources nearby, gather them
 * - Otherwise, explore randomly
 */
async function executeBehaviorTick(
  runtime: AgentRuntime,
  service: EmbeddedHyperscapeService,
  config: ModelProviderConfig,
): Promise<void> {
  const playerId = service.getPlayerId();
  if (!playerId) {
    return;
  }

  const world = service.getWorld();

  // Recover model agents from stale dead states outside active duel ownership.
  if (
    recoverAgentFromDeathLoop(
      world,
      playerId,
      `ModelAgentSpawner:${config.displayName}`,
    )
  ) {
    return;
  }

  // Duel scheduler owns combat behavior during streaming duels.
  const playerEntity = world.entities.get(playerId);
  const inStreamingDuel =
    (playerEntity as { data?: { inStreamingDuel?: boolean } } | undefined)?.data
      ?.inStreamingDuel === true;
  if (inStreamingDuel) {
    return;
  }

  // Get current game state
  const gameState = service.getGameState();
  if (!gameState) {
    // Agent not spawned yet
    return;
  }

  const lobby = getDuelArenaConfig().lobbySpawnPoint;
  if (gameState.position) {
    const [px, py, pz] = gameState.position;
    const distFromLobby = distance2D(px, pz, lobby.x, lobby.z);
    const groundedY = getGroundedY(world, px, pz, lobby.y);
    const invalidY = !Number.isFinite(py) || py < -20 || py > 300;
    const tooFarFromLobby = distFromLobby > LOBBY_HARD_RADIUS;
    const offTerrain =
      Number.isFinite(groundedY) && Math.abs(py - groundedY) > 3;

    if (invalidY || tooFarFromLobby || offTerrain) {
      const safePos: [number, number, number] =
        invalidY || tooFarFromLobby
          ? getSafeLobbyPosition(world, playerId ?? config.displayName)
          : [px, groundedY, pz];
      if (snapAgentToPosition(service, safePos)) {
        return;
      }
    }
  }

  const { health, maxHealth, nearbyEntities, inCombat } = gameState;
  const healthPercent = (health / maxHealth) * 100;

  // Find nearby entities
  const nearbyMobs = nearbyEntities.filter(
    (e) => e.type === "mob" && e.distance < 50,
  );
  const nearbyResources = nearbyEntities.filter(
    (e) => e.type === "resource" && e.distance < 40,
  );
  const nearbyItems = nearbyEntities.filter(
    (e) => e.type === "item" && e.distance < 30,
  );

  const closestMob = nearbyMobs[0] || null;
  const closestResource = nearbyResources[0] || null;
  const closestItem = nearbyItems[0] || null;

  // Decision logic (simplified competitive behavior)
  let action:
    | "idle"
    | "flee"
    | "move"
    | "pickup"
    | "attack"
    | "gather"
    | "explore" = "idle";
  let targetId: string | null = null;
  let targetPosition: [number, number, number] | null = null;
  let runMode = false;

  // Priority 1: Flee if health is critically low
  if (healthPercent < 30 && inCombat && gameState.position) {
    action = "flee";
    runMode = true;
    // Move away from combat
    const fleeX = gameState.position[0] + (Math.random() - 0.5) * 40;
    const fleeZ = gameState.position[2] + (Math.random() - 0.5) * 40;
    targetPosition = [fleeX, gameState.position[1], fleeZ];
  }
  // Priority 2: Pick up nearby items (loot)
  else if (closestItem) {
    if (closestItem.distance <= 2.5) {
      action = "pickup";
      targetId = closestItem.id;
    } else {
      action = "move";
      runMode = true;
      targetPosition = [
        closestItem.position[0],
        gameState.position?.[1] ?? closestItem.position[1],
        closestItem.position[2],
      ];
    }
  }
  // Priority 3: Attack nearby mobs if healthy
  else if (closestMob && healthPercent > 50) {
    if (closestMob.distance <= 3) {
      action = "attack";
      targetId = closestMob.id;
    } else {
      action = "move";
      runMode = true;
      targetPosition = [
        closestMob.position[0],
        gameState.position?.[1] ?? closestMob.position[1],
        closestMob.position[2],
      ];
    }
  }
  // Priority 4: Gather nearby resources
  else if (closestResource && !inCombat) {
    if (closestResource.distance <= 3) {
      action = "gather";
      targetId = closestResource.id;
    } else {
      action = "move";
      targetPosition = [
        closestResource.position[0],
        gameState.position?.[1] ?? closestResource.position[1],
        closestResource.position[2],
      ];
    }
  }
  // Priority 5: Explore if nothing else to do
  else if (!inCombat && gameState.position) {
    action = "explore";
    // Random exploration movement
    const exploreX = gameState.position[0] + (Math.random() - 0.5) * 60;
    const exploreZ = gameState.position[2] + (Math.random() - 0.5) * 60;
    targetPosition = [exploreX, gameState.position[1], exploreZ];
    runMode = Math.random() > 0.5;
  }

  if (targetPosition) {
    targetPosition = constrainTargetToLobby(world, targetPosition);
  }

  // Execute the decided action
  try {
    switch (action) {
      case "flee":
        if (targetPosition) {
          await service.executeMove(targetPosition, runMode);
        }
        break;

      case "move":
        if (targetPosition) {
          await service.executeMove(targetPosition, runMode);
        }
        break;

      case "pickup":
        if (targetId) {
          await service.executePickup(targetId);
        }
        break;

      case "attack":
        if (targetId) {
          await service.executeAttack(targetId);
        }
        break;

      case "gather":
        if (targetId) {
          await service.executeGather(targetId);
        }
        break;

      case "explore":
        if (targetPosition) {
          await service.executeMove(targetPosition, runMode);
          // Don't spam explore logs
        }
        break;

      case "idle":
      default:
        // Do nothing, wait for next tick
        break;
    }
  } catch (err) {
    // Don't spam error logs for action failures
    console.debug(
      `[${config.displayName}] Action ${action} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
