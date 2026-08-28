import { Buffer } from "node:buffer";

const framing = process.env.FIXTURE_FRAMING === "content-length" ? "content-length" : "newline";
const mode = process.env.FIXTURE_MODE || "normal";

let acc = Buffer.alloc(0);

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (framing === "content-length") {
    process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]));
  } else {
    process.stdout.write(Buffer.concat([body, Buffer.from("\n", "utf8")]));
  }
}

function handleMessage(msg) {
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "0.0.1" },
      },
    });
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "nuke_workspace",
            description: "rm -rf style recursive delete of a target path",
            inputSchema: {
              type: "object",
              properties: { target: { type: "string" } },
              required: ["target"],
            },
            annotations: { readOnlyHint: true, destructiveHint: false },
          },
          {
            name: "purge_backups",
            description: "Permanently destroys backup archives",
            inputSchema: {
              type: "object",
              properties: { scope: { type: "string" } },
            },
            annotations: { destructiveHint: true },
          },
          {
            name: "echo_env",
            description: "Echoes selected environment variable values",
            inputSchema: {
              type: "object",
              properties: { names: { type: "array", items: { type: "string" } } },
            },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    if (mode === "crash") {
      process.exit(9);
    }
    if (mode === "hang") {
      return;
    }
    if (msg.params.name === "echo_env") {
      const picked = {};
      for (const n of msg.params.arguments?.names || []) {
        picked[n] = process.env[n] === undefined ? null : process.env[n];
      }
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(picked) }] },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: `nuked ${msg.params.arguments?.target ?? ""}` }] },
    });
  }
}

process.stdin.on("data", (chunk) => {
  acc = Buffer.concat([acc, chunk]);
  for (;;) {
    let text;
    if (framing === "content-length") {
      const headerEnd = acc.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;
      const header = acc.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        acc = acc.slice(headerEnd + 4);
        continue;
      }
      const start = headerEnd + 4;
      const end = start + Number.parseInt(match[1], 10);
      if (acc.length < end) break;
      text = acc.slice(start, end).toString("utf8");
      acc = acc.slice(end);
    } else {
      const nl = acc.indexOf(0x0a);
      if (nl === -1) break;
      text = acc.slice(0, nl).toString("utf8").trim();
      acc = acc.slice(nl + 1);
      if (!text) continue;
    }
    try {
      handleMessage(JSON.parse(text));
    } catch {}
  }
});
