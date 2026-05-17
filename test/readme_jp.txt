FPVTrackside Extension 受信テスト用プログラム
=============================================

server.js は、FPVTrackside (ExtensionMode = true) から送られてくる
イベント JSON を受信し、コンソールに表示するだけの最小プログラムです。


必要なもの
----------
- Node.js（標準モジュールのみ使用。npm install 不要）


実行方法
--------
  node server.js

起動すると次のように表示されます:

  listening for FPVTrackside events on http://127.0.0.1:8765/

この状態で FPVTrackside 側の NotificationURL を
http://127.0.0.1:8765/ に設定し、ExtensionMode を有効にすると、
イベントを受信するたびに内容がコンソールに出力されます。


ポートの変更
------------
デフォルトは 8765。変更する場合は環境変数 PORT を指定します。

  Windows PowerShell:
    $env:PORT=9000; node server.js

  Windows コマンドプロンプト:
    set PORT=9000 && node server.js

  macOS / Linux:
    PORT=9000 node server.js


動作仕様
--------
INTERFACE.ja.md に準拠しています。

- 127.0.0.1:8765 で HTTP PUT を待ち受け（POST も受け付け）
- ボディを処理する前に必ず即座に 200 OK（空ボディ）を返す（§2.3）
- その後、受信 JSON を以下の形式でコンソール出力:
    [HH:MM:SS.mmm] PUT /  type=<イベント名> seq=<番号>
    { 整形済み JSON }
    ------------------------------------------------------------
- JSON としてパースできない場合は生データをそのまま表示


注意
----
表示専用です。config.json への永続化、seq/重複検知、TTS/LED 出力
などは行いません。受信内容の確認・デバッグ用途を想定しています。
