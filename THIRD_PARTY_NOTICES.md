# Third-party notices

`scripts/bootstrap.sh`が取得するMicroLinkと、ビルド時に取得または参照する各コンポーネントには、次のライセンスが適用されます。

## MicroLink

Source: <https://github.com/CamM2325/microlink>

Pinned commit: `216da3300f0493b0860247d43f7af5ce29df63a5`

License: MIT

Copyright (c) 2025-2026 Cameron Malone

MicroLinkはTailscaleプロトコルの独立実装であり、Tailscale Inc.による公式クライアントではありません。
TailscaleおよびWireGuardの名称・商標は、それぞれの権利者に帰属します。

## wireguard-lwip and ChaCha20-Poly1305 reference code

Source: MicroLink内の`components/microlink/components/wireguard_lwip`

License: BSD 3-Clause

Copyright (c) 2021 Daniel Hope (www.floorsense.nz)

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Floorsense Ltd, Agile Workspace Ltd nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## X25519

Source: code derived from STROBE

License: MIT

Copyright (c) 2015-2016 Cryptography Research, Inc.

## cJSON

Source: <https://components.espressif.com/components/espressif/cjson/versions/1.7.19~2>

License: MIT

Copyright (c) 2009-2017 Dave Gamble and cJSON contributors

## QR Code Generator for JavaScript

Source: <https://github.com/kazuhikoarase/qrcode-generator>

Version: 1.4.4

License: MIT

Copyright (c) 2009 Kazuhiko Arase

## Common MIT terms for the components above

Permission is hereby granted, free of charge, to any person obtaining a copy of the applicable software and associated documentation files, to deal in that software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies, and to permit persons to whom the software is furnished to do so, subject to the following conditions:

The applicable copyright notice and this permission notice shall be included in all copies or substantial portions of the software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Build-time platforms

- Moddable SDK runtime: LGPL-3.0-or-later, <https://github.com/Moddable-OpenSource/moddable>
- ESP-IDF: Apache-2.0 with component-specific exceptions and notices, <https://github.com/espressif/esp-idf>

Firmwareを再配布する場合は、使用したModdable SDKおよびESP-IDFリリースに同梱されたライセンスとnoticeも確認してください。
