# APLink 請求・入金管理 Web（seikyu-web）

AS400 請求・入金業務の Web 移行検証用システム。`seikyu-preview`（JSON 集約保存のデモ）を置き換える新規実装で、**すべての業務データを Railway MySQL の業務テーブル（44 表設計）に直接保存**する。表示データは架空。Java/Spring Boot 本開発の前に、業務フローと表設計を実画面で確認するためのもの。

- 配置: GitHub `gitHs-ops/newPrjt01` → Railway サービス `newPrjt01`（Root Directory `/seikyu-web`、Dockerfile）
- URL: https://newprjt01-production.up.railway.app/
- 構成: Node.js 22 標準 `http` + `mysql2`（依存 1 個）、画面はビルド不要の単一ページ（`public/`）

## 機能（16 メニュー）

| 区分 | 画面 | 主なテーブル |
|---|---|---|
| 販売・請求 | 出荷・売上 / 請求締め・発行 / 入金・消込 | shipment_slip, sales_trn, billing_head, billing_detail, billing_closing_inf, invoice_issue, receipt, receipt_component, receipt_allocation |
| 購買・支払 | 商品仕入 / 在庫計上 / 定時請求 / 小口現金 / 支払 | purchase, inventory_count, expense_document, expense_line, payment, payment_allocation |
| 会計・管理 | 仕訳・会計連携 / 帳票・データ出力 / 月次確定 / マスタ管理(8種) / 移行・確認事項 / 操作履歴 / 利用者管理 | journal_entry, journal_line, client_m, field_name_m, item_m, uriage_tanka_m, code_m, vendor, bank_account, account_subject, account_subsubject, opening_balance, users, roles, user_role_ts, menus, menu_role_ts, audit_event |

44 表のうち 34 表を使用（未使用: カード売上 2 表・納入先・原価・商品分類・担当者・出荷編集/予定・取込作業）。アプリ専用表は `app_session`（ログインセッション）と `app_period_close`（月次確定）の 2 つ。旧デモの `preview_*` 3 表は削除せず残している（参照しない）。

## 業務ルール（仮決定 — 画面「移行・確認事項」にも表示）

1. 出荷 1 件 = 1 商品 = 売上 1 行（`order_suffix=1`）。`billing_detail` は売上 No 単位、請求ヘッダとは得意先・請求年月・締日・現場で結合。**billing_detail と sales_trn 枝番の正式関係は確認待ち。**
2. 請求は得意先 × 現場 × 締日。掛売（決済方法 1）のみ。現金・カードは対象外（Q16/Q17）、値引マイナスは不可（Q18）。締日前の締め処理は不可。
3. 消費税は請求書単位・税率別に合計して切り捨て。支払期日は締日の翌月末（仮）。
4. 請求書は発行時の内容を `invoice_issue.snapshot_json` に保存（SHA-256 付き）。再発行は同じ形式で回数を記録。発行済み・消込済みの請求は取消不可。
5. 入金は振込・現金・手形・手数料・値引に分けて記録し、複数請求に消込。請求ヘッダを ID 順に行ロックして過剰消込を防止、`idempotency_key` で二重登録を防止。
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
MYSQLHOST / MYSQLPORT / MYSQLDATABASE / MYSQLUSER / MYSQLPASSWORD   … Railway の MySQL 参照変数
DEMO_USER / DEMO_PASSWORD                                          … 初期管理者
SEED_DEMO=0                                                        … 架空サンプルを作らない（既定は取引表が空のときだけ作成）
MYSQL_URL_OVERRIDE                                                 … ローカル検証用の接続 URL
SCHEMA_SQL_DIR                                                     … 空の検証 DB に 44 表 DDL を適用する場合のみ（DDL はリポジトリ外）
```

起動時に 44 表の存在を確認し、無ければ停止する（本番 DDL は適用済み）。採番・自動仕訳科目・自社情報・ロール・メニューは不足分だけ追加する。

## 検証

```
npm test                                   # 単体（金額・期間・CSV）
MYSQL_TEST_URL=<空の検証DB> SCHEMA_SQL_DIR=<DDLフォルダ> npm test   # 結合（本番 DB では実行しない）
BASE_URL=... LOGIN_ID=... LOGIN_PASSWORD=... PLAYWRIGHT_MODULE=<playwright-core> node scripts/browser-check.cjs
```

結合試験は マスタ楽観ロック・CSV 全件ロールバック・出荷→請求→発行→入金・同時消込（片方のみ成功）・冪等キー・逆仕訳・支払・ロール権限・無効化時のセッション失効・CSRF を確認する。
