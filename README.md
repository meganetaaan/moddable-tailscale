# moddable-tailscale

ESP32-S3上のModdableアプリケーションをTailnetの1ノードとして動かすための実験的な統合です。

TailscaleプロトコルはXS JavaScriptで再実装せず、MicroLinkをESP-IDFネイティブ層へ固定バージョンで組み込みます。
JavaScript側には、送信TCPをWHATWG Streams、WebSocketStream用ECMA-419ソケット、双方向UDPとして公開します。

> [!WARNING]
> MicroLinkはTailscale公式クライアントではなく、独立したコミュニティ実装です。
> セキュリティ、プロトコル互換性、Tailnet内での到達性を実機と対象アカウントで評価してから利用してください。

## 実装範囲

このリポジトリが提供する境界は次のとおりです。

- MicroLinkのcoordination、WireGuard、DISCO、STUN、DERP、peer mapをModdableビルドへ統合します。
- Tailnetから割り当てられた`100.64.0.0/10`のIPv4アドレスとpeer一覧を取得できます。
- Tailnet内のpeerへ、最大1本の送信TCP接続を開けます。
- TCP接続を`ReadableStream`と`WritableStream`として扱えます。
- Moddable 9.0.0の`WebSocketStream`を平文`ws://`でTailnet上へ接続できます。
- 最大1個のUDPソケットを開き、1データグラムを1チャンクとして送受信できます。
- Wi-Fi再接続後にMicroLinkのセッションを維持したまま`rebind()`できます。

TCPの`listen()`と`accept()`、複数TCP接続、複数UDPソケット、IPv6、subnet router、exit node、Tailscale SSH、Serve、Funnelは実装していません。
既存のModdable HTTP/WebSocketサーバーを100.xアドレスで待ち受けさせる用途には、MicroLinkまたはlwIP netif側の追加実装が必要です。

## 対象環境

- Moddable SDK 9.0.0
- ESP-IDF v6.0.2
- ESP32-S3
- 8 MB PSRAMを持つM5Stack CoreS3
- Tailscale auth keyを発行できるTailnet

Moddable 9.0.0が要求するESP-IDFの版は`v6.0.2`です。
この統合は、ESP-IDF 6で削除されたMbed TLS APIをPSA Cryptoへ移行し、DERP TLSで証明書バンドル、ホスト名検証、`VERIFY_REQUIRED`を有効にします。

## セットアップ

Moddable SDKとESP-IDFを通常の手順でセットアップし、`MODDABLE`、`IDF_PATH`、ビルドツールへの`PATH`を設定します。

MicroLinkはsubmoduleではなく、固定commitを取得してローカルパッチを適用します。

```sh
./scripts/bootstrap.sh
```

サンプル用の認証情報を作成します。

```sh
cp examples/cores3-websocket/credentials.example.js \
  examples/cores3-websocket/credentials.js
```

`credentials.js`へWi-Fi、auth key、Tailnet内のWebSocket URLを設定します。
このファイルは`.gitignore`の対象です。

PC側ではTailnetへ接続した状態でecho serverを起動できます。

```sh
deno run --allow-net tools/echo-server.ts 8080
```

CoreS3向けサンプルをビルドして書き込みます。

```sh
cd examples/cores3-websocket
mcconfig -d -m -p esp32/m5stack_cores3
```

サンプルはCoreS3の画面へWi-Fi、Tailnet、WebSocket、echoの状態を表示します。
CoreS3固有の電源・I2C・ディスプレイ設定を使うため、`-p esp32/m5stack_cores3`を指定します。

既存のｽﾀｯｸﾁｬﾝへ統合するときは、ルートの`manifest.json`をアプリケーションmanifestからincludeしてください。
また、[`sdkconfig.defaults`](examples/cores3-websocket/sdkconfig/sdkconfig.defaults)のPSRAM、socket数、TCP buffer、IP fragmentation、PPP、証明書バンドル設定を、CoreS3ターゲットで最終的に有効になる`SDKCONFIGPATH`へマージしてください。

## JavaScript API

Tailnetを開始する前に、TLS証明書検証に使える時刻をSNTPなどで設定してください。

```js
import Tailnet from "tailscale";

const tailnet = new Tailnet({
  authKey: "tskey-auth-...",
  deviceName: "stackchan-cores3",
  priorityPeer: "100.64.0.1",
  connectTimeout: 60_000,
});

await tailnet.start();
trace(`address=${tailnet.vpnAddress}\n`);
trace(JSON.stringify(tailnet.peers), "\n");
```

`priorityPeer`は、最大8 peerの固定テーブルが埋まった場合にも保持したい接続先です。

TCPはWHATWG Streamsとして開きます。

```js
const {readable, writable, socket} = await tailnet.connect({
  host: "peer-name",
  port: 9000,
});

await readable.pipeTo(messageConsumer);
await audioSource.pipeTo(writable);
socket.close();
```

`host`には100.xアドレス、または現在のpeer mapで解決できるMagicDNS名を指定します。
受信・送信ringはそれぞれ16 KiBで、ネイティブI/OはXSスレッド外のFreeRTOS taskで実行されます。

WebSocketStreamには下位transport設定を渡します。

```js
import WebSocketStream from "web/websocketstream";

const websocket = new WebSocketStream(
  "ws://peer-name:8080/echo",
  {ws: tailnet.ws},
);
const {readable, writable} = await websocket.opened;
```

UDPは固定長4 packetの受信・送信queueを使い、受信超過時は最古のpacketを破棄します。

```js
const udp = tailnet.openDatagram({port: 9000});
udp.write(payload, "100.64.0.1", 9000);

const packet = udp.read();
if (packet)
  trace(`${packet.address}:${packet.port} ${packet.byteLength}\n`);
```

Wi-Fiが別の経路へ復帰した場合は`await tailnet.rebind()`を呼び、終了時は`await tailnet.close()`を呼びます。
保存済みmachine key、WireGuard key、peer cacheを消すには、Tailnetインスタンスが存在しない状態で`Tailnet.factoryReset()`を呼びます。

## セキュリティ

auth keyは[`Tailscaleの公式ガイド`](https://tailscale.com/docs/features/access-control/auth-keys)で発行し、必要最小限のtagとACLを割り当ててください。
可能ならone-off keyを使い、登録後に再利用できない状態にしてください。
`credentials.js`はファームウェアへ埋め込まれるため、Gitから除外してもflashを読める攻撃者から秘密を守る仕組みにはなりません。
漏えいが疑われるauth keyはTailnet管理画面で失効させてください。

DERPのTLSはESP-IDF証明書バンドルで検証しますが、WireGuard内の`ws://`は接続先アプリケーションをTLS証明書で認証しません。
アプリケーションレベルの認証が必要な場合は、プロトコル内認証を追加するか、今後`TLSSocket`をこのTCP実装へ重ねる必要があります。

## 検証

依存commit、パッチの再実行性、DERP TLS設定、Noise AEAD固定ベクトル、manifest JSON、auth keyの混入を検査します。

```sh
./scripts/verify.sh
deno fmt --check tools/echo-server.ts
deno check tools/echo-server.ts
```

固定ベクトルは、Tailscale公式`controlbase`と同じbig-endian counterをChaCha20-Poly1305 nonceへ配置して検証します。

## ライセンス

このリポジトリ固有のコードはMIT Licenseです。
MicroLink、wireguard-lwip、暗号実装、cJSON、Moddable SDK、ESP-IDFにはそれぞれのライセンスが適用されます。
詳細は[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)を参照してください。
