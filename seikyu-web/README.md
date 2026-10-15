# APLink 請求・入金管理 Web（seikyu-web）

AS400 請求・入金業務の Web 移行検証用システム。`seikyu-preview`（JSON 集約保存のデモ）を置き換える新規実装で、**すべての業務データを Railway PostgreSQL の業務テーブル（44 表設計）に直接保存**する（2026-10-16 MySQL から移行）。表示データは架空。Java/Spring Boot 本開発の前に、業務フローと表設計を実画面で確認するためのもの。

- 配置: GitHub `gitHs-ops/newPrjt01` → Railway サービス `seikyu-web`（Root Directory `/seikyu-web`、Dockerfile）
- URL: https://seikyu-web-production.up.railway.app/
- DB: Railway PostgreSQL（サービス `Postgres`）のデータベース `seikyu_web`。接続は変数 `DATABASE_URL`（内部ネットワーク）。`DEMO_USER`/`DEMO_PASSWORD` は `newPrjt01` サービスの変数を参照する
- 旧 MySQL（サービス `MySQL` の `seikyu_web`）は移行元として残す（書き込みはしない）。旧デモ `newPrjt01` は従来どおり MySQL の `railway` データベースを使う
- 旧デモ（seikyu-preview）は従来の URL https://newprjt01-production.up.railway.app/ に残す
- **禁止: サービス `newPrjt01` の Root Directory を `/seikyu-web` に戻さない（`/seikyu-preview` 固定、2026-10-15 ユーザー指示）。** seikyu-web の変更はサービス `seikyu-web` だけに配備・検証する
- 構成: Node.js 22 標準 `http` + `pg`、画面はビルド不要の単一ページ（`public/`）。`server/pg.mjs` が mysql2 と同じ呼び方（`query` → `[rows]`／`insertId`）を提供し、旧 MySQL 方言（`?`・INSERT IGNORE・ON DUPLICATE KEY UPDATE・UTC_TIMESTAMP・CAST AS CHAR・外部結合の行ロック）を読み替える
- 値の形は移行前と同じ：日付・日時は文字列、numeric/bigint は数値、boolean は 1/0。文字列列は `COLLATE "C"`（旧 utf8mb4_0900_bin と同じバイト順）

## 機能（16 メニュー）

| 区分 | 画面 | 主なテーブル |
|---|---|---|
| 販売・請求 | 出荷・売上 / 請求締め・発行 / 入金・消込 | shipment_slip, sales_trn, billing_head, billing_detail, billing_closing_inf, invoice_issue, receipt, receipt_component, receipt_allocation |
| 購買・支払 | 商品仕入 / 在庫計上 / 定時請求 / 小口現金 / 支払 | purchase, inventory_count, expense_document, expense_line, payment, payment_allocation |
| 会計・管理 | 仕訳・会計連携 / 帳票・データ出力 / 月次確定 / マスタ管理(8種) / 移行・確認事項 / 操作履歴 / 利用者管理 | journal_entry, journal_line, client_m, field_name_m, item_m, uriage_tanka_m, code_m, vendor, bank_account, account_subject, account_subsubject, opening_balance, users, roles, user_role_ts, menus, menu_role_ts, audit_event |

44 表のうち 34 表を使用（未使用: カード売上 2 表・納入先・原価・商品分類・担当者・出荷編集/予定・取込作業）。アプリ専用表は `app_session`（ログインセッション）と `app_period_close`（月次確定）の 2 つ。旧デモの `preview_*` 3 表は削除せず残している（参照しない）。

## 業務ルール（仮決定 — 画面「移行・確認事項」にも表示）

