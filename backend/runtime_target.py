"""Runtime target validation and startup lock for Archava Monad Python worker.

This module ensures the worker does not start with inherited BNB configuration
or register with LiveKit before validating that all configuration points to the
Monad deployment.

The startup lock prevents:
- Registering worker with BNB LiveKit project
- Processing rooms from BNB deployment
- Using wrong agent name that conflicts with BNB worker

Environment variable ARCHAVA_RUNTIME_ENABLED must be explicitly set to "true"
AND all configuration must pass validation before the worker can register with
LiveKit and start processing rooms.
"""

import json
import os
import sys
from pathlib import Path
from typing import Any


class RuntimeValidationError(Exception):
    """Raised when runtime validation fails."""
    
    def __init__(self, message: str, context: dict[str, Any] | None = None):
        super().__init__(message)
        self.context = context or {}


def load_deployment_targets(cwd: Path | None = None) -> dict[str, Any]:
    """Load and validate deployment target configuration."""
    base_dir = cwd or Path(__file__).resolve().parent.parent
    config_path = base_dir / "config" / "deployment-targets.monad.json"
    
    if not config_path.exists():
        raise RuntimeValidationError(
            "Deployment target configuration not found",
            {
                "config_path": str(config_path),
                "resolution": "Ensure config/deployment-targets.monad.json exists"
            }
        )
    
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = json.load(f)
            
        if not config.get("version"):
            raise RuntimeValidationError("Missing required field: version")
        if not config.get("deployment"):
            raise RuntimeValidationError("Missing required field: deployment")
        if not config.get("network"):
            raise RuntimeValidationError("Missing required field: network")
        if not config.get("hosting"):
            raise RuntimeValidationError("Missing required field: hosting")
        if not config.get("livekit"):
            raise RuntimeValidationError("Missing required field: livekit")
        if not config.get("livekit", {}).get("projectScope", "").strip():
            raise RuntimeValidationError("livekit.projectScope is required for room isolation")
        if not config.get("livekit", {}).get("agentName", "").strip():
            raise RuntimeValidationError("livekit.agentName is required")
        if not config.get("state", {}).get("scope", "").strip():
            raise RuntimeValidationError("state.scope is required")
            
        return config
    except json.JSONDecodeError as error:
        raise RuntimeValidationError(
            "Failed to parse deployment targets",
            {"config_path": str(config_path), "error": str(error)}
        ) from error


def load_network_config(cwd: Path | None = None) -> dict[str, Any]:
    """Load network configuration."""
    base_dir = cwd or Path(__file__).resolve().parent.parent
    config_path = base_dir / "config" / "networks.json"
    
    if not config_path.exists():
        raise RuntimeValidationError(
            "Network configuration not found",
            {
                "config_path": str(config_path),
                "resolution": "Ensure config/networks.json exists"
            }
        )
    
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except json.JSONDecodeError as error:
        raise RuntimeValidationError(
            "Failed to parse network configuration",
            {"config_path": str(config_path), "error": str(error)}
        ) from error


