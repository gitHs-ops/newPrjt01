# sdgen：画面設計書（seikyu-web_画面設計）の再生成ツール

画面設計書を、**画面そのもの（ローカル検証サーバ）＋補足入力＋規則** から作り直す。規則や画面が変わったら、`sdgen\rules.py`・`sdgen\style.py` か `補足入力.xlsx` を直して `run_all.bat` を実行する。

> 現在は P1（SC-PUR-01 商品仕入の1画面）。生成した SC-PUR-01 は V15 と文字の並びで 100% 一致（`work\build\compare_SC-PUR-01.txt`）。

## 1. 構成

| ファイル | 役割 |
|---|---|
| `run_all.bat`・`setup.bat` | 一括実行・準備（ASCII のみ） |
| `screens.json` | 画面の開き方（メニュー・ボタン）と、項目を取り出す区画（エリア名・範囲・取り出し方） |
| `補足入力.xlsx` | 画面から取れない内容（目的・権限・画面の構成・参照元・備考・操作手順・業務ルール・図の指定）。シート「説明」に書き方 |
| `sdgen\rules.py` | 画面の項目 → 設計書の列の規則（表示区分・必須・形式・桁数・初期値。桁数は DB 定義 `test\schema\schema.sql` も見る） |
| `sdgen\style.py` | 見た目の規則（文字・色・罫線・列幅・行の高さ） |
| `capture.py` | 1 画面を開いて項目（DOM）と画面図（PNG）・帳票（Excel）を取り出す → `work\capture\` |
| `report_img.py` | 帳票 Excel の1ページ目を PNG にする（Excel を使う） |
| `build.py` | 取り出した項目＋補足入力＋規則から設計書を作る → `work\build\画面設計_生成_YYYYMMDD.xlsx` |
| `finish.py` | 矢印を描く（Excel を使う） |
| `compare.py` | 既存の最新版（`SDGEN_DOC_DIR` の V 番号最大）と文字の並びで比べる → `work\build\compare_<画面ID>.txt` |
| `migrate.py` | 既存の設計書のシートを補足入力に移す（画面を追加するときに1回）。図は `fixed\` に取り出す |
| `fixed\` | 固定画像（補足入力の 図 で `fixed:ファイル名`） |

## 2. 使い方

1. 準備（最初に1回）：`setup.bat`
2. ローカル検証サーバを起動しておく（既定 `http://127.0.0.1:8098`。本番には接続しない）
3. パスワードを環境変数で渡す（リポジトリには置かない）
   ```
   set SDGEN_PASSWORD_FILE=C:\...\pw.txt
   ```
4. 実行：`run_all.bat`（全画面）／`run_all.bat SC-PUR-01`（1画面）
5. 結果：`work\build\画面設計_生成_YYYYMMDD.xlsx`、指摘 `build_report.txt`、照合 `compare_*.txt`

| 環境変数 | 意味 | 既定 |
|---|---|---|
| `SDGEN_BASE` | ローカル検証サーバ | `http://127.0.0.1:8098` |
| `SDGEN_USER` | ログインID | `doc-admin` |
| `SDGEN_PASSWORD`／`SDGEN_PASSWORD_FILE` | パスワード／それを書いたファイル | （必須） |
| `SDGEN_DOC_DIR` | 設計書の置き場所（照合・migrate の元） | `C:\myPrjt01\seikyuPrjt01` |
| `SDGEN_WORK` | 作業フォルダ | `tools\sdgen\work` |

## 3. 項目の決まり方

- 並び：補足入力の「項目」シートの順。
- 区分・必須・初期値・桁数・形式：補足入力が**空欄なら画面から自動**（`rules.py`）、値があればその値。
- 画面にあって補足入力に無い項目は「（補足入力なし）」で末尾に載せ、`build_report.txt` に出す。補足入力にあって画面に無い項目も `build_report.txt` に出す。

## 4. 手で直した図・文の扱い

- 図を差し替えたいとき：補足入力の 図 の「画像」を `fixed:ファイル名`（`fixed\` に置く）。画面から撮り直すなら `capture:撮影名`（`screens.json` の shot の name。`＋` でつなぐと縦に並べる）。
- 矢印：図 の「矢印の終点」に矢印を引く先の図の「順」、起点x・y／終点x・y に図の中の位置（0〜1）。
- 設計書を Excel で直接直した文は、次の再生成で消える。文は補足入力で直す。

## 5. 今後（P2〜P4）

- P2：全41画面を migrate・screens.json に追加
- P3：目次・業務フロー・変更点の自動作成、メニューと設計書シートの対応の検査
- P4：次の V 番号での保存（publish）、別 PC での実行手順
