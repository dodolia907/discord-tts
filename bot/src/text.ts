export const MAX_SPOKEN_CHARS = 150;

type Replace = (text: string) => string;

/** Prefixes the message with its author's name. A message with nothing to read stays empty, so it is skipped. */
export function toUtterance(author: string, content: string, replace: Replace = (text) => text): string {
  const body = toSpeech(content, replace);
  const name = toSpeech(author, replace);
  return body && name ? `${name}、${body}` : body;
}

/** Converts a message (with mentions already resolved) to speakable text. Empty means "skip". */
export function toSpeech(content: string, replace: Replace = (text) => text): string {
  const cleaned = content
    .replace(/```[\s\S]*?```/g, " コードブロック ")
    .replace(/\|\|[\s\S]*?\|\|/g, " 伏せ字 ")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/https?:\/\/\S+/g, " URL ")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Replacing before truncating means the limit applies to what is actually read.
  const text = replace(cleaned);
  const chars = [...text];
  return chars.length > MAX_SPOKEN_CHARS
    ? `${chars.slice(0, MAX_SPOKEN_CHARS).join("")} 以下略`
    : text;
}
