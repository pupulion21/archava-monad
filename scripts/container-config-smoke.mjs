#!/usr/bin/env node
/**
 * Container configuration smoke test for Archava Monad.
 * 
 * Verifies that required configuration files are present and accessible
 * in the container image. This runs as part of Docker build verification
 * to ensure config/manifest files are properly copied to the image.
 * 
 * Usage:
 *   node scripts/container-config-smoke.mjs              # Check local filesystem
 *   node scripts/container-config-smoke.mjs --image <name>  # Inspect Docker image
 * 
 * Exit codes:
 *   0 - All required configs found and valid
 *   1 - Missing or invalid configuration
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();

class ConfigError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ConfigError";
    this.details = details;
  }
}

function checkFile(relativePath, description) {
  const fullPath = resolve(ROOT, relativePath);
  
  if (!existsSync(fullPath)) {
    throw new ConfigError(
      `Missing ${description}`,
      { path: relativePath, fullPath }
    );
  }
  
  try {
    const content = readFileSync(fullPath, "utf8");
    
    // If it's a JSON file, validate it parses
    if (relativePath.endsWith(".json")) {
      JSON.parse(content);
    }
    
    return { path: relativePath, size: content.length };
  } catch (error) {
    throw new ConfigError(
      `Failed to read or parse ${description}`,
      { path: relativePath, error: error.message }
    );
  }
}

function checkDockerImage(imageName, relativePath, description) {
  const containerPath = `/app/${relativePath}`;
  
  try {
    // Use docker run with --rm to check if file exists and is readable
    const content = execSync(
      `docker run --rm --entrypoint cat ${imageName} ${containerPath}`,
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
    );
    
    // If it's a JSON file, validate it parses
    if (relativePath.endsWith(".json")) {
      JSON.parse(content);
    }
    
    return { path: relativePath, size: content.length };
  } catch (error) {
    throw new ConfigError(
      `Missing or invalid ${description} in image`,
      { 
        path: relativePath, 
        containerPath,
        error: error.message,
        stderr: error.stderr?.toString() || ""
      }
    );
  }
}

function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let imageName = null;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--image" && i + 1 < args.length) {
      imageName = args[i + 1];
      i++;
    }
  }
  
  const mode = imageName ? "Docker image" : "local filesystem";
  const checkFn = imageName 
    ? (path, desc) => checkDockerImage(imageName, path, desc)
    : checkFile;
  
  console.log(`Container Configuration Smoke Test (${mode})\n`);
  if (imageName) {
    console.log(`Inspecting image: ${imageName}\n`);
  }
  
  const requiredConfigs = [
    {
      path: "config/networks.json",
      description: "Network configuration"
    },
    {
      path: "config/deployment-targets.monad.json",
      description: "Deployment targets"
    },
    {
      path: "packages/contracts/deployments/monadTestnetV2.json",
      description: "Contract deployment manifest"
    }
  ];
  
  const optionalConfigs = [];
  
  const results = {
    required: [],
    optional: [],
    errors: []
  };
  
  // Check required configs
  for (const config of requiredConfigs) {
    try {
      const result = checkFn(config.path, config.description);
      results.required.push({ ...config, ...result, status: "ok" });
      console.log(`✓ ${config.description}: ${config.path}`);
    } catch (error) {
      results.errors.push({ ...config, error: error.message });
      console.error(`✗ ${config.description}: ${error.message}`);
      if (error.details) {
        console.error("  Details:", error.details);
      }
    }
  }
  
  // Check optional configs (don't fail if missing, but report)
  for (const config of optionalConfigs) {
    try {
      const result = checkFn(config.path, config.description);
      results.optional.push({ ...config, ...result, status: "ok" });
      console.log(`✓ ${config.description}: ${config.path}`);
    } catch (error) {
      results.optional.push({ ...config, status: "missing" });
      console.warn(`⚠ ${config.description}: not found (expected after S02)`);
    }
  }
  
  console.log();
  
  if (results.errors.length > 0) {
    console.error(`Failed: ${results.errors.length} required configuration(s) missing or invalid`);
    process.exit(1);
  }
  
  console.log("✓ All required configurations present and valid");
  
  if (results.optional.some(c => c.status === "missing")) {
    console.log("Note: Some optional configs not yet deployed (this is expected before S02)");
  }
  
  process.exit(0);
}

main();
