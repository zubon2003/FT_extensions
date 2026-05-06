# ExtensionNotifier (Extension Mode) の追加 — FPVTracksideCore

ブランチ: `POST-Notefication-Extension`  
関連リポジトリ: `FT_extensions`（同名ブランチ）— wire 仕様書を含む

## 概要

FPVTrackside にオプトイン式の **Extension Mode** を追加します。有効化すると、
既存の `RemoteNotifier` と並行して新しい `ExtensionNotifier` が起動します。
新 notifier は、レースロード、セクター対応の検出（順位スナップショット同梱）、
レース結果、ステージランキング、パイロットメディアパス等の拡張イベント群を、
既に Gate / LED POST notifications で設定済みの HTTP PUT / シリアル経路で送信します。

完全な wire 仕様は `FT_extensions/INTERFACE.en.md` および
`INTERFACE.ja.md` を参照（仕様書だけでテストクライアントを構築可能なように
意図的に自己完結的な内容としています）。

## 動機

既存 `RemoteNotifier` には、独立したリアルタイムレース表示、TTS アナウンス、
LED 制御を駆動するために必要なデータが含まれていません。具体的には:

- パイロットの発音テキスト・写真・動画パス
- セクター index と各セクター所要時間
- 検出ごとの順位スナップショット（受信側での再計算を不要に）
- カウントダウン開始時の予定レース開始時刻
- 次レース / 最終結果 / ステージランキングのイベント
- FPVTrackside のファイルシステムパスを伝達する Hello ハンドシェイク
  （Extension が `PhotoPath` 等の相対参照を解決可能にする）

これらイベントを消費する Extension 本体はリポジトリ外（`FT_extensions`）に
あります。本 PR はその FPVTrackside 側の contract です。

## 変更ファイル

| ファイル | 変更内容 |
|---|---|
| `UI/ApplicationProfileSettings.cs` | **+5行。** 既存 *Gate / LED POST notifications* カテゴリに `bool ExtensionMode`（既定 `false`, `[NeedsRestart]`）を追加。他プロパティへの変更なし |
| `UI/EventLayer.cs` | **+15行。** フィールド宣言、`ExtensionMode = true` 時のみ `ExtensionNotifier` をインスタンス化、Dispose を追加。`ExtensionMode = true` の場合、レガシー `RemoteNotifier` は `NotificationEnabled` の値に関わらず**抑止**される（同一 URL/シリアルポート上の二重発火を防止）。既存の `RemoteNotifier` 起動条件は本変更でのみ拡張 |
| `ExternalData/ExtensionNotifier.cs` | **新規ファイル。** wire contract を実装。`RaceManager.OnRacePreStart` を購読し、staggered / delayed / immediate のすべてのスタートパスで `RacePreStart` を発行する |

`ExternalData/RemoteNotifier.cs` は**変更していません**（`git diff` で確認済み）。

## 動作

### `ExtensionMode = false`（既定）の場合

現状と完全に同一の動作。`ExtensionNotifier` はインスタンス化されず、新規 HTTP
通信なし、新規シリアル書き込みなし、新規イベント購読なし、Hello ハートビートなし。
`RemoteNotifier` の既存バグ（`OnSplitDetection` + `OnLapDetected` がラップ終端で
二重発火する件など）も完全に温存。

### `ExtensionMode = true` の場合

`ExtensionNotifier` が起動します（同時に `RemoteNotifier` は抑止）。
以下を実行:

1. 起動時 2 秒間隔で `Hello` PUT を送信し、最初の 2xx 応答で停止。FPVTrackside の
   解決済みパス（`workingDirectory`, `baseDirectory`, `eventsDirectory`,
   `profileDirectory`, `pilotsDirectory`）、アクティブプロファイル名、
   `decimalPlaces`（表示桁数）、`timingSystem` スナップショット
   （システム数・ラップあたりセクター数・各システムの role/接続状態）、および
   `eventSettings`（`raceStartIgnoreDetections`、`minLapTime`、
   `primaryTimingSystemLocation`）を伝達。heartbeat 中の接続失敗
   （TCP refused / DNS / timeout）は仕様 §3.2 に従い無音化
2. 以下を購読・処理:
   - `RaceManager.OnRaceChanged` → `RaceLoaded` + `NextRace` 発行
   - `RaceManager.OnRacePreStart` → `RacePreStart` 発行（`scheduledStart` を
     `Event.MaxStartDelay` から best-effort で算出して同梱、staggered / delayed /
     immediate の全スタートパスで発火）
   - `RaceManager.OnRaceStart` / `OnRaceEnd` / `OnRaceCancelled` /
     `OnRaceTimesUp` → 対応するライフサイクルイベント
   - `RaceManager.OnSplitDetection` + `OnLapDetected` → 統合 `DetectionExt`
     （全パイロットの `PositionSnapshot` 同梱、`Detection.ID` で重複排除し
     上流の二重発火バグを抑止）
   - `RaceManager.OnPilotAdded` / `OnPilotRemoved` → `PilotRaceState`
   - `RaceManager.OnChannelCrashedOut` → `PilotCrashedOut`
   - `ResultManager.RaceResultsChanged` → `RaceResult`、加えて当該レースが
     ステージに属する場合（`Race.Round.Stage != null`）`StageRanking`

