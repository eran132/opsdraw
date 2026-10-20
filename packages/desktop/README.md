# OpsDraw desktop

The OpsDraw editor as a native app for Windows, macOS and Linux, built with
[Tauri 2](https://tauri.app). It is the same web app as `packages/app`, wrapped in the system
webview (WebView2 on Windows, WebKit on macOS and Linux), so installers are small.

The desktop shell adds native open/save dialogs and reads and writes only the files you pick in
them. It has no broader filesystem, shell or network permissions (see
`src-tauri/capabilities/default.json` and the content security policy in
`src-tauri/tauri.conf.json`). `.mmd` and `.mermaid` files are associated with the app.

## Download

Installers are attached to [GitHub Releases](https://github.com/eran132/opsdraw/releases). Builds
are not code-signed yet, so Windows SmartScreen and macOS Gatekeeper may warn on first launch.

## Build from source

Requirements:

- Node.js 20.19 or newer
- Rust (stable), via [rustup](https://rustup.rs)
- Windows: Microsoft C++ Build Tools ("Desktop development with C++") and WebView2 (built into
  Windows 11)
- macOS: Xcode Command Line Tools
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`

From the repository root:

```bash
npm install
```

```bash
npm run dev -w @opsdraw/desktop
```

```bash
npm run build -w @opsdraw/desktop
```

The installers end up in `packages/desktop/src-tauri/target/release/bundle/`.

To make a release, push a tag such as `v0.1.0`. The `Desktop release` workflow builds every
platform and creates a draft release with the installers attached.

## Icons

`icon-source.png` (1024×1024) is rendered from `packages/app/public/favicon.svg`. After changing
it, regenerate the platform icons:

```bash
npm run icons -w @opsdraw/desktop
```
