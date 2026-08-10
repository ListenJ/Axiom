export interface ToolSurfaceLike {
  name: string;
  description: string;
  inputSchema: unknown;
  format?: "json" | "text";
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}