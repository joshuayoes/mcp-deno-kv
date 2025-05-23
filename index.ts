import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import process from "node:process";

import type { Kv, KvKey, KvListOptions, KvListSelector } from "@deno/kv";

const DENO_KV_PATH = process.env.DENO_KV_PATH;
if (!DENO_KV_PATH) {
  console.error("DENO_KV_PATH must be a file path or remote url");
  process.exit(1);
}

const isDeno = typeof Deno !== "undefined";

if (DENO_KV_PATH.startsWith("http") && !process.env.DENO_KV_ACCESS_TOKEN) {
  console.error(
    "DENO_KV_PATH is a remote url but DENO_KV_ACCESS_TOKEN is not set in environment (required for Deno KV)"
  );
  process.exit(1);
}

if (DENO_KV_PATH.startsWith("http") && !process.env.DENO_KV_ACCESS_TOKEN) {
  console.error(
    "DENO_KV_PATH is a remote url but DENO_KV_ACCESS_TOKEN is not set in environment (required for Node.js REST API access)"
  );
  process.exit(1);
}

function toError(input: unknown): Error {
  if (input instanceof Error) return input;

  if (
    typeof input === "object" &&
    input &&
    "message" in input &&
    typeof input.message === "string"
  )
    return new Error(input.message);

  return new Error(JSON.stringify(input));
}

const kv = isDeno
  ? ((await Deno.openKv(DENO_KV_PATH)) as Kv)
  : await import("@deno/kv").then((m) => m.openKv(DENO_KV_PATH));

const server = new McpServer({
  name: "denokv",
  version: "1.0.0",
});

