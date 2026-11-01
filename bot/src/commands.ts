import {
  type ChatInputCommandInteraction,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { ENGINE_NAMES, type Engine, type EngineName, isEngineName } from "./engines.js";
import { type SessionManager, UserFacingError } from "./session.js";

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
];

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

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  deps: {
    manager: SessionManager;
    engines: Record<EngineName, Engine>;
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
