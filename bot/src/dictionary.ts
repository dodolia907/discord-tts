import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UserFacingError } from "./session.js";

export const MAX_ENTRIES = 200;
export const MAX_WORD_CHARS = 50;
export const MAX_READING_CHARS = 100;

export interface DictionaryEntry {
  word: string;
  reading: string;
}

const sameWord = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Builds a function that replaces registered words in one pass, so a reading is never replaced
 * again. Longer words win, so "AIチャット" is not broken up by "AI".
 */
export function createReplacer(entries: DictionaryEntry[]): (text: string) => string {
  if (entries.length === 0) {
    return (text) => text;
  }
  const readings = new Map(entries.map((entry) => [entry.word.toLowerCase(), entry.reading]));
  const pattern = [...entries]
    .sort((a, b) => b.word.length - a.word.length)
    .map((entry) => entry.word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("|");
  const regex = new RegExp(pattern, "giu");
  return (text) => text.replace(regex, (match) => readings.get(match.toLowerCase()) ?? match);
}

function validate(word: string, reading: string): void {
  if (!word || !reading) {
    throw new UserFacingError("単語と読みを入力してください。");
  }
  if ([...word].length > MAX_WORD_CHARS) {
    throw new UserFacingError(`単語は${MAX_WORD_CHARS}文字以内にしてください。`);
  }
  if ([...reading].length > MAX_READING_CHARS) {
    throw new UserFacingError(`読みは${MAX_READING_CHARS}文字以内にしてください。`);
  }
}

/** Keeps each guild's dictionary in its own JSON file. Assumes this process is the only writer. */
export class FileDictionary {
  private readonly cache = new Map<string, DictionaryEntry[]>();
  private readonly writes = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async list(guildId: string): Promise<DictionaryEntry[]> {
    const cached = this.cache.get(guildId);
    if (cached) {
      return cached;
    }
    const entries = await this.read(guildId);
    this.cache.set(guildId, entries);
    return entries;
  }

  /** Returns true when an existing word's reading was replaced. */
  async add(guildId: string, word: string, reading: string): Promise<boolean> {
    const cleanWord = word.trim();
    const cleanReading = reading.trim();
    validate(cleanWord, cleanReading);
    return this.serialize(guildId, async () => {
      const entries = await this.list(guildId);
      const others = entries.filter((entry) => !sameWord(entry.word, cleanWord));
      const replaced = others.length < entries.length;
      if (!replaced && entries.length >= MAX_ENTRIES) {
        throw new UserFacingError(`辞書に登録できるのは${MAX_ENTRIES}件までです。`);
      }
      await this.write(guildId, [...others, { word: cleanWord, reading: cleanReading }]);
      return replaced;
    });
  }

  /** Returns false when the word is not registered. */
  async remove(guildId: string, word: string): Promise<boolean> {
    return this.serialize(guildId, async () => {
      const entries = await this.list(guildId);
      const others = entries.filter((entry) => !sameWord(entry.word, word.trim()));
      if (others.length === entries.length) {
        return false;
      }
      await this.write(guildId, others);
      return true;
    });
  }

  /** Runs one guild's writes in order, so overlapping commands cannot lose each other's changes. */
  private serialize<T>(guildId: string, task: () => Promise<T>): Promise<T> {
    const result = (this.writes.get(guildId) ?? Promise.resolve()).then(task, task);
    this.writes.set(guildId, result.catch(() => {}));
    return result;
  }

  private path(guildId: string): string {
    return join(this.directory, `${guildId}.json`);
  }

  /** A corrupt file throws rather than reading as empty, so the next write cannot erase it. */
  private async read(guildId: string): Promise<DictionaryEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(guildId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    return JSON.parse(raw) as DictionaryEntry[];
  }

  /** Renames a finished file into place, so a crash mid-write leaves the old dictionary intact. */
  private async write(guildId: string, entries: DictionaryEntry[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = `${this.path(guildId)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(entries));
      await rename(temporary, this.path(guildId));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    this.cache.set(guildId, entries);
  }
}
