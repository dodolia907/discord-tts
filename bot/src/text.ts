export const MAX_SPOKEN_CHARS = 150;

/** Converts a message (with mentions already resolved) to speakable text. Empty means "skip". */
export function toSpeech(content: string): string {
  const text = content
    .replace(/```[\s\S]*?```/g, " コードブロック ")
    .replace(/\|\|[\s\S]*?\|\|/g, " 伏せ字 ")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/https?:\/\/\S+/g, " URL ")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const chars = [...text];
  return chars.length > MAX_SPOKEN_CHARS
    ? `${chars.slice(0, MAX_SPOKEN_CHARS).join("")} 以下略`
    : text;
}
