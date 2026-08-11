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

`credentials.js`へWi-Fiと、CoreS3用tagを付けたauth keyを設定します。
この値は初回起動用のfallbackで、同じfirmwareを複数台へ書き込めます。
各個体のIDはeFuse MACから`cores3-xxxxxxxxxxxx`、Tailnet上の名前は
`stackcam-xxxxxx`として自動生成されます。このファイルは`.gitignore`の対象です。

中央PCのTailscaleマシン名は`stackchan-hub`にします。MagicDNSを有効にすると、
CoreS3は固定URL `ws://stackchan-hub:8080/camera`へ接続するため、中央PCの
100.xアドレスが変わってもfirmwareの再設定は不要です。Tailnet policyでは、たとえば
[`tag:stackchan-camera`](https://tailscale.com/docs/features/tags)のownerを管理者に限定し、
CoreS3用auth keyへこのtagを付与して、
`tag:stackchan-camera`から中央PCのTCP 8080だけを許可します。同一imageへkeyも埋め込んで
複数台へ配る場合は、有効期限を短くしたreusable tagged keyが必要です。USB/BLEで
個体ごとに設定する運用ならone-off tagged keyを推奨します。

中央PCを専用サーバーとして扱う場合は`tag:stackchan-hub`を付け、
[grant](https://tailscale.com/docs/features/access-control/grants)を次のように追加します。
既存の`tagOwners`と`grants`は消さず、それぞれのobjectとarrayへマージしてください。

```json
{
  "tagOwners": {
    "tag:stackchan-camera": [],
    "tag:stackchan-hub": []
  },
  "grants": [
    {
      "src": ["tag:stackchan-camera"],
      "dst": ["tag:stackchan-hub"],
      "ip": ["tcp:8080"]
    },
    {
      "src": ["autogroup:member"],
      "dst": ["tag:stackchan-hub"],
      "ip": ["tcp:8080"]
    }
  ]
}
```

Tagを付けるとnodeのuser identityがtag identityへ置き換わるため、中央PCを
user-owned deviceのままにする場合は`tag:stackchan-hub`を付けません。
その場合は中央PCのTailscale IPをpolicyの`hosts`に登録し、host aliasをgrant先に
します。policyのhost aliasはMagicDNS名とは別物です。

PC側ではTailnetへ接続した状態でcamera relay serverを起動できます。

```sh
deno run --allow-net tools/camera-server.ts 8080 "$(tailscale ip -4)"
```

Tailnet IPを指定した場合は`127.0.0.1:8080`でも同じregistryを自動的に待ち受けます。
カメラ側はTailnetから、管理画面とBLE設定は中央PCのlocalhostから利用でき、LAN側へ
8080を公開しません。

CoreS3は240x176 JPEGをTailnet上のWebSocketへ送信します。
内蔵GC0308はJPEGを直接出力しないため、RGB565で撮影してデバイス上でJPEGへ変換します。
送信速度は閲覧者なしで1 fps、グリッド表示中は2 fps、詳細表示中は8 fpsへ自動調整します。
ブラウザーで`http://localhost:8080/`または`http://<PCのTailnet IP>:8080/`を開くと、
登録済みカメラがグリッド表示されます。カードをクリックすると、その個体の8 fps詳細表示と
identify、TTS、パン・チルト用コマンドUIを開けます。TTSとパン・チルトは将来の
Stack-chan firmware向けコマンド経路までを実装し、このカメラ専用firmwareでは
`not_supported`を返します。
Windows Firewallなどで公開範囲を制限する場合は、PCのTailnet IPへ明示的にbindできます。

```sh
deno run --allow-net tools/camera-server.ts 8080 100.x.y.z
```

CoreS3向けサンプルをビルドします。初回はESP-IDF Component Managerで
`esp32-camera`と`esp_jpeg`を準備してからビルドするスクリプトを使います。

```sh
./scripts/build-camera-example.sh release
```

デバッガーを使う場合は`./scripts/build-camera-example.sh debug`を指定します。

ビルドと書き込みを同時に行う場合は次を実行します。

```sh
cd examples/cores3-websocket
mcconfig -m -p esp32/m5stack_cores3
```

サンプルはCoreS3の画面へWi-Fi、Tailnet、WebSocket、カメラ送信の状態を表示します。
CoreS3固有の電源・I2C・ディスプレイ設定を使うため、`-p esp32/m5stack_cores3`を指定します。
配信確立後にhubとのWebSocketが終了した場合は、ESP32版WebSocketStreamの停止回避として
CoreS3を明示的に再起動し、Wi-Fi/Tailnet登録から自動復旧します。初回接続失敗は再起動せず再試行します。
Denoは30秒のidle timeoutでRFC 6455 pingを送り、Moddableの下位WebSocketClientが
同じpayloadのpongを自動返信します。アプリケーション独自のheartbeat messageは使いません。
CoreS3はcontrol ping受信または映像フレーム送信成功のたびにJS外のESP-IDF timer watchdogを
feedし、25秒間どちらも進まなければ再起動して復旧します。
WireGuard handshakeにはSNTP同期済みのwall clockを使い、再起動後の古いuptimeがreplay判定されるのを防ぎます。
USBモニター未接続時の出力詰まりを避けるため、映像フレームとWireGuard DATAパケットのログは間引かれます。

### 個体設定

設定はNVSへ保存され、`credentials.js`より優先されます。Release firmwareでは
USB Serial/JTAGを使ってWindows PowerShellから設定できます。auth keyをコマンド履歴へ
残さないよう環境変数で渡します。

```powershell
$env:STACKCHAN_AUTH_KEY = "tskey-auth-..."
./scripts/provision-usb.ps1 set -Port COM4 `
  -WifiSsid "YOUR_WIFI_SSID" -WifiPassword "YOUR_WIFI_PASSWORD"
./scripts/provision-usb.ps1 get -Port COM4
```

`get`はSSID、auth key/passwordの設定有無、device ID、hub URLだけを返し、秘密値は返しません。
`clear`でNVS設定を削除してfirmware内fallbackへ戻し、`restart`で再起動できます。

BLE設定は未接続時に3分間advertiseし、接続中は受付タイマーを停止します。Windowsでは最初に
「設定」→「Bluetoothとデバイス」→「デバイスの追加」から`StackCam-…`を選び、CoreS3画面の
6桁passkeyでOSペアリングしてください。その後、中央サーバーを同じPCで起動し、Windows版
ChromeまたはEdgeで`http://localhost:8080/provision`を開いて「BLEで接続」を押します。
Web Bluetoothのsecure-context制約があるため、Tailnet IPやCodex内蔵ブラウザではなく
`localhost`を使用してください。BLE characteristicは暗号化、MITM protection、bondingを要求します。

### カメラサーバーAPI

- `GET /api/devices`: 全個体のonline状態、最終フレーム、要求fps、コマンド履歴
- `GET /api/devices/:id`: 1個体の状態
- `GET /devices/:id/stream.mjpg?mode=grid|detail`: 個体別MJPEG
- `GET /devices/:id/latest.jpg`: offline時にも残る最終JPEG
- `POST /api/devices/:id/commands`: `stream.set`、`device.identify`、`tts.speak`、`panTilt.move`

デバイスは`/camera`接続直後にprotocol 1の`device.hello`を送ります。サーバーは
同じdevice IDの再接続を置換し、別個体の映像やackを混同しません。

既存のｽﾀｯｸﾁｬﾝへ統合するときは、ルートの`manifest.json`をアプリケーションmanifestからincludeしてください。
また、[`sdkconfig.defaults`](examples/cores3-websocket/sdkconfig-cores3/sdkconfig.defaults)のPSRAM、socket数、TCP buffer、IP fragmentation、PPP、証明書バンドル設定を、CoreS3ターゲットで最終的に有効になる`SDKCONFIGPATH`へマージしてください。

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
deno fmt --check tools/echo-server.ts tools/camera-server.ts tools/camera-server.test.ts
deno check tools/echo-server.ts tools/camera-server.ts tools/camera-server.test.ts
deno test --allow-net tools/camera-server.test.ts
```

固定ベクトルは、Tailscale公式`controlbase`と同じbig-endian counterをChaCha20-Poly1305 nonceへ配置して検証します。

## ライセンス

このリポジトリ固有のコードはMIT Licenseです。
MicroLink、wireguard-lwip、暗号実装、cJSON、Moddable SDK、ESP-IDFにはそれぞれのライセンスが適用されます。
詳細は[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)を参照してください。
