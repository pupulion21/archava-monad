/** Bound external work without allowing a timed-out task to commit caller state. */
export function positiveInteger(value, fallback, name) {
  const result = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return result;
}

export async function withDeadline(work, timeoutMs, label = "RPC request") {
  let timer;
  const abortController = new AbortController();
  const context = {
    isAborted: () => abortController.signal.aborted,
    signal: abortController.signal,
  };

  try {
    return await Promise.race([
      Promise.resolve().then(() => work(context)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          abortController.abort(new Error(`${label} timed out after ${timeoutMs}ms`));
          const error = new Error(`${label} timed out after ${timeoutMs}ms`);
          error.name = "RpcTimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function isRateLimitError(error) {
  if (!error) return false;
  if (error.status === 429 || error.statusCode === 429) return true;
  if (error.info?.error?.code === 429) return true;
  const message = error.message || String(error);
  return /429|too many requests|rate limit|quota/i.test(message);
}

export function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === "RpcTimeoutError" || error.name === "TimeoutError" || error.code === "TIMEOUT") return true;
  const message = error.message || String(error);
  return /timeout|timed out|ETIMEDOUT/i.test(message);
}

export function isRangeTooLargeError(error) {
  if (!error) return false;
  if (isRateLimitError(error) || isTimeoutError(error)) return false;
  const message = error.message || String(error);
  return /range|response size|limit|exceed|block range|too many logs/i.test(message);
}

export function runtimeErrorMessage(error, env = process.env) {
  let message = error?.message || String(error);
  const secrets = Object.entries(env)
    .filter(([name, value]) => /PRIVATE_KEY|SECRET|API_KEY|RPC_URL|AUTH_TOKEN/.test(name) && value)
    .map(([, value]) => String(value))
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) message = message.split(secret).join("[redacted]");
  return message;
}
