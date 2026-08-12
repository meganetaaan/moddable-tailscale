# moddable-tailscale

ESP32/ESP32-S3上のModdableアプリケーションをTailnetの1ノードとして動かすための実験的な統合です。

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
control planeはTailscale公式サービスを対象とし、HeadscaleとTailnet Lockには対応していません。
OAuth Appsの[Device provisioning](https://tailscale.com/docs/features/oauth-apps/device-provisioning)も今回の実装範囲外です。

## 対象環境

- Moddable SDK 9.0.0
- ESP-IDF v6.0.2
- ESP32-S3と8 MB PSRAMを持つM5Stack CoreS3
- ESP32と4 MB PSRAMを持つM5Stack M5Camera（U017）
- デバイスを登録できるTailscaleアカウント（tag付き自動登録ではauth keyも必要）

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

`credentials.js`へWi-Fiを設定します。`tailscale.authKey`は任意です。省略すると、初回起動時に
Tailscale標準のAuthURL認証を開始します。
この値は初回起動用のfallbackで、同じfirmwareを複数台へ書き込めます。
各個体のIDはeFuse MACからCoreS3では`cores3-xxxxxxxxxxxx`、M5Cameraでは
`m5camera-xxxxxxxxxxxx`、Tailnet上の名前はいずれも`stackcam-xxxxxx`として
自動生成されます。このファイルは`.gitignore`の対象です。

中央PCのTailscaleマシン名は`stackchan-hub`にします。MagicDNSを有効にすると、
各カメラ端末は固定URL `ws://stackchan-hub:8080/camera`へ接続するため、中央PCの
100.xアドレスが変わってもfirmwareの再設定は不要です。

AuthURLで登録したカメラは、ログインしたユーザーが所有する端末です。収録policyの
`autogroup:member` grantによってHubのTCP 8080へ接続できますが、そのユーザーに許可された
他のアクセス権も継承します。カメラをHubだけへ制限したい常設配備では、たとえば
[`tag:stackchan-camera`](https://tailscale.com/docs/features/tags)のownerを管理者に限定し、
端末用auth keyへこのtagを付与して、
`tag:stackchan-camera`から中央PCのTCP 8080だけを許可します。同一imageへkeyも埋め込んで
複数台へ配る場合は、有効期限を短くしたreusable tagged keyが必要です。USB/BLEで
個体ごとに設定する運用ならone-off tagged keyを推奨します。

中央PCを専用サーバーとして扱う場合は`tag:stackchan-hub`を付け、
[grant](https://tailscale.com/docs/features/access-control/grants)で通信先を制限します。
[`examples/tailnet-policy.hujson`](examples/tailnet-policy.hujson)に、カメラからHubの
TCP 8080だけを許可し、Tailnet memberから監視画面を許可するpolicyとテストを収録しています。
既存policyへ適用するときは`tagOwners`、`grants`、`tests`の各要素をマージし、Tailscale管理画面の
policy validatorでテストが通ることを確認してから保存してください。

中央PCへのtag付与は管理画面のMachines/Devicesから`tag:stackchan-hub`を追加するか、
PowerShellで`tailscale login --advertise-tags=tag:stackchan-hub`を実行して再認証します。
CoreS3/M5Cameraへ後述の端末別provisioningで`tag:stackchan-camera`付きauth keyを設定した場合は、
登録と同時にtag identityになります。auth keyを省略した通常のAuthURL登録ではuser identityのままです。

Tagを付けるとnodeのuser identityがtag identityへ置き換わるため、中央PCを
user-owned deviceのままにする場合は`tag:stackchan-hub`を付けません。
その場合は中央PCのTailscale IPをpolicyの`hosts`に登録し、host aliasをgrant先に
します。policyのhost aliasはMagicDNS名とは別物です。

PC側ではTailnetへ接続した状態でcamera relay serverを起動できます。

```sh
deno run --allow-net tools/camera-server.ts 8080 "$(tailscale ip -4)"
```

`--state-dir`を指定すると、端末レジストリ、コマンド履歴、各端末の最終JPEGを保存します。
JPEGの書き込みは最大で約1回/秒・端末にまとめられ、Hub再起動後は各端末をOFFLINE表示のまま
最終画像付きで復元します。

```powershell
$state = Join-Path $env:LOCALAPPDATA "StackChanCameraHub"
deno run --allow-net "--allow-read=$state" "--allow-write=$state" `
  tools/camera-server.ts 8080 (tailscale ip -4 | Select-Object -First 1) `
  "--state-dir=$state"
```

Windowsログオン時にHubを自動起動し、異常終了時に1分後から再起動するユーザー単位の
Scheduled Taskは次で登録できます。launcherはmutexで同じportの二重起動を防ぎます。

```powershell
./scripts/install-camera-hub.ps1
Get-ScheduledTask StackChanCameraHub | Get-ScheduledTaskInfo
```

解除する場合は`./scripts/install-camera-hub.ps1 -Uninstall`を実行します。リポジトリを移動すると
Scheduled Task内のscript pathが古くなるため、移動後にinstall scriptを再実行してください。

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
hubとのWebSocketが終了した場合は本体を再起動せず、Wi-Fi/TailnetとWebSocketを段階的に再接続します。
カメラは接続をまたいで維持し、送信timerからnative camera queueを直接読みます。sensorの撮影周期ごとの
`onReadable`通知をJS queueへ積まないため、hub再起動後や8 fps送信時もevent queueを詰まらせません。
映像送信は各timer callbackで1 frameだけ処理する状態機械として動作し、8 fpsの連続配信でも
WebSocketの送信キューへcallback方式で直接投入します。高頻度のWritableStream Promise連鎖による
JavaScript stackの増加を避けます。Tailnet、WebSocket、camera処理が重なる瞬間のpeakに備え、
CoreS3とM5CameraはいずれもXS stackを8192 slots確保します。
Denoは30秒のidle timeoutでRFC 6455 pingを送り、Moddableの下位WebSocketClientが
同じpayloadのpongを自動返信します。アプリケーション独自のheartbeat messageは使いません。
CoreS3はcontrol ping受信または映像フレーム送信成功のたびにJS外のESP-IDF timer watchdogを
feedし、75秒間どちらも進まない場合だけ再起動して復旧します。Wi-Fiの省電力機能は無効化して
受信遅延を抑え、切断時はESP-IDFのreason codeをserial traceへ出力します。
MicroLinkのTCP送信は5秒の`SO_SNDTIMEO`を使い、送信windowが回復しない場合は
`EAGAIN`を無期限再試行せずtransport errorとしてWebSocketの再接続へ進みます。
WireGuard handshakeにはSNTP同期済みのwall clockを使い、再起動後の古いuptimeがreplay判定されるのを防ぎます。
USBモニター未接続時の出力詰まりを避けるため、映像フレームとWireGuard DATAパケットのログは間引かれます。

### M5Cameraターゲット

M5Camera（U017）はCoreS3と同じcamera hub protocol、Tailnet transport、設定保存を使いますが、
初代ESP32、OV2640、4 MB flash向けの別firmware imageです。同じsourceと
`credentials.js` fallbackから複数台へ書き込めますが、CoreS3用binaryそのものは書き込めません。

OV2640から320x240 JPEGを直接取得するためsoftware再encodeは行わず、Hubからの要求に応じて
1〜8 fpsで送信します。画面がないため状態はserial traceと基板上のGPIO14 LEDへ出力し、
BLE provisioningは含めません。LEDは接続処理中に500 ms間隔、AuthURL/承認待ちは1秒間隔で点滅し、Wi-Fi、Tailnet、
WebSocket、映像送信がすべて確立すると点灯します。エラーまたは切断時は125 ms間隔で点滅し、
`device.identify`を受信したときも指定時間だけ125 ms間隔で点滅してから現在状態へ戻ります。
CP2104のUSB serial（UART0、115200 baud）からCoreS3と同じJSON provisioning protocolを使用できます。

```sh
./scripts/build-m5camera-example.sh release
```

書き込みまで行う場合はM5CameraのUSB portを接続して次を実行します。

```sh
cd examples/m5camera-websocket
mcconfig -m -p esp32
```

release firmwareへ個体設定を書き込む場合は、後述の`provision-usb.ps1`または
`provision-camera.ps1`へCP2104のCOM portを指定します。debug buildではUART0をModdable debuggerが
使用するため、このserial provisioning経路は無効です。

### 個体設定

設定はversion 1のままNVSへ保存され、`credentials.js`より優先されます。Release firmwareでは
USB Serial/JTAGを使ってWindows PowerShellからWi-FiとHub URLだけを設定できます。

```powershell
./scripts/provision-usb.ps1 set -Port COM4 `
  -WifiSsid "YOUR_WIFI_SSID" -WifiPassword "YOUR_WIFI_PASSWORD"
./scripts/provision-usb.ps1 get -Port COM4
```

`get`はSSID、auth key/passwordの設定有無、device ID、hub URLだけを返し、秘密値は返しません。
`clear`でNVS設定を削除してfirmware内fallbackへ戻し、`restart`で再起動できます。保存済みauth keyだけを
削除するには`set -ClearAuthKey`、Wi-Fi/Hub設定を残してTailnet identityを消すには
`tailnet-reset`を使います。後者では管理画面の旧端末がofflineのまま残る場合があります。

Windows版ChromeまたはEdgeで`http://localhost:8080/provision`を開くと、同じ設定を
Web Serialだけで完結できます。「USBシリアルで接続」を押してM5CameraのCP2104 COM portを
選択してください。WSLへUSB接続中、書き込み中、またはserial monitor起動中はWindowsブラウザーから
COM portを開けないため、先にそれらを終了またはdetachします。空欄のWi-Fi passwordと
Tailscale auth keyは既存値を保持し、ブラウザーには秘密値そのものを返しません。

保存ACK後は自動的に再起動し、許可済みWeb Serial portへ最大30秒間再接続します。auth keyが
設定されていなければ、CoreS3はAuthURLのQRを画面へ表示します。M5Cameraでは再接続後の設定ページに
同じURLの認証ボタンと、ブラウザー内で生成したローカルQRを表示します。CoreS3はUSB/BLE設定ページ向けにも
任意の`authQR` bit matrixを返します。QR生成に外部サービスやHub APIは使わず、AuthURLを第三者へ
送信しません。Tailnet側で端末承認が必要な
policyでは、QRを消して管理画面での承認待ちを表示します。`Tailnet登録をやり直す`はWi-Fi/Hub設定を
保持したままauth keyとidentityを消去し、新しいAuthURLを発行します。

provisioning protocolの`provision.get` ACKには
`runtime.tailnet: {state, authURL?, authQR?, error?}`が付きます。状態が変化したときは同じruntimeを
`provision.status`としてUSB/BLEへ通知します。`authURL`と`authQR`は`needs-auth`の間だけUIに表示し、
保存や通常ログへの出力は行いません。

端末ごとに再利用不可のtagged auth keyを自動発行して、そのままUSB設定する場合は、Tailscale
管理画面でOAuth clientを作成します。`auth_keys`のwrite scopeと
`tag:stackchan-camera`を付与し、client ID/secretを環境変数へ入れて実行してください。
auth keyは既定で1時間有効、pre-authorized、non-reusable、non-ephemeralとして生成され、
画面やファイルへ出さず`provision-usb.ps1`へ直接渡されます。

```powershell
$env:TS_API_CLIENT_ID = "k..."
$env:TS_API_CLIENT_SECRET = "tskey-client-..."
./scripts/provision-camera.ps1 -Port COM4 `
  -WifiSsid "YOUR_WIFI_SSID" -WifiPassword "YOUR_WIFI_PASSWORD"
Remove-Item Env:TS_API_CLIENT_SECRET
```

OAuth client secretはauth keyより強い長期資格情報です。中央PCだけで扱い、ブラウザーや
firmwareへ渡さないでください。BLE設定では管理者資格情報をブラウザーへ置かず、管理画面で
発行したone-off keyを従来どおり入力します。

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
  deviceName: "stackchan-cores3",
  priorityPeer: "100.64.0.1",
  connectTimeout: 60_000,
  onAuthRequired(url) {
    showLocalQRCode(url);
  },
});

await tailnet.start();
trace(`address=${tailnet.vpnAddress}\n`);
trace(JSON.stringify(tailnet.peers), "\n");
```

`authKey`は任意です。省略時は`state`が`needs-auth`となり、`authURL`と
`onAuthRequired(url)`でTailscaleの認証URLを取得できます。URLが変わらない限りcallbackは
再通知されません。端末承認が必要な場合は`needs-approval`になります。`start()`は接続完了まで
pendingのままですが、この2状態でユーザーを待つ時間は`connectTimeout`へ算入しません。
この処理はTailscaleの
[`RegisterRequest.Followup` / `RegisterResponse.AuthURL`](https://github.com/tailscale/tailscale/blob/main/tailcfg/tailcfg.go)
を使い、同じnode keyで新しいcontrol接続から認証完了を確認します。
node keyが期限切れになるとactive transportを閉じて`reconnecting`へ移り、古いnode keyを
`OldNodeKey`として保持したまま新しいAuthURL登録へ進みます。通常再起動では保存済みidentityを再利用します。

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

AuthURL登録はバックエンド資格情報を不要にしますが、端末はログインユーザー所有となり、そのユーザーの
grantsを継承します。最小権限の無人端末には、[`Tailscaleの公式ガイド`](https://tailscale.com/docs/features/access-control/auth-keys)で
発行したtag付きauth keyを設定し、必要最小限のACLを割り当ててください。
可能ならone-off keyを使い、登録後に再利用できない状態にしてください。
`credentials.js`はファームウェアへ埋め込まれるため、Gitから除外してもflashを読める攻撃者から秘密を守る仕組みにはなりません。
漏えいが疑われるauth keyはTailnet管理画面で失効させてください。

DERPのTLSはESP-IDF証明書バンドルで検証しますが、WireGuard内の`ws://`は接続先アプリケーションをTLS証明書で認証しません。
アプリケーションレベルの認証が必要な場合は、プロトコル内認証を追加するか、今後`TLSSocket`をこのTCP実装へ重ねる必要があります。

## 検証

依存commit、パッチの再実行性、DERP TLS設定、Noise AEAD固定ベクトル、Register codec fixture、manifest JSON、auth keyの混入を検査します。

```sh
./scripts/verify.sh
deno fmt --check tools/echo-server.ts tools/camera-server.ts tools/camera-server.test.ts tools/camera-soak.ts tools/camera-soak.test.ts
deno check tools/echo-server.ts tools/camera-server.ts tools/camera-server.test.ts tools/camera-soak.ts tools/camera-soak.test.ts
deno test --allow-net --allow-read --allow-write tools/camera-server.test.ts tools/camera-soak.test.ts
```

実機を使わず、2台の仮想カメラを詳細表示の8fpsで10分間流すsoak testは次で実行します。
進捗は30秒ごとにJSONで出力され、ONLINE状態、要求fps、フレーム配送率、予期しない切断を検証します。

```sh
deno run --allow-net tools/camera-soak.ts --duration-seconds=600 --devices=2 --fps=8
```

固定ベクトルは、Tailscale公式`controlbase`と同じbig-endian counterをChaCha20-Poly1305 nonceへ配置して検証します。

## ライセンス

このリポジトリ固有のコードはMIT Licenseです。
MicroLink、wireguard-lwip、暗号実装、cJSON、Moddable SDK、ESP-IDFにはそれぞれのライセンスが適用されます。
詳細は[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)を参照してください。
