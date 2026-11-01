# discord-tts

VCのチャットを読み上げてVCに流すDiscord bot。常駐するのはbot本体だけで、音声合成Podは `/join` のときに起動し、VCから切断すると削除します。

```
Discord ⇄ bot Deployment(常駐)
            │  /join → Pod作成 → Ready待ち → VC接続
            │  チャット受信 → HTTPで合成 → VCへ再生
            ▼
          tts-<engine>-xxxxx Pod(セッションごとに1つ)
```

## コマンド

| コマンド | 動作 |
|---|---|
| `/join [engine]` | 実行者が参加中のVCに入り、そのVCのチャットを読み上げる。`engine` は `Open JTalk` か `VOICEVOX` |
| `/leave` | 読み上げを終了してVCから退出する |
| `/voice <speaker>` | 読み上げの声を変更する(VOICEVOXのみ)。サーバー全体に効き、`/leave` すると既定の声に戻る |

メッセージは「サーバーニックネーム、本文」の順に読み上げます。

読み上げは次の場合にも終了し、Podを削除します。

- botがVCから切断された、または別のVCへ移動させられた
- VCから人が全員退出した

## 音声合成エンジン

| エンジン | イメージ | requests / limits | 備考 |
|---|---|---|---|
| Open JTalk | `openjtalk-server/` でビルド | 50m, 64Mi / 500m, 128Mi | 既定のエンジン |
| VOICEVOX | `docker.io/voicevox/voicevox_engine:cpu-*` | 500m, 512Mi / 2, 3Gi | 利用時は `/join` の応答に音声ライブラリのクレジットを表示する |

## 設定

bot本体の環境変数です。

| 変数 | 必須 | 既定値 | 説明 |
|---|---|---|---|
| `DISCORD_TOKEN` | はい | | botトークン |
| `POD_NAMESPACE` / `POD_NAME` / `POD_UID` | はい | | Downward APIで渡す。TTS Podの作成先とownerReferenceに使う |
| `OPENJTALK_IMAGE` / `VOICEVOX_IMAGE` | はい | | TTS Podのイメージ |
| `DEFAULT_ENGINE` | | `openjtalk` | `engine` 省略時のエンジン |
| `MAX_SESSIONS` | | `2` | 同時セッション数の上限 |
| `VOICEVOX_SPEAKER` | | `3` | VOICEVOXのスタイルID(3はずんだもんノーマル) |
| `ACTIVITY_NAME` | | なし | botの「プレイ中」に表示する文字列。未設定なら何も表示しない |

## Discord側の設定

1. Developer PortalでBotを作成し、**Message Content Intent** を有効にする。
2. `bot` と `applications.commands` のスコープで招待する。権限は「チャンネルを見る」「メッセージを送信」「接続」「発言」。

## 開発

```sh
(cd openjtalk-server && go test ./...)
(cd bot && npm ci && npm run typecheck && npm test)
```

デプロイ用マニフェストは [dodolia907/k8s](https://github.com/dodolia907/k8s) の `manifest/cts/discord-tts/` にあります。
