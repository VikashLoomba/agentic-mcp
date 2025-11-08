import { agent, ai, AxMCPClient } from "@ax-llm/ax";
import { AxMCPStdioTransport } from "@ax-llm/ax-tools";
import express, { Request, Response } from "express";
import cors from "cors";
import { getDisplayName } from "@modelcontextprotocol/sdk/shared/metadataUtils.js";
import { z } from "zod";
import {
        type TextContent,
        type ImageContent,
        type EmbeddedResource,
        isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryEventStore } from "@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js";
import { randomUUID } from "crypto";
import {
        createAgenticAgentServer,
        type AgenticToolDefinition,
} from "./src/index.ts";
// Map to store transports by session ID
const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
const chats: { [sessionId: string]: string[] } = {}; // Simple in-memory chat history store
export interface ToolConfig<
        TSchema extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>,
> extends AgenticToolDefinition<TSchema> {
        annotations: NonNullable<AgenticToolDefinition<TSchema>["annotations"]>;
}
export function defineTool<TSchema extends Record<string, z.ZodTypeAny>>(
        config: ToolConfig<TSchema>
) {
        return config;
}

const args = [
	"@neondatabase/mcp-server-neon",
	"start",
	"napi_w7chz0x5txvyt9nczi2niucdhh931zxqj9ih8kmjy89je4qvjc595596snr1aowh",
];
const command = "npx";
const NAME = "neondb";

const llm = ai({ name: "openai", apiKey: process.env.OPENAI_API_KEY! });

const app = express();
app.use(express.json());

// Allow CORS all domains, expose the Mcp-Session-Id header
app.use(
	cors({
		origin: "*", // Allow all origins
		exposedHeaders: ["Mcp-Session-Id"],
	})
);

const s = defineTool({
	name: (name: string) => `use_${name.toLowerCase()}`,
	description: async (client) => {
		const serverTools = await client.listTools();
		const modifiedTools = serverTools.tools.map((tool) => ({
			...tool,
			name: getDisplayName(tool),
		}));
		return [
			`Natural language interface to ${NAME} via an embedded AI agent.`,
			"",
			"Use this tool when you need to:",
			"- Perform complex multi-step operations",
			`- Explore and analyze ${NAME} data with natural language`,
			"- Chain multiple operations automatically",
			"",
			"Capabilities:",
			...modifiedTools.map(
				(tool) =>
					`- ${tool.name}: ${tool.description?.substring(0, tool.description?.length > 25 ? 25 : tool.description.length) + "..." || ""}: inputs: ${JSON.stringify(tool.inputSchema.properties)}`
			),
			// "- inspect: Search errors/events, analyze traces, explore issues and projects",
			// "- seer: Get AI-powered debugging insights and root cause analysis",
			// "- docs: Search and retrieve Sentry documentation",
			// "- triage: Resolve, assign, comment on, and update issues",
			// "- project-management: Create/modify teams, projects, and configure DSNs",
			"",
			"<hints>",
			`- If user asks to 'use ${NAME}' for something, they always mean to call this tool`,
			"- Pass the user's request verbatim - do not interpret or rephrase",
			"- The agent can chain multiple tool calls automatically",
			"- **The agent resets its memory after each tool call.**",
			"- Always provide information in the context string to help the agent process the request faster or more accurately.",
			"</hints>",
		].join("\n");
	},
	inputSchema: {
		request: z
			.string()
			.trim()
			.min(1)
			.describe(
				"The user's raw input. Do not interpret the prompt in any way. Do not add any additional information to the prompt."
			),
		context: z
			.string()
			.trim()
			.min(1)
			.optional()
			.describe(
				`Key information for ${NAME} Agent to process the request, based on previous conversation turns with the user.`
			),
	},
	annotations: {
		readOnlyHint: true, // Will be adjusted based on actual implementation
		openWorldHint: true,
	},
	async handler(params) {
		const neonAgentMcpTransport = new AxMCPStdioTransport({
			command,
			args,
		});
		const neonAgentMcpClient = new AxMCPClient(neonAgentMcpTransport, {
			debug: false,
		});
		await neonAgentMcpClient.init();

		// Create agent with neondb capabilities
		const myAgent = agent(
			`userMessage:string "A user request or question to the agent", context:string "Contextual information to help the agent answer the query accurately." -> responseText:string "The agent's response to the user after interacting with the ${NAME} tools."`,
			{
				name: "neonDbAgent",
				description:
					"An agent that calls NeonDB MCP tools to interact with a Neon database to facilitate user requests or answer questions.",
				functions: [neonAgentMcpClient],
			}
		);

		try {
			const result = await myAgent.forward(
				llm,
				{
					userMessage: params.request,
					context: params.context ?? "",
				},
				{
					debug: true,
					maxSteps: 10,
					functionCallMode: "native",
					timeout: 60000,
				}
			);

			return result.responseText;

			// return output;
		} finally {
			// Clean up connections
			await neonAgentMcpTransport.terminate();
		}
	},
});
// main().catch((err) => {
// 	console.error(err);
// 	process.exit(1);
// });
const mcpPostHandler = async (req: Request, res: Response) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (sessionId) {
		console.log(`Received MCP request for session: ${sessionId}`);
	} else {
		console.log("Request body:", req.body);
	}

	if (!sessionId && !isInitializeRequest(req.body)) {
		// Invalid request - no session ID or not initialization request
		res.status(400).json({
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: "Bad Request: No valid session ID provided",
			},
			id: null,
		});
		return;
	}
	let transport: StreamableHTTPServerTransport;

	try {
		if (sessionId && transports[sessionId]) {
			// Reuse existing transport
			transport = transports[sessionId];
			console.log(`Reusing existing transport for session ${sessionId}`);
			console.log(`Handling MCP request for session ${transport.sessionId}`);
			// Handle the request with existing transport - no need to reconnect
			// The existing transport is already connected to the server
			await transport.handleRequest(req, res, req.body);
		} else if (!sessionId && isInitializeRequest(req.body)) {
			console.log("Initializing new MCP session");
			// New initialization request
			const eventStore = new InMemoryEventStore();
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				eventStore, // Enable resumability
				onsessioninitialized: (sessionId) => {
					// Store the transport by session ID when session is initialized
					// This avoids race conditions where requests might come in before the session is stored
					console.log(`Session initialized with ID: ${sessionId}`);
					transports[sessionId] = transport;
					chats[sessionId] = []; // Initialize empty chat history
				},
			});
			console.log(`Created new transport`);

			// Connect the transport to the MCP server BEFORE handling the request
			// so responses can flow back through the same transport
                        const server = await createAgenticAgentServer({
                                name: NAME,
                                version: "1.0.0",
                                command,
                                args,
                                tool: s,
                                sessionHistories: chats,
                        });
			console.log(`Obtained MCP server instance`);
			console.log(`Connecting new transport for new session to MCP server`);
			await server.connect(transport);
			console.log(
				`Connected new transport for session ${transport.sessionId} to MCP server`
			);
			// Set up onclose handler to clean up transport when closed
			transport.onclose = () => {
				const sid = transport.sessionId;
				if (sid && transports[sid]) {
					console.log(
						`Transport closed for session ${sid}, removing from transports map`
					);
					delete transports[sid];
				}
			};
			console.log("set up onclose handler for transport");
			await transport.handleRequest(req, res, req.body);
			return; // Already handled
		}
	} catch (error) {
		console.error("Error handling MCP request:", error);
		console.error(error);
		if (!res.headersSent) {
			res.status(500).json({
				jsonrpc: "2.0",
				error: {
					code: -32603,
					message: "Internal server error",
				},
				id: null,
			});
		}
	}
};

