import { estimateTokens } from "../context/token-estimator.js";

export interface CompactionMessage {
  id?: string;
  role: string;
  content: string;
  pairId?: string;
}

export interface AdaptiveCompactionOptions {
  agentThreshold?: number;
  gatewayThreshold?: number;
  targetRatio?: number;
  headTokens?: number;
  tailMessages?: number;
  maxContextTokens?: number;
}

export interface AdaptiveCompactionPlan {
  level: "none" | "agent" | "gateway";
  originalTokens: number;
  activeTokens: number;
  archivedTokens: number;
  active: CompactionMessage[];
  archived: CompactionMessage[];
}

export function compactionTokens(messages: CompactionMessage[]): number {
  return messages.reduce((sum, m) => sum + 4 + estimateTokens(m.content), 0);
}

export function planAdaptiveCompaction(
  messages: CompactionMessage[],
  options: AdaptiveCompactionOptions = {},
): AdaptiveCompactionPlan {
  const agentThreshold = options.agentThreshold ?? 0.5;
  const gatewayThreshold = options.gatewayThreshold ?? 0.85;
  const targetRatio = options.targetRatio ?? 0.5;
  const headTokens = options.headTokens ?? 2000;
  const tailMessages = options.tailMessages ?? 6;
  const maxContextTokens = options.maxContextTokens ?? 128_000;

  const originalTokens = compactionTokens(messages);
  if (messages.length === 0 || originalTokens === 0 || maxContextTokens <= 0) {
    return { level: "none", originalTokens: 0, activeTokens: 0, archivedTokens: 0, active: [], archived: [] };
  }

  const usage = originalTokens / maxContextTokens;
  const level: AdaptiveCompactionPlan["level"] =
    usage >= gatewayThreshold ? "gateway" : usage >= agentThreshold ? "agent" : "none";

  if (level === "none") {
    return { level, originalTokens, activeTokens: originalTokens, archivedTokens: 0, active: [...messages], archived: [] };
  }

  const tailStart = Math.max(0, messages.length - tailMessages);
  let headEnd = 0;
  let headTokenSum = 0;
  while (headEnd < messages.length && headEnd < tailStart && headTokenSum < headTokens) {
    const msg = messages[headEnd]!;
    headTokenSum += 4 + estimateTokens(msg.content);
    headEnd++;
    if (msg.role === "tool") break;
  }

  const head = messages.slice(0, headEnd);
  const tail = messages.slice(tailStart);
  const middle = messages.slice(headEnd, tailStart);

  const groups = groupAtomic(middle);
  const targetActive = Math.max(headTokens + compactionTokens(tail), originalTokens * targetRatio);
  let current = [...head, ...tail];
  let currentTokens = compactionTokens(current);
  const archived: CompactionMessage[] = [];

  for (const group of groups) {
    const groupTokens = compactionTokens(group);
    if (currentTokens + groupTokens <= targetActive) {
      current = [...group, ...current];
      currentTokens += groupTokens;
    } else {
      archived.push(...group);
    }
  }

  current.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));
  archived.sort((a, b) => messages.indexOf(a) - messages.indexOf(b));

  return {
    level,
    originalTokens,
    activeTokens: currentTokens,
    archivedTokens: originalTokens - currentTokens,
    active: current,
    archived,
  };
}

function groupAtomic(messages: CompactionMessage[]): CompactionMessage[][] {
  const groups: CompactionMessage[][] = [];
  for (const msg of messages) {
    if (msg.pairId) {
      const existing = groups.find((g) => g[0]?.pairId === msg.pairId);
      if (existing) {
        existing.push(msg);
      } else {
        groups.push([msg]);
      }
    } else {
      groups.push([msg]);
    }
  }
  return groups;
}