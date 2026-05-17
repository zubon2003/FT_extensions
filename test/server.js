#!/usr/bin/env node
// FPVTrackside Extension 受信テスト用の最小プログラム。
// 受信した JSON をコンソールに表示するだけ。
//
// 実行: node server.js   （ポートを変えるなら  PORT=9000 node server.js ）
//
// 仕様（INTERFACE.ja.md）に合わせて:
//   - HTTP PUT を待ち受ける（POST も念のため受け付ける）
//   - ボディを処理する前に必ず即座に 200 OK（空ボディ）を返す
//   - その後で受信 JSON を整形してコンソールに出力する

'use strict';

const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8765;

function stamp() {
  return new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    // ★ まず ack。ボディの処理・表示よりも前に返す。
    res.writeHead(200);
    res.end();

    const body = Buffer.concat(chunks).toString('utf8');
    const head = `[${stamp()}] ${req.method} ${req.url}`;

    if (!body) {
      console.log(`${head}  (empty body)`);
      return;
    }
    try {
      const evt = JSON.parse(body);
      console.log(`${head}  type=${evt.type} seq=${evt.seq}`);
      console.log(JSON.stringify(evt, null, 2));
    } catch (e) {
      // JSON でなければ生のまま表示
      console.log(`${head}  (non-JSON: ${e.message})`);
      console.log(body);
    }
    console.log('-'.repeat(60));
  });
});

server.listen(PORT, HOST, () => {
  console.log(`listening for FPVTrackside events on http://${HOST}:${PORT}/`);
});