// Set up routes with conditional auth middleware
app.post("/mcp", mcpPostHandler);

// Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
const mcpGetHandler = async (req: Request, res: Response) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !transports[sessionId]) {
		res.status(400).send("Invalid or missing session ID");
		return;
	}

	// Check for Last-Event-ID header for resumability
	const lastEventId = req.headers["last-event-id"] as string | undefined;
	if (lastEventId) {
		console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
	} else {
		console.log(`Establishing new SSE stream for session ${sessionId}`);
	}

	const transport = transports[sessionId];
	await transport.handleRequest(req, res);
};

// Set up GET route with conditional auth middleware
app.get("/mcp", mcpGetHandler);

const mcpDeleteHandler = async (req: Request, res: Response) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (!sessionId || !transports[sessionId]) {
		res.status(400).send("Invalid or missing session ID");
		return;
	}

	console.log(`Received session termination request for session ${sessionId}`);

	try {
		const transport = transports[sessionId];
		await transport.handleRequest(req, res);
	} catch (error) {
		console.error("Error handling session termination:", error);
		if (!res.headersSent) {
			res.status(500).send("Error processing session termination");
		}
	}
};
app.delete("/mcp", mcpDeleteHandler);

app.listen(8099, (error) => {
	if (error) {
		console.error("Failed to start server:", error);
		process.exit(1);
	}
	console.log(`MCP Streamable HTTP Server listening on port ${8099}`);
});

// Handle server shutdown
process.on("SIGINT", async () => {
	console.log("Shutting down server...");

	// Close all active transports to properly clean up resources
	for (const sessionId in transports) {
		try {
			console.log(`Closing transport for session ${sessionId}`);
			await transports[sessionId].close();
			delete transports[sessionId];
		} catch (error) {
			console.error(`Error closing transport for session ${sessionId}:`, error);
		}
	}
	console.log("Server shutdown complete");
	process.exit(0);
});