## レイテンシ / 堅牢性の改善（既存 RemoteNotifier との比較）

リアルタイム用途を意図し、既存 RemoteNotifier の複数のレイテンシボトルネックを
解消した設計です:

| 項目 | 既存 `RemoteNotifier` | `ExtensionNotifier` |
|---|---|---|
| ワーカーキュー | 1本（HTTP+Serial共有） | 2本独立（`-HTTP`, `-Serial`） |
| HTTP 待機 | イベント毎 10 秒 `WaitOne` | イベント毎 1.5 秒 `task.Wait` + `HttpClient` keep-alive |
| Serial WriteTimeout | 12 秒 | 100 ms（fire-and-forget、読み取りなし） |
| 検出二重送信 | あり（ラップ終端が 2 回） | `Detection.ID` でフィルタ |
| キュー容量 | 無制限 | 制限あり（HTTP 200, Serial 50）。満杯時は新規破棄 + 1 回ログ |
| 順位算出 | payload に無し | `Race.GetTrackPosition()` による**全パイロット**のスナップショットを payload に同梱（セクター考慮済み） |
| シーケンス番号 | なし | 全イベントに monotonic `seq` 付与 |

これらの改善は `ExtensionNotifier` 内に閉じます。既存 notifier の挙動は維持。

## 設定

*Application Profile Settings* → *Gate / LED POST notifications* にて:

- **Extension Mode** — 新規チェックボックス（既定オフ）。再起動必要
- **Notification URL** — 流用（同 URL に新イベント type も流れる）
- **Notification Serial Port** — 流用。Extension は LED 制御用の別 COM ポートを
  独自に開くことを推奨
- **Notification Enabled** — 既存 `RemoteNotifier` のみを制御。
  ただし *Extension Mode* が有効な場合、本フラグの値に関わらず
  `RemoteNotifier` は抑止される（同一 URL/COM ポートでの二重発火を防止）

両 notifier の同時稼働は行いません — *Extension Mode* が新ストリームに優先されます。

## 受信側要件（要点）

詳細は `FT_extensions/INTERFACE.ja.md` §10 を参照。要点:

1. ボディ処理の**前に** `200 OK` を返却 — さもないと送信側キューが詰まる
2. 未知の `type` 値を許容（レガシー notifier も同時稼働しうる）
3. `Hello` 受信時は `paths` ブロックを `config.json` にアトミックに永続化
4. `PhotoPath` は `paths.workingDirectory` を基準に解決

## テスト計画

- [ ] ソリューションビルド（`dotnet build "FPVTrackside - Core.sln"`） — エラー 0 で通過（確認済み）
- [ ] `ExtensionMode = false` かつ `NotificationEnabled = false` で起動 →
      `NotificationURL` への HTTP 通信なし、シリアル書き込みなしを確認
- [ ] `ExtensionMode = false` かつ `NotificationEnabled = true` で起動 →
      既存 `RemoteNotifier` のペイロードが従来通り到着することを確認
- [ ] `ExtensionMode = true`、Extension 未起動で FPVTrackside 起動 →
      Hello PUT が約 2 秒間隔で再試行され、送信側は正常動作継続（再試行ごとの
      ログノイズ無し）
- [ ] 最小 HTTP テストサーバ（INTERFACE §11）を起動して以下を確認:
  - Hello が 1 回到着、初回 2xx 後再試行停止
  - レース切替で `RaceLoaded` + `NextRace` 発火
  - カウントダウン開始時に `RacePreStart` が `ScheduledStart` を伴って到着
  - レース開始時に `RaceStart` が `ActualStart` を伴って到着
  - `DetectionExt` は検出毎に 1 回（同 `DetectionId` の重複なし）
  - `PositionSnapshot[]` の長さがレース内パイロット数に一致
  - レース終了後 `RaceResult` 到着、`Position` 昇順
  - `StageRanking` は `Race.Round.Stage != null` のときのみ到着
- [ ] `path.join(paths.workingDirectory, PhotoPath)` で正しく `PhotoPath` が解決
      されることを確認
- [ ] 負荷: Extension が PUT に < 5 ms で応答する条件下、毎秒複数セクターの
      検出でも送信側キューが詰まらないことを確認
- [ ] 異常系: Extension が 200 OK 返却後にハング → タイムアウト 1.5 秒で次へ進み、
      バウンドキューにより上限制御されることを確認

## 後方互換性

`ProfileSettings.xml` に `ExtensionMode` フィールドが無い既存ユーザ環境でも、
起動時に C# `bool` 既定の `false` として読み込まれるため、従来と同一動作と
なります。
