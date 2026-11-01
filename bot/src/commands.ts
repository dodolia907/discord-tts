import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  escapeMarkdown,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { type DictionaryEntry, type FileDictionary, MAX_READING_CHARS, MAX_WORD_CHARS } from "./dictionary.js";
import { ENGINE_NAMES, type Engine, type EngineName, isEngineName } from "./engines.js";
import { type SessionManager, UserFacingError } from "./session.js";
import { matchVoices } from "./tts/client.js";

export const commandDefinitions = (engines: Record<EngineName, Engine>) => [
  new SlashCommandBuilder()
    .setName("join")
    .setDescription("参加中のVCに入り、VCのチャットを読み上げます")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option
        .setName("engine")
        .setDescription("音声合成エンジン")
        .addChoices(ENGINE_NAMES.map((name) => ({ name: engines[name].label, value: name }))),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("leave")
    .setDescription("読み上げを終了してVCから退出します")
    .setContexts(InteractionContextType.Guild)
    .toJSON(),
  new SlashCommandBuilder()
    .setName("voice")
    .setDescription("読み上げの声を変更します(VOICEVOXのみ)")
    .setContexts(InteractionContextType.Guild)
    .addStringOption((option) =>
      option.setName("speaker").setDescription("声の名前").setRequired(true).setAutocomplete(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("dict")
    .setDescription("読み上げの辞書を管理します")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("単語の読みを登録します")
        .addStringOption((option) =>
          option.setName("word").setDescription("単語").setRequired(true).setMaxLength(MAX_WORD_CHARS),
        )
        .addStringOption((option) =>
          option.setName("reading").setDescription("読み").setRequired(true).setMaxLength(MAX_READING_CHARS),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("del")
        .setDescription("単語を辞書から消去します")
        .addStringOption((option) =>
          option.setName("word").setDescription("単語").setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((sub) => sub.setName("show").setDescription("辞書の一覧を表示します"))
    .toJSON(),
];

/** Discord accepts at most this many autocomplete choices. */
const MAX_CHOICES = 25;
/** Discord rejects longer messages. */
const MAX_MESSAGE_CHARS = 2000;

/** Splits the dictionary into messages Discord will accept, without breaking an entry. */
export function formatDictionary(entries: DictionaryEntry[]): string[] {
  const pages: string[] = [];
  let page = `辞書(${entries.length}件)`;
  for (const entry of entries) {
    const line = `\n${escapeMarkdown(entry.word)} → ${escapeMarkdown(entry.reading)}`;
    if (page.length + line.length > MAX_MESSAGE_CHARS) {
      pages.push(page);
      page = line.trimStart();
    } else {
      page += line;
    }
  }
  pages.push(page);
  return pages;
}

export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  manager: SessionManager,
  dictionary: Pick<FileDictionary, "list">,
): Promise<void> {
  const query = interaction.options.getFocused();
  if (interaction.commandName === "dict") {
    const entries = interaction.guildId ? await dictionary.list(interaction.guildId) : [];
    const needle = query.trim().toLowerCase();
    await interaction.respond(
      entries
        .filter((entry) => entry.word.toLowerCase().includes(needle))
        .slice(0, MAX_CHOICES)
        .map((entry) => ({ name: entry.word, value: entry.word })),
    );
    return;
  }
  const voices = interaction.guildId ? await manager.voices(interaction.guildId) : [];
  const matches = query.trim() ? matchVoices(voices, query) : voices;
  await interaction.respond(
    matches.slice(0, MAX_CHOICES).map((voice) => ({ name: voice.label, value: String(voice.id) })),
  );
}

interface CommandStore {
  set(commands: never[]): Promise<unknown>;
}

/**
 * Makes the given definitions the application's only commands. Replacing the global commands
 * does not touch guild commands, which an earlier bot on this application may have registered.
 */
export async function syncCommands(
  application: { commands: { set(commands: ReturnType<typeof commandDefinitions>): Promise<unknown> } },
  guilds: Iterable<{ id: string; commands: CommandStore }>,
  definitions: ReturnType<typeof commandDefinitions>,
  log: (message: string, error?: unknown) => void,
): Promise<void> {
  await application.commands.set(definitions);
  for (const guild of guilds) {
    try {
      await guild.commands.set([]);
    } catch (error) {
      // A guild that blocks this should not stop the bot from serving the others.
      log(`failed to clear the commands of guild ${guild.id}`, error);
    }
  }
}

async function handleDictionary(
  interaction: ChatInputCommandInteraction<"cached">,
  dictionary: FileDictionary,
): Promise<void> {
  const { guildId } = interaction;
  switch (interaction.options.getSubcommand()) {
    case "add": {
      const word = interaction.options.getString("word", true).trim();
      const reading = interaction.options.getString("reading", true).trim();
      const replaced = await dictionary.add(guildId, word, reading);
      await interaction.editReply(
        `${escapeMarkdown(word)} の読みを ${escapeMarkdown(reading)} に${replaced ? "更新" : "登録"}しました。`,
      );
      return;
    }
    case "del": {
      const word = interaction.options.getString("word", true).trim();
      const removed = await dictionary.remove(guildId, word);
      await interaction.editReply(
        `${escapeMarkdown(word)} ${removed ? "を辞書から消去しました。" : "は辞書に登録されていません。"}`,
      );
      return;
    }
    case "show": {
      const entries = await dictionary.list(guildId);
      if (entries.length === 0) {
        await interaction.editReply("辞書は空です。`/dict add` で登録できます。");
        return;
      }
      const [first, ...rest] = formatDictionary(entries);
      await interaction.editReply(first!);
      for (const page of rest) {
        await interaction.followUp(page);
      }
    }
  }
}

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  deps: {
    manager: SessionManager;
    engines: Record<EngineName, Engine>;
    dictionary: FileDictionary;
    defaultEngine: EngineName;
    log: (message: string, error?: unknown) => void;
  },
): Promise<void> {
  if (!interaction.inCachedGuild()) {
    await interaction.reply({ content: "サーバー内で実行してください。", flags: MessageFlags.Ephemeral });
    return;
  }

  if (interaction.commandName === "leave") {
    await interaction.deferReply();
    const left = await deps.manager.leave(interaction.guildId);
    await interaction.editReply(left ? "読み上げを終了しました。" : "読み上げ中ではありません。");
    return;
  }
  if (interaction.commandName === "dict") {
    await interaction.deferReply();
    try {
      await handleDictionary(interaction, deps.dictionary);
    } catch (error) {
      if (error instanceof UserFacingError) {
        await interaction.editReply(error.message);
      } else {
        deps.log("/dict failed", error);
        await interaction.editReply("辞書を操作できませんでした。時間をおいてお試しください。");
      }
    }
    return;
  }
  if (interaction.commandName === "voice") {
    await interaction.deferReply();
    try {
      const { label, credit } = await deps.manager.changeVoice(
        interaction.guildId,
        interaction.options.getString("speaker", true),
      );
      await interaction.editReply(`声を ${label} に変更しました。${credit ? `\n音声: ${credit}` : ""}`);
    } catch (error) {
      if (error instanceof UserFacingError) {
        await interaction.editReply(error.message);
      } else {
        deps.log("/voice failed", error);
        await interaction.editReply("声を変更できませんでした。時間をおいてお試しください。");
      }
    }
    return;
  }
  if (interaction.commandName !== "join") {
    return;
  }

  const channel = interaction.member.voice.channel;
  if (!channel) {
    await interaction.reply({ content: "先にVCへ参加してください。", flags: MessageFlags.Ephemeral });
    return;
  }
  const me = interaction.guild.members.me;
  const permissions = me && channel.permissionsFor(me);
  if (!permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
    await interaction.reply({
      content: "このVCに接続または発言する権限がbotにありません。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const requested = interaction.options.getString("engine");
  const engineName = requested && isEngineName(requested) ? requested : deps.defaultEngine;
  const engine = deps.engines[engineName];

  await interaction.deferReply();
  await interaction.editReply(`${engine.label} の音声合成Podを起動しています…`);
  try {
    const credit = await deps.manager.join({
      guildId: interaction.guildId,
      channelId: channel.id,
      engine: engineName,
    });
    const suffix = credit ? `\n音声: ${credit}` : "";
    await interaction.editReply(`<#${channel.id}> のチャットの読み上げを開始しました(${engine.label})。${suffix}`);
  } catch (error) {
    if (error instanceof UserFacingError) {
      await interaction.editReply(error.message);
    } else if (error instanceof Error && error.name === "AbortError") {
      await interaction.editReply("起動を中止しました。");
    } else {
      deps.log("/join failed", error);
      await interaction.editReply("起動に失敗しました。時間をおいてお試しください。");
    }
  }
}
