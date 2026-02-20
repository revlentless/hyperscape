import { createPublicClient, http } from "viem";
import { foundry } from "viem/chains";
import { spawn, execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import net from "net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(__dirname, "../../../");
const contractsDir = path.join(workspaceRoot, "packages/contracts");
const worldsJsonPath = path.join(contractsDir, "worlds.json");
const serverEnvPath = path.join(workspaceRoot, "packages/server/.env");

const ANVIL_PORT = 8545;
const ANVIL_HOST = "127.0.0.1";

const colors = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    blue: "\x1b[34m",
    cyan: "\x1b[36m",
};

function log(msg, color = colors.reset) {
    console.log(`${color}[ChainSetup] ${msg}${colors.reset}`);
}

async function isPortInUse(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(500);
        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("timeout", () => {
            socket.destroy();
            resolve(false);
        });
        socket.on("error", () => {
            resolve(false);
        });
        socket.connect(port, ANVIL_HOST);
    });
}

function isAnvilInstalled() {
    try {
        execSync("which anvil", { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

async function startAnvil() {
    if (!isAnvilInstalled()) {
        log("Anvil not installed — skipping blockchain setup. Install Foundry to enable.", colors.yellow);
        return false;
    }

    log("Anvil is not running. Starting Anvil...", colors.yellow);

    const anvil = spawn("anvil", ["--block-time", "1"], {
        detached: true,
        stdio: "ignore",
    });

    anvil.unref();

    log("Waiting for Anvil to be ready...", colors.yellow);

    let retries = 0;
    while (retries < 20) {
        if (await isPortInUse(ANVIL_PORT)) {
            log("Anvil started successfully.", colors.green);
            return true;
        }
        await new Promise((r) => setTimeout(r, 500));
        retries++;
    }

    log("Anvil did not start within timeout.", colors.yellow);
    return false;
}

function getWorldAddressFromConfig() {
    if (!fs.existsSync(worldsJsonPath)) return null;
    try {
        const data = JSON.parse(fs.readFileSync(worldsJsonPath, "utf-8"));
        return data["31337"]?.address;
    } catch (e) {
        return null;
    }
}

function updateServerEnv(address) {
    if (!fs.existsSync(serverEnvPath)) {
        log("Server .env not found, skipping update.", colors.yellow);
        return;
    }

    let envContent = fs.readFileSync(serverEnvPath, "utf-8");
    const regex = /^WORLD_ADDRESS=.*$/m;

    if (regex.test(envContent)) {
        const currentMatch = envContent.match(regex);
        if (currentMatch[0].includes(address)) {
            // Already matches
            return;
        }
        log(`Updating WORLD_ADDRESS in .env to ${address}`, colors.cyan);
        envContent = envContent.replace(regex, `WORLD_ADDRESS=${address}`);
    } else {
        log(`Adding WORLD_ADDRESS to .env: ${address}`, colors.cyan);
        envContent += `\nWORLD_ADDRESS=${address}\n`;
    }

    fs.writeFileSync(serverEnvPath, envContent);
}

async function deployContracts() {
    log("Deploying contracts...", colors.blue);

    return new Promise((resolve, reject) => {
        // specific command to run local deployment
        const child = spawn("pnpm", ["run", "deploy:local"], {
            cwd: contractsDir,
            stdio: "inherit",
            env: { ...process.env, PATH: process.env.PATH }
        });

        child.on("error", (err) => {
            log(`Deployment failed to start: ${err.message}`, colors.red);
            reject(err);
        });

        child.on("exit", (code) => {
            if (code === 0) {
                log("Contracts deployed successfully.", colors.green);
                resolve();
            } else {
                log(`Deployment failed with code ${code}`, colors.red);
                reject(new Error(`Deployment failed with code ${code}`));
            }
        });
    });
}

async function checkAndSetup() {
    if (process.env.SKIP_CHAIN_SETUP === "1" || process.env.SKIP_CHAIN_SETUP === "true") {
        log("Skipping chain setup (SKIP_CHAIN_SETUP=1)", colors.yellow);
        return;
    }
    try {
        // 1. Check Anvil
        if (!(await isPortInUse(ANVIL_PORT))) {
            const started = await startAnvil();
            if (!started) {
                log("Continuing without blockchain integration.", colors.yellow);
                return;
            }
        } else {
            log("Anvil is already running.", colors.green);
        }

        // 2. Check World Config
        let worldAddress = getWorldAddressFromConfig();

        // 3. Verify Code on Chain
        let needDeploy = false;
        if (!worldAddress) {
            log("World address not found in worlds.json. Deploying...", colors.yellow);
            needDeploy = true;
        } else {
            const client = createPublicClient({
                chain: foundry,
                transport: http(`http://${ANVIL_HOST}:${ANVIL_PORT}`),
            });

            const code = await client.getCode({ address: worldAddress });
            if (!code || code === "0x") {
                log(`No contract found at ${worldAddress}. Deploying...`, colors.yellow);
                needDeploy = true;
            } else {
                log(`World contract verified at ${worldAddress}.`, colors.green);
            }
        }

        if (needDeploy) {
            await deployContracts();
            // Refetch address after deploy
            worldAddress = getWorldAddressFromConfig();
            if (!worldAddress) throw new Error("Deployment succeeded but worlds.json is empty.");
        }

        // 4. Sync to Server Env
        updateServerEnv(worldAddress);

        log("Setup complete. Starting server...", colors.green);

    } catch (error) {
        log(`Chain setup failed (non-fatal): ${error.message || error}`, colors.yellow);
        log("Server will start without blockchain integration.", colors.yellow);
    }
}

checkAndSetup();
