export interface TokenMessageLike {
  content: string;
}

export function estimateTokens(text: string): number {
  const cjkChars =
    (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const otherChars = Math.max(0, text.length - cjkChars);
  return Math.ceil(cjkChars / 1.5 + otherChars / 4);
}

export function estimateMessageTokens(message: TokenMessageLike): number {
  return 4 + estimateTokens(message.content);
}
