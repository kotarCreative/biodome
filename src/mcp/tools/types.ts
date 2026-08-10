import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
export type TextResult = CallToolResult;
export type ToolArguments = Readonly<Record<string, unknown>>;
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly handler: (arguments_: ToolArguments) => Promise<TextResult>;
}
export function text(value: string, isError?: boolean): TextResult {
  return { content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) };
}
