type JsonRpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

const RESPONSE_TIMEOUT_MS = 10_000;

/** Reads Codex usage without starting or persisting a conversation thread. */
export async function captureCodexRateLimits(): Promise<string> {
  const proc = Bun.spawn(["codex", "app-server"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderrPromise = new Response(proc.stderr).text();
  const messages = readJsonMessages(proc.stdout);
  let result: unknown;
  let failure: unknown;

  try {
    result = await withTimeout(exchangeRateLimits(proc.stdin, messages), RESPONSE_TIMEOUT_MS);
  } catch (error) {
    failure = error;
  } finally {
    proc.stdin.end();
    proc.kill();
    await messages.return(undefined);
    await proc.exited;
  }

  const stderr = (await stderrPromise).trim();
  if (failure !== undefined) {
    const message = failure instanceof Error ? failure.message : String(failure);
    throw new Error(stderr ? `${message}: ${stderr}` : message);
  }
  return JSON.stringify(result);
}

async function exchangeRateLimits(
  stdin: { write(data: string): unknown },
  messages: AsyncGenerator<JsonRpcMessage>,
): Promise<unknown> {
  writeMessage(stdin, {
    method: "initialize",
    id: 0,
    params: {
      clientInfo: {
        name: "agent_usage",
        title: "Agent Usage",
        version: "0.1.0",
      },
    },
  });
  await responseResult(messages, 0);

  writeMessage(stdin, { method: "initialized", params: {} });
  writeMessage(stdin, { method: "account/rateLimits/read", id: 1 });
  return responseResult(messages, 1);
}

function writeMessage(stdin: { write(data: string): unknown }, message: unknown): void {
  stdin.write(`${JSON.stringify(message)}\n`);
}

async function responseResult(messages: AsyncGenerator<JsonRpcMessage>, id: number): Promise<unknown> {
  while (true) {
    const next = await messages.next();
    if (next.done) throw new Error(`codex app-server closed before response ${id}`);
    if (next.value.id !== id) continue;
    if (next.value.error) {
      throw new Error(next.value.error.message ?? `codex app-server request ${id} failed`);
    }
    return next.value.result;
  }
}

async function* readJsonMessages(stream: ReadableStream<Uint8Array>): AsyncGenerator<JsonRpcMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffered += decoder.decode(next.value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) yield JSON.parse(line) as JsonRpcMessage;
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim()) yield JSON.parse(buffered) as JsonRpcMessage;
  } finally {
    reader.releaseLock();
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("codex app-server response timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
