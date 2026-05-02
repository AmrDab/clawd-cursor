import { evaluate, isAllowed } from '../pipeline/safety/layer';
import type { ToolDefinition, ToolResult } from './types';

function labelFromArgs(args: Record<string, unknown>): string | undefined {
  const candidates = [
    args.target,
    args.name,
    args.text,
    args.label,
    args.title,
    args.selector,
  ];
  const value = candidates.find(v => typeof v === 'string' && v.trim().length > 0);
  return typeof value === 'string' ? value : undefined;
}

/** Enforce the shared safety evaluator before direct MCP/REST tool handlers run. */
export function evaluateToolCall(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): ToolResult | null {
  const decision = evaluate({
    tool: tool.name,
    args,
    targetLabel: labelFromArgs(args),
  });

  if (isAllowed(decision)) return null;

  const reason = decision.decision === 'confirm' && 'reason' in decision
    ? `requires user confirmation (${decision.reason})`
    : 'reason' in decision
      ? decision.reason
      : `unexpected safety decision: ${decision.decision}`;

  return {
    text: `${tool.name}: safety ${decision.decision} - ${reason}`,
    isError: true,
  };
}