def validate_environment_config(
    env: dict[str, str],
    deployment_targets: dict[str, Any],
    network_config: dict[str, Any]
) -> tuple[list[str], list[str]]:
    """Validate environment configuration matches Monad deployment.
    
    Returns:
        Tuple of (errors, warnings)
    """
    errors = []
    warnings = []
    
    # Get the active network configuration
    active_network_key = network_config.get("active")
    if not active_network_key:
        errors.append("No active network specified in network configuration")
        return errors, warnings
    
    networks = network_config.get("networks", {})
    active_network = networks.get(active_network_key)
    if not active_network:
        errors.append(f'Active network "{active_network_key}" not found in networks configuration')
        return errors, warnings
    
    # Chain ID validation - must match across env, network config, and deployment target
    try:
        env_chain_id = int(env.get("CHAIN_ID", "0"))
    except (ValueError, TypeError):
        env_chain_id = 0
        
    network_chain_id = active_network.get("chainId")
    target_chain_id = deployment_targets.get("network", {}).get("chainId")
    
    if not env_chain_id:
        errors.append("CHAIN_ID environment variable not set")
    elif env_chain_id != 10143:
        error_msg = f"CHAIN_ID is {env_chain_id}, expected 10143 (Monad Testnet)"
        if env_chain_id == 97:
            error_msg += " - This is BNB Testnet!"
        errors.append(error_msg)
    
    # Validate network config chain ID
    if network_chain_id != 10143:
        error_msg = f"Network configuration chainId is {network_chain_id}, expected 10143 (Monad Testnet)"
        if network_chain_id == 97:
            error_msg += " - This is BNB Testnet configuration!"
        errors.append(error_msg)
    
    # Validate deployment target chain ID
    if target_chain_id != 10143:
        errors.append(
            f"Deployment target chainId is {target_chain_id}, expected 10143 (Monad Testnet)"
        )
    
    # All three must match each other
    if env_chain_id and network_chain_id and env_chain_id != network_chain_id:
        errors.append(
            f"CHAIN_ID ({env_chain_id}) does not match network config chainId ({network_chain_id})"
        )
    
    if env_chain_id and target_chain_id and env_chain_id != target_chain_id:
        errors.append(
            f"CHAIN_ID ({env_chain_id}) does not match deployment target chainId ({target_chain_id})"
        )
    
    # LiveKit URL must match deployment target - REQUIRED
    livekit_url = env.get("LIVEKIT_URL", "").strip()
    target_livekit_url = deployment_targets.get("livekit", {}).get("url", "").strip()
    
    if not livekit_url:
        errors.append("LIVEKIT_URL environment variable not set")
    
    if not target_livekit_url:
        errors.append("LiveKit URL not configured in deployment targets")
    
    if livekit_url and target_livekit_url and livekit_url != target_livekit_url:
        errors.append(
            f"LIVEKIT_URL does not match deployment target.\n"
            f"  Environment: {livekit_url}\n"
            f"  Target:      {target_livekit_url}"
        )
        
    # Project scope must be configured - REQUIRED for room isolation
    target_project_scope = deployment_targets.get("livekit", {}).get("projectScope", "").strip()
    if not target_project_scope:
        errors.append("LiveKit projectScope not configured in deployment targets")
    
    # Agent name must match deployment - REQUIRED for worker
    agent_name = env.get("ARCHAVA_AGENT_NAME", "").strip()
    target_agent_name = deployment_targets.get("livekit", {}).get("agentName", "").strip()
    
    if not target_agent_name:
        errors.append("Agent name not configured in deployment targets")
    
    if not agent_name:
        errors.append("ARCHAVA_AGENT_NAME environment variable not set")
    
    if agent_name and target_agent_name and agent_name != target_agent_name:
        errors.append(
            f"ARCHAVA_AGENT_NAME ({agent_name}) does not match deployment target ({target_agent_name}). "
            "Agent name must be deployment-specific to prevent processing wrong rooms."
        )
    
    # Avatar provider credentials (warning only - actual validation in main worker)
    avatar_provider = env.get("AVATAR_PROVIDER", "tavus").strip().lower()
    if avatar_provider not in {"spatius", "tavus"}:
        errors.append(
            f'AVATAR_PROVIDER is "{avatar_provider}", must be "spatius" or "tavus"'
        )
    
    if avatar_provider == "spatius":
        required = ["SPATIUS_API_KEY", "SPATIUS_APP_ID", "SPATIUS_AVATAR_ID"]
        missing = [key for key in required if not env.get(key, "").strip()]
        if missing:
            errors.append(
                f"Spatius provider requires: {', '.join(missing)}"
            )
    
    # Gemini API key
    if not env.get("GEMINI_API_KEY", "").strip():
        errors.append("GEMINI_API_KEY environment variable not set")
    
    return errors, warnings


def validate_runtime_startup(
    env: dict[str, str] | None = None,
    options: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Validate runtime configuration before allowing worker startup.
    
    Reusable validation function that returns validated configuration
    or raises RuntimeValidationError. It does not perform sys.exit().
    
    Args:
        env: Environment variables (defaults to os.environ)
        options: Dependency injection options (e.g. deployment_targets, network_config)
    
    Returns:
        Validated configuration with resolved values
    
    Raises:
        RuntimeValidationError: If validation fails
    """
    if env is None:
        env = dict(os.environ)
    
    runtime_enabled = env.get("ARCHAVA_RUNTIME_ENABLED") == "true"
    
    if not runtime_enabled:
        raise RuntimeValidationError(
            "Runtime startup is locked. Set ARCHAVA_RUNTIME_ENABLED=true after validating configuration.",
            {
                "reason": "Startup lock prevents accidental use of wrong configuration",
                "action": "Validation alone is insufficient - full S03 validation requirements must be met",
                "note": "ARCHAVA_RUNTIME_ENABLED=true does not establish readiness"
            }
        )
    
    # Load configurations (supports dependency injection)
    options = options or {}
    deployment_targets = options.get("deployment_targets") or load_deployment_targets()
    network_config = options.get("network_config") or load_network_config()
    
    # Validate deployment is for Monad
    if deployment_targets.get("deployment") != "monad":
        raise RuntimeValidationError(
            f'Deployment target is "{deployment_targets.get("deployment")}", expected "monad"',
            {"deployment_targets": deployment_targets}
        )
    
    # Validate active network
    if network_config.get("active") != "monadTestnet":
        raise RuntimeValidationError(
            f'Active network is "{network_config.get("active")}", expected "monadTestnet"',
            {"active_network": network_config.get("active")}
        )
    
    # Get active network for validation
    active_network = network_config.get("networks", {}).get(network_config.get("active"))
    if not active_network:
        raise RuntimeValidationError(
            f'Active network "{network_config.get("active")}" not found in network configuration'
        )
    
    # Validate environment configuration (returns errors/warnings)
    errors, warnings = validate_environment_config(
        env,
        deployment_targets,
        network_config
    )
    
    # Report warnings
    if warnings:
        print("\n⚠️  Runtime Validation Warnings:", file=sys.stderr)
        for warning in warnings:
            print(f"  - {warning}", file=sys.stderr)
        print(file=sys.stderr)
    
    # Fail on errors
    if errors:
        error_message = (
            "Runtime validation failed. Configuration does not match Monad deployment:\n" +
            "\n".join(f"  - {e}" for e in errors)
        )
        
        raise RuntimeValidationError(
            error_message,
            {
                "errors": errors,
                "deployment": deployment_targets.get("deployment"),
                "network": network_config.get("active"),
                "chainId": active_network.get("chainId"),
                "resolution": "Fix environment configuration to match Monad deployment targets"
            }
        )
    
    deployment_id = deployment_targets.get("livekit", {}).get("projectScope")
    if not deployment_id:
        raise RuntimeValidationError("Missing livekit.projectScope in deployment targets")

    # Return validated configuration that consumers can use
    return {
        "valid": True,
        "deployment": deployment_targets.get("deployment"),
        "network": network_config.get("active"),
        "chainId": active_network.get("chainId"),
        "networkConfig": active_network,
        "deploymentTargets": deployment_targets,
        "agentName": env.get("ARCHAVA_AGENT_NAME"),
        "livekitUrl": env.get("LIVEKIT_URL"),
        "deploymentId": deployment_id,
        "warnings": warnings if warnings else None
    }


def enforce_runtime_guard(
    env: dict[str, str] | None = None,
    options: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Guard function that must be called before LiveKit worker registration.
    
    Throws RuntimeValidationError if validation fails. Does not call sys.exit().
    """
    result = validate_runtime_startup(env, options)
    
    print("✓ Runtime validation passed", file=sys.stderr)
    print(f"  Deployment: {result['deployment']}", file=sys.stderr)
    print(f"  Network: {result['network']} (chain {result['chainId']})", file=sys.stderr)
    print(f"  Agent: {result['agentName']}", file=sys.stderr)
    print(f"  Scope: {result['deploymentId']}", file=sys.stderr)
    
    return result


def is_runtime_enabled(env: dict[str, str] | None = None) -> bool:
    """Check if runtime is enabled without throwing."""
    if env is None:
        env = dict(os.environ)
    
    return env.get("ARCHAVA_RUNTIME_ENABLED") == "true"