1. 出荷 1 件 = 1 商品 = 売上 1 行（`order_suffix=1`）。`billing_detail` は売上 No 単位、請求ヘッダとは得意先・請求年月・締日で結合。**billing_detail と sales_trn 枝番の正式関係は確認待ち。**
2. **請求は得意先 × 締日（NO6、2026-10-15 決定）**。`billing_head.field_cd/field_suffix` は空文字、現場は明細に保持し請求書で現場別小計。掛売（決済方法 1）のみ。現金・カードは対象外（Q16/Q17）、値引（伝票区分 9）は不可（Q18）。締日前の締め処理は不可。旧データの現場単位ヘッダは、同一得意先・締日に 1 件だけなら起動時に得意先単位へ変換。
2-1. **出荷伝票訂正（NO11）**: 元伝票は変更せず、訂正伝票（`ship_kb=2`、`sales_no`=元売上 No、`sales_suffix` 連番）を起票。マイナス数量可、訂正後合計がマイナスになる入力は不可。次回の請求締めに含める。
2-2. **請求一覧表（確認用, NO12）／請求書発行確認表（NO13）**: 同じ計算ロジック（前回請求額 = 開始残高＋前回締日までの請求−期間開始前の入金、差引繰越額＝前回請求額−期間内入金、今回請求額＝差引繰越額＋今回お買上額＋消費税）。画面表示・印刷・Excel(.xlsx) 出力。請求書の金額欄も同じ計算。
3. 消費税は請求書単位・税率別に合計して切り捨て。支払期日は締日の翌月末（仮）。
4. 請求書は発行時の内容を `invoice_issue.snapshot_json` に保存（SHA-256 付き）。再発行は同じ形式で回数を記録。発行済み・消込済みの請求は取消不可。
5. 入金（NO17）は振込・現金・手形・振込手数料（B-02, 8330-101）・協力会費等（B-03, 8330-107, 処税率 141 仮置き Q04）・預り金充当（B-06, 4170, 開始残高を上限）・値引（B-04, 8850）に分けて記録し、得意先×請求年月の請求に消込。請求ヘッダを ID 順に行ロックして過剰消込を防止、`idempotency_key` で二重登録を防止。
5-1. **自動仕訳リスト（②）**: 売掛金計上⑦・入金⑥・在庫計上⑨・定時請求ア・小口現金イ・支払内訳ウを現行帳票と同じ「借方・貸方を1行に併記＋伝票合計・日付合計」形式で、銀行別随時支払一覧表エを支払日別の業者一覧で、画面・印刷（A4横）・Excel 出力（「仕訳・会計連携」→「自動仕訳リスト（帳票）」）。伝票No は 仕訳ID＋現行接頭辞（R/B/S/K/U、在庫は6桁）。1伝票=1元伝票のため、現行の売掛金計上（締日一括・伝票分割）とは伝票の切り方が異なる（Q08）。
5-2. **支払帳票（③）**: 「支払」画面下部。NO37 支払データ作成＝全銀協フォーマット総合振込（固定長120バイト、Shift_JIS、ヘッダ1/データ2/トレーラ8/エンド9、振込指定区分7）。振込元（依頼人コード10桁・銀行4桁・支店3桁・種目・口座7桁・依頼人名カナ）はマスタ「銀行」で設定し `code_m`（code_key=`ZGN`）に保存、振込先は業者マスタの口座（受取人名は半角カナへ自動変換、全銀で使えない文字はエラー）。銀行名・支店名カナはマスタが無いため空白。NO45 業者別支払内訳表（期間）、NO46 振込依頼書（振込指定日・振込元口座別）、NO47 支払繰越一覧表（基準日時点の未払残高を計上月で当月/前月/2か月前/3か月以前に区分。相殺は未対応 Q03）、NO48 支払案内書（業者ごと1枚、対象伝票・支払後の繰越）。画面・印刷・Excel。
5-3. **在庫・出資金・出荷集計（④）**: NO41 商品・製品別出荷集計表／NO42 得意先別商品別出荷累計表／NO43 現金売上明細表（「出荷・売上」画面、期間指定）。NO26 材料受払表（「在庫計上」、暦月：期首・前月来・当月仕入・当月使用＝前月末＋仕入−当月末・当月末・単価、期首は自社情報の決算月の翌月）。NO25 配合計算（**暫定**：配合マスタ `code_m` key `MIX` の配合率×材料単価〔前月末在庫＋当月仕入の移動平均、無ければ当月末評価単価〕＋手入力の経費単価 → `genka_m` に保存）。NO35 出資金請求明細表（定時）・NO36 入金明細及び配分表（「帳票・データ出力」、JV構成員・出資比率マスタ `code_m` key `JV`、各社切捨て・端数は第1構成員）。商品マスタに製品・材料区分（`item_m.item_product_kb`）を追加。
5-4. **資料未着のため推定で完成させた項目（2026-10-15）**: NO3 得意先マスタ全19項目＋マスタ検索／NO9 得意先別残高照会タブ（請求残高照会を兼ねる）／NO10 発行済み請求書の一括ダウンロード（Excel・1請求書1シート）／NO20 会計連携データ（汎用借貸併記CSV・弥生会計インポート形式 Shift_JIS、税区分は推定変換、出力は監査ログ）／NO25 経費単価の自動配賦（当月経費÷製品出荷数量）と理論・実使用量の比較／NO30 定時請求データ入力明細表（組織別）／NO33 小口現金出納簿（定額資金前渡制）／NO40 商品売上登録リスト／NO44 入金予定チェックリスト（工事別按分・入金方法は実績から推定）。推定内容は画面「移行・確認事項」に一覧表示。
5-5. **再調査対応（2026-10-15）**: 一括ダウンロード・支払案内書印刷の不具合（$$→$ の置換事故）を修正。請求締めは締日までの未請求掛売上（前回締め後に入力された過去日付・訂正伝票を含む）を対象とし、未発行の同締日請求には追加、発行済みなら次回締めで請求、マイナスはクレジット請求。支払期日は得意先マスタの回収条件（未設定は翌月末）。帳票一覧①②③のOCRに合わせ、請求一覧表（確認用）・請求書発行確認表・請求書を現行の項目構成に変更（当月御買上額・消費税額・当月値引額・当月御請求額、適格請求書登録番号・振込先）。新マスタ: 自社情報・請求書設定、金融機関（銀行・支店名カナ）、部門。支払は先方負担手数料（F-02）・相殺（F-03・業者立替金）・安全協力費（4171、Q12推定）を差引可能。入金の過入金は預り金受入。小口現金は定額資金の保存と現金補充（G-03）。売掛金計上仕訳リストは締日ごとに最大45得意先で1伝票（Q08推定）。材料受払表・配合計算・定時請求入力明細表は20日締めが既定。
6. 取消は物理削除せず（出荷・未発行請求・仕入を除く）状態 REVERSED ＋逆仕訳。
7. 仕訳パターン A01 売掛金計上 / B01 入金 / C01 在庫 / D01 定時請求 / E01 小口 / F01 支払。銀行マスタ（code_m BANK）は当座預金 1112 の内訳科目に同期。
8. 月次確定した月の日付では登録・変更・取消不可。確定は前月から順に、管理者のみ。
9. ロール: 管理者（全機能・利用者管理・月次確定）/ 担当者（登録・変更）/ 参照者（閲覧のみ）。

