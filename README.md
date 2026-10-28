# Resonance

音に反応して空間が変化するブラウザ用 3D ビジュアライザーと、聴いた曲の記録から好みを分析し、まだ聴いたことのない曲を毎週提案する機能を組み合わせたアプリ。ビルド不要の静的サイトです。

## 画面

| タブ | 内容 |
| --- | --- |
| **Live** | マイク（またはローカル音源）の音に合わせて、変形する虹色のコア・湾曲したガラスパネルのリング・粒子のトンネル・流れるグラデーションの空が動きます。BPM / Energy / Brightness をリアルタイム表示。曲を認識して記録します。 |
| **Discover** | 今週の 12 曲を 3D の回転カルーセルで表示。スワイプで回転、タップで 30 秒試聴、♡ で好みに反映、Apple Music / Spotify / YouTube で開けます。毎週月曜 0:00 に新しい提案に切り替わります。 |
| **You** | 分析カード 9 枚（再生数・トップアーティスト・平均テンポ・音の明るさ・ジャンル・よく聴く時間・リスナータイプ・見つけた曲・履歴）が目盛り付きダイヤルの上に半円状に並びます。スワイプで回し、中央のカードをタップすると全画面に開いてグラフや一覧が見られます。履歴カードから曲の削除・手動追加もできます。 |

## 仕組み

1. **聴き取り**: `getUserMedia` でマイクから音を取り込み、Web Audio の `AnalyserNode` で帯域ごとのエネルギー、スペクトル重心（明るさ）、ビート、BPM を算出します（`js/audio.js`）。
2. **曲の特定**: 8 秒録音して [AudD](https://audd.io/) API に送り、曲名・アーティスト・ジャンル・Deezer ID を取得（`js/recognizer.js`）。自動記録をオンにすると一定間隔で繰り返し、同じ曲の重複は 6 分間無視します。
3. **分析**: 再生ごとに半減期 21 日で重みを付け、アーティスト・ジャンル・時間帯・音の特徴を集計（`js/recommend.js` の `buildProfile`）。
4. **提案**: 上位アーティストの「関連アーティスト」を Deezer API から取得。複数の好きなアーティストから共通して挙がる人ほど高スコア。すでに聴いた曲・過去に提案した曲は除外し、10 曲＋好きなアーティストの未聴曲 2 曲を選びます（`generateWeekly`）。

データはすべてブラウザの localStorage に保存され、サーバーはありません。設定から JSON で書き出し・読み込みができます。

## 動かし方

マイクは HTTPS（または localhost）でしか使えません。

```sh
# ローカル
python3 -m http.server 8080
# → http://localhost:8080
```

iPhone で使うには HTTPS で公開します。GitHub Pages なら、リポジトリの Settings → Pages でこのブランチのルートを選ぶだけです。Safari で開いて「ホーム画面に追加」するとアプリのように起動します。

### YouTube Music の高評価を取り込む

YouTube Music で 👍 した曲を YouTube Data API で読み込み、好みの分析とおすすめに使います（`js/youtube.js`）。高評価済みの曲はおすすめから外します。再生履歴は Google が API で提供していないため、取り込めるのは高評価だけです。

最初に一度だけ、Google Cloud で自分用のクライアント ID を作ります（無料）。

1. [Google Cloud Console](https://console.cloud.google.com/) を開き、新しいプロジェクトを作る（名前は何でもよい）
2. 「API とサービス」→「ライブラリ」で **YouTube Data API v3** を検索して「有効にする」
3. 「Google Auth Platform」（OAuth 同意画面）→「開始」で、アプリ名とメールアドレスを入れ、対象を **外部** にして作成する
4. 「対象」（Audience）→「テストユーザー」に、自分の Google アカウントのメールアドレスを追加する
5. 「クライアント」→「クライアントを作成」→ 種類は **ウェブ アプリケーション**、「承認済みの JavaScript 生成元」に `https://weakestandstrongest-sketch.github.io` を追加して作成する
6. 表示された **クライアント ID**（`….apps.googleusercontent.com`）をコピーし、アプリの ⚙ に貼って「Google でログインして同期」を押す

ログインすると「Google はこのアプリを確認していません」と出ます。自分で作った非公開のアプリなので、「続行」を押して YouTube の閲覧を許可してください。ログインは約 1 時間有効で、その間にアプリを開き直すと自動で同期します。それ以降は、⚙ か You の「高評価した曲」カードから同期ボタンを押します。ポップアップがブロックされた場合は、Brave なら Shields をこのサイトだけオフにしてください。

### イヤホンで聴く場合（Last.fm 連携）

マイクはイヤホンの音を拾えないので、再生履歴を [Last.fm](https://www.last.fm/) 経由で取り込みます。

1. Last.fm の無料アカウントを作る
2. 再生を Last.fm に送る設定をする。YouTube Music をブラウザで聴くなら、拡張機能 [Web Scrobbler](https://apps.apple.com/app/web-scrobbler/id6449224218)（iPhone の Safari 対応）を入れて Last.fm にログインし、Safari の設定で music.youtube.com での動作を許可する
3. [last.fm/api/account/create](https://www.last.fm/api/account/create) で API キーを無料で取得する
4. アプリの ⚙ で Last.fm のユーザー名と API キーを入力し、「今すぐ同期」を押す

初回は過去 30 日分を取り込みます。その後はアプリを開いたときと、開いている間は 5 分ごとに新しい再生を取り込みます（`js/lastfm.js`）。Last.fm の再生履歴は公開設定にしておく必要があります。

### 曲認識トークン

右上の ⚙ から AudD の API トークンを入力します（[dashboard.audd.io](https://dashboard.audd.io/) で取得）。トークンなしでも、ビジュアライザー・手動での曲追加・デモデータ・提案はすべて動きます。

## 注意点

- **他アプリの音声は直接取れません。** ブラウザが取得できるのはマイク入力だけなので、スピーカーから流れる音を拾います。イヤホン再生中の記録は Last.fm 連携を使ってください（ビジュアライザーはイヤホン再生には反応しません）。
- **iPhone の Safari でマイクを有効にすると、他アプリの再生が一時停止・音量低下する場合があります**（iOS のオーディオセッションの仕様）。その場合は、別の端末やスピーカーで流した音を拾う使い方になります。
- 「毎週」の提案は、その週に初めてアプリを開いたとき（または開いている間に週が変わったとき）に生成されます。サーバーがないため、プッシュ通知での配信はしていません。
- 試聴音源・関連アーティストは Deezer の公開 API（JSONP）を使っています。

## ファイル構成

```
index.html          画面構造
styles.css          デザイン（ガラス、グラデーション、3D カルーセル）
js/main.js          画面の制御
js/audio.js         マイク入力と音の特徴抽出
js/visualizer.js    Three.js の 3D 空間とシェーダー
js/recognizer.js    録音と AudD での曲認識
js/lastfm.js        Last.fm からの再生履歴の取り込み
js/youtube.js       YouTube Music の高評価の取り込み
js/recommend.js     好みの分析と毎週の提案
js/deezer.js        Deezer API
js/store.js         保存と週の計算
sw.js, manifest.webmanifest, icon.svg   ホーム画面追加用
```