server.tool(
  "set",
  "Set a key-value pair in the Deno KV store.",
  {
    key: z.array(z.string()).describe("The key to set in the key-value store"),
    value: z
      .string()
      .describe("The value to set in the key-value store (JSON string)"),
    expireIn: z
      .number()
      .optional()
      .describe("Time-to-live (TTL) for the key in milliseconds"),
  },
  async ({ key, value, expireIn }) => {
    try {
      // Parse the value as JSON if it's a string
      const parsedValue = JSON.parse(value);
      const result = await kv.set(key, parsedValue, { expireIn });
      if (!result.ok) {
        throw new Error("Commit failed with non-ok status.");
      }
      return {
        content: [
          { type: "text", text: `Successfully set key [${key.join(", ")}]` },
        ],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to set key [${key.join(", ")}]: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "get",
  "Get a value by key from the Deno KV store.",
  {
    key: z
      .array(z.string())
      .describe("The key to get from the key-value store"),
    consistency: z
      .enum(["strong", "eventual"])
      .optional()
      .describe("The consistency level for the read operation"),
  },
  async ({ key, consistency }) => {
    try {
      const result = await kv.get(key, { consistency });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to get key [${key.join(", ")}]: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "delete",
  "Delete a key-value pair from the Deno KV store.",
  {
    key: z
      .array(z.string())
      .describe("The key to delete from the key-value store"),
  },
  async ({ key }) => {
    try {
      await kv.delete(key);
      return {
        content: [
          {
            type: "text",
            text: `Successfully deleted key [${key.join(", ")}]`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to delete key [${key.join(", ")}]: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "getMany",
  "Get multiple values by keys from the Deno KV store.",
  {
    keys: z
      .array(z.array(z.string()))
      .describe("The keys to get from the key-value store"),
    consistency: z
      .enum(["strong", "eventual"])
      .optional()
      .describe("The consistency level for the read operation"),
  },
  async ({ keys, consistency }) => {
    try {
      // Need to cast keys because the Deno API has stronger typing
      // than we can easily represent in Zod for KvKeyPart.
      // deno-lint-ignore no-explicit-any
      const result = await kv.getMany(keys as any[], { consistency });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to get keys [${keys.map((k) =>
              k.join(", ")
            )}]: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "list",
  "List key-value pairs in the Deno KV store based on a selector.",
  {
    prefix: z
      .array(z.string())
      .optional()
      .describe(
        'Array of strings representing the key prefix to list. Example: ["users"]'
      ),
    start: z
      .array(z.string())
      .optional()
      .describe('Start key for range queries. Example: ["orders", "2023"]'),
    end: z
      .array(z.string())
      .optional()
      .describe('End key for range queries. Example: ["orders", "2024"]'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Maximum number of entries to return"),
    consistency: z
      .enum(["strong", "eventual"])
      .optional()
      .describe("The consistency level for the list operation"),
    batchSize: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Number of entries to fetch per batch internally"),
    reverse: z
      .boolean()
      .optional()
      .describe("Whether to reverse the order of entries"),
  },
  async (params) => {
    try {
      // Construct the selector from the parameters
      let selector = {} as KvListSelector;
      if (params.prefix) {
        selector = { prefix: params.prefix };
      }
      if (params.start && params.end) {
        selector = { start: params.start, end: params.end };
      }
      if (params.prefix && params.start) {
        selector = { prefix: params.prefix, start: params.start };
      }

      // Validate selector
      if (!params.prefix && !params.start && !params.end) {
        return {
          content: [
            {
              type: "text",
              text: "Error: Must provide prefix, start, or end parameter",
            },
          ],
          isError: true,
        };
      }

      // Ensure valid combinations
      if (params.end && !params.start && !params.prefix) {
        return {
          content: [
            {
              type: "text",
              text: "Error: 'end' parameter must be used with either 'start' or 'prefix'",
            },
          ],
          isError: true,
        };
      }

      // Construct options
      const options: KvListOptions = {};
      if (params.limit) options.limit = params.limit;
      if (params.consistency) options.consistency = params.consistency;
      if (params.batchSize) options.batchSize = params.batchSize;
      if (params.reverse !== undefined) options.reverse = params.reverse;

      const iter = kv.list(selector, options);
      const entries = [];
      // Limit iterations to prevent accidental infinite loops or huge responses
      const maxIterations = params.limit ?? 100;
      let count = 0;
      for await (const entry of iter) {
        entries.push(entry);
        count++;
        if (count >= maxIterations) {
          break;
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to list keys: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "enqueue",
  "Enqueue a message into the Deno KV queue.",
  {
    value: z
      .string()
      .describe("The value to set in the key-value store (JSON string)"),
    delay: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Delay in milliseconds before the message is delivered"),
    keysIfUndelivered: z
      .array(z.array(z.string()))
      .optional()
      .describe("Keys to set if the message is not successfully delivered"),
    backoffSchedule: z
      .array(z.number().int().positive())
      .optional()
      .describe("Retry backoff schedule in milliseconds"),
  },
  async (params) => {
    try {
      // Construct options object from flat parameters
      const options: {
        delay?: number;
        keysIfUndelivered?: KvKey[];
        backoffSchedule?: number[];
      } = {};
      if (params.delay !== undefined) options.delay = params.delay;
      if (params.keysIfUndelivered !== undefined)
        // Need to cast keysIfUndelivered as Deno.KvKey[] might not be directly assignable from string[][]
        options.keysIfUndelivered = params.keysIfUndelivered as KvKey[];
      if (params.backoffSchedule !== undefined)
        options.backoffSchedule = params.backoffSchedule;

      const result = await kv.enqueue(
        JSON.parse(params.value),
        Object.keys(options).length > 0 ? options : undefined
      );
      if (!result.ok) {
        throw new Error("Enqueue commit failed with non-ok status.");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to enqueue value: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

server.tool(
  "reset",
  "Delete all keys from the Deno KV store (requires confirmation).",
  {
    confirmation: z
      .literal("yes")
      .describe("Must be 'yes' to confirm deletion of all keys"),
  },
  async ({ confirmation }) => {
    if (confirmation !== "yes") {
      return {
        content: [
          { type: "text", text: "Reset cancelled. Confirmation not provided." },
        ],
        isError: false,
      };
    }

    try {
      let count = 0;
      const promises = [];
      // Iterate through all keys and delete them
      // deno-lint-ignore no-explicit-any
      for await (const entry of kv.list({ prefix: [] as any })) {
        promises.push(kv.delete(entry.key));
        count++;
      }
      await Promise.all(promises);
      return {
        content: [
          { type: "text", text: `Reset complete. Deleted ${count} keys.` },
        ],
        isError: false,
      };
    } catch (error) {
      const errorMessage = toError(error).message;
      return {
        content: [
          {
            type: "text",
            text: `Failed to reset KV store: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Deno KV MCP Server connected via stdio");
}

runServer().catch((error) => {
  console.error("Failed to start Deno KV MCP Server:", error);
  process.exit(1);
});

// Graceful shutdown using process.on for broader compatibility
const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
for (const signal of signals) {
  process.on(signal, () => {
    console.log(`Received ${signal}, closing server...`);
    server
      .close()
      .then(() => {
        console.log("Server closed successfully.");
        process.exit(0);
      })
      .catch((error) => {
        console.error("Error closing server:", error);
        process.exit(1);
      });
  });
}