## 認証・セキュリティ

- 初期管理者 = Railway 変数 `DEMO_USER` / `DEMO_PASSWORD`（起動時に同期。12 文字以上）。他の利用者は「利用者管理」で追加（scrypt ハッシュ）。
- セッションは DB 保存（8 時間、再起動後も有効）、HttpOnly・Secure・SameSite=Strict クッキー、更新系は CSRF トークン必須。
- ログイン失敗は IP・ID ごとに 10 回/分で制限。CSP・HSTS・X-Frame-Options を付与。監査ログに口座番号・パスワードは残さない。

## 起動・環境変数

```
DATABASE_URL                                                       … PostgreSQL 接続 URL（Railway は Postgres の参照変数で組み立て）
DEMO_USER / DEMO_PASSWORD                                          … 初期管理者
SEED_DEMO=0                                                        … 架空サンプルを作らない（既定は取引表が空のときだけ作成）
SCHEMA_SQL_DIR                                                     … 空の検証 DB に 44 表 DDL（schema.sql）を適用する場合のみ（DDL はリポジトリ外：seikyuPrjt02/database-design/postgres-draft）
```

起動時に 44 表の存在を確認し、無ければ停止する（本番 DDL は適用済み）。採番・自動仕訳科目・自社情報・ロール・メニューは不足分だけ追加する。

## MySQL → PostgreSQL 移行（2026-10-16）

- 移行ツール（リポジトリ外）：`seikyuPrjt02/.tooling/pg-migrate/migrate.mjs`。MySQL の information_schema から DDL を作り（型・既定値・主キー・一意・索引・CHECK・外部キー）、全行をコピーし、自動採番を最大値に合わせ、全表を主キー順に正規化して照合する。
- 型の対応：tinyint(1)→boolean、int unsigned→bigint、auto_increment→identity、decimal→numeric、char/varchar→varchar COLLATE "C"、datetime(6)→timestamp(6)、json→jsonb。

## 検証

```
npm test                                   # 単体（金額・期間・CSV）
PG_TEST_URL=<検証DB> SCHEMA_SQL_DIR=<DDLフォルダ> npm test        # 結合（本番 DB seikyu_web では実行しない）
BASE_URL=... LOGIN_ID=... LOGIN_PASSWORD=... PLAYWRIGHT_MODULE=<playwright-core> node scripts/browser-check.cjs
```

結合試験は マスタ楽観ロック・CSV 全件ロールバック・出荷→請求→発行→入金・同時消込（片方のみ成功）・冪等キー・逆仕訳・支払・ロール権限・無効化時のセッション失効・CSRF を確認する。
