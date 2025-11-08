import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
        CallToolResult,
        EmbeddedResource,
        ImageContent,
        TextContent,
} from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export interface AgenticToolDefinition<
        TSchema extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>,
> {
        name: (name: string) => string;
        description: (client: Client) => Promise<string> | string;
        inputSchema: TSchema;
        annotations?: {
                readOnlyHint?: boolean;
                destructiveHint?: boolean;
                idempotentHint?: boolean;
                openWorldHint?: boolean;
        };
        handler: (
                params: z.infer<z.ZodObject<TSchema>>
        ) => Promise<string | (TextContent | ImageContent | EmbeddedResource)[]>;
}

export interface CreateAgenticAgentServerOptions<
        TSchema extends Record<string, z.ZodTypeAny> = Record<string, z.ZodTypeAny>,
> {
        name: string;
        version?: string;
        command: string;
        args: string[];
        discoveryClient?: {
                name?: string;
                version?: string;
        };
        capabilities?: {
                tools?: Record<string, unknown>;
                logging?: Record<string, unknown>;
                [key: string]: unknown;
        };
        instructions?: string;
        tool: AgenticToolDefinition<TSchema>;
        sessionHistories?: Record<string, string[]>;
}

export async function createAgenticAgentServer<
        TSchema extends Record<string, z.ZodTypeAny>,
>({
        name,
        version = "1.0.0",
        command,
        args,
        discoveryClient: discoveryClientOptions,
        capabilities,
        instructions,
        tool,
        sessionHistories,
}: CreateAgenticAgentServerOptions<TSchema>): Promise<McpServer> {
        const discoveryClient = new Client({
                name: discoveryClientOptions?.name ?? "discovery-client",
                version: discoveryClientOptions?.version ?? "1.0.0",
        });

        const discoveryClientTransport = new StdioClientTransport({
                command,
                args,
        });

        await discoveryClient.connect(discoveryClientTransport);

        const server = new McpServer(
                {
                        name,
                        version,
                },
                {
                        capabilities: {
                                tools: {},
                                logging: {},
                                ...capabilities,
                        },
                        instructions:
                                instructions ??
                                discoveryClient.getInstructions() ??
                                `Natural language interface to ${name} tools via an embedded AI agent.`,
                }
        );

        server.tool(
                tool.name(name),
                await tool.description(discoveryClient),
                {
                        ...tool.inputSchema,
                },
                {
                        ...tool.annotations,
                },
                async (params, extra): Promise<CallToolResult> => {
                        const handlerParams = params as {
                                context?: string;
                                request?: string;
                                [key: string]: unknown;
                        };
                        let contextWithChat = handlerParams.context;
                        const sessionId = extra.sessionId;

                        if (sessionId && sessionHistories?.[sessionId]?.length) {
                                contextWithChat = [
                                        contextWithChat ?? "",
                                        "\n\nPrevious conversation:\n",
                                        sessionHistories[sessionId].join("\n"),
                                ]
                                        .filter(Boolean)
                                        .join("");
                        }

                        const responsePromise = tool.handler({
                                ...params,
                                context: contextWithChat,
                        });

                        let isDone = false;
                        responsePromise.finally(() => {
                                isDone = true;
                        });

                        const sleep = (ms: number) =>
                                new Promise((resolve) => setTimeout(resolve, ms));

                        let steps = 0;
                        const progressToken = extra._meta?.progressToken;

                        if (progressToken) {
                                while (!isDone) {
                                        await extra.sendNotification({
                                                method: "notifications/progress",
                                                params: {
                                                        progress: steps++,
                                                        progressToken,
                                                        message: "Still working…",
                                                },
                                        });
                                        await sleep(5000);
                                }
                        }

                        const resolvedResponse = await responsePromise;

                        if (sessionId && sessionHistories?.[sessionId]) {
                                sessionHistories[sessionId].push(
                                        `User: ${handlerParams.request}\n Context: ${handlerParams.context}`
                                );
                                sessionHistories[sessionId].push(
                                        `Agent: ${
                                                typeof resolvedResponse === "string"
                                                        ? resolvedResponse
                                                        : JSON.stringify(resolvedResponse)
                                        }`
                                );
                        }

                        return {
                                content: [
                                        {
                                                type: "text",
                                                text: JSON.stringify(resolvedResponse),
                                        },
                                ],
                        };
                }
        );

        return server;
}
