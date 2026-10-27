# U-Chan Secrets — Design

Ngày: 2026-10-27 · Trạng thái: draft · Dùng cá nhân, không thương mại

Tên sản phẩm: **U-Chan Secrets** (slug thư mục/package: `u-chan-secrets`).

## 1. Mục đích và lý do

Người dùng làm việc với Claude Code trên máy Windows cá nhân. Thường xuyên nhờ AI mở trình duyệt (Playwright MCP) để kiểm tra giao diện trên live site, ví dụ `admin.example.com`, nhưng AI kẹt ở màn hình đăng nhập. Hiện phải tự gõ hoặc dán mật khẩu vào chat — làm lộ mật khẩu vào context của model.

Các giải pháp thị trường chưa phù hợp:
- Bitwarden MCP trả plaintext mật khẩu về model.
- 1Password for Claude giữ được secret khỏi model nhưng trả phí, ban đầu chỉ có trên Mac, buộc duyệt tay mỗi lần.

**Nguyên tắc cốt lõi:** AI chỉ ra lệnh "đăng nhập vào site X"; một công cụ local lấy credential từ Bitwarden và điền thẳng vào trình duyệt. Mật khẩu không bao giờ xuất hiện trong chat, tool result, log hay context của model.

**Thành công nghĩa là:** người dùng nói "check giao diện admin.example.com trên live" → AI tự mở, tự đăng nhập, chụp màn hình, báo lại — người dùng không động tay (ngoài việc mở khoá Bitwarden đầu ngày).

## 2. Goals

- MCP server local (stdio) cắm vào Claude Code, cung cấp tool đăng nhập theo domain.
- Credential lấy từ Bitwarden (vault cá nhân hiện có) qua Bitwarden CLI (`bw`).
- Chỉ đăng nhập vào site nằm trong allowlist; với site đã allow, AI tự làm, không hỏi lại.
- Dùng chung trình duyệt với Playwright MCP sẵn có, để sau khi đăng nhập AI tiếp tục duyệt/chụp bằng Playwright MCP như bình thường.
- AI có thể đề nghị thêm site vào allowlist, nhưng chỉ có hiệu lực khi người dùng bấm duyệt trên hộp thoại Windows native do công cụ hiển thị.
- Audit log mỗi lần đăng nhập và mỗi thay đổi allowlist.

## 3. Non-goals (bản đầu)

- Đăng nhập Google / SSO / OAuth.
- 2FA, OTP, TOTP, passkey.
- Tự viết vault hay crypto riêng.
- Đa người dùng, chia sẻ, thương mại.
- Hỗ trợ macOS/Linux (không chủ động phá, nhưng không test).
- Agent khác ngoài Claude Code.

## 4. Anti-goals (coi là thất bại dù vẫn "chạy được")

- Mật khẩu xuất hiện ở bất kỳ đâu AI đọc được: tool result, error message, log, stdout/stderr của MCP server, snapshot trình duyệt.
- AI tự thêm site vào allowlist mà không có cú bấm thật của người dùng (kể cả khi nội dung web lừa AI — prompt injection).
- Điền credential vào domain không khớp allowlist (ví dụ trang phishing, redirect sang domain khác).

## 5. Ràng buộc

- Windows 11, Claude Code chạy ở **bypass permissions mode** → không thể dựa vào permission prompt của Claude Code để làm khâu duyệt.
- Playwright MCP (`mcp__playwright__*`) đã cài và người dùng muốn tiếp tục dùng.
- Người dùng mở khoá Bitwarden một lần mỗi ngày (`bw unlock`); sau đó công cụ dùng được đến khi khoá lại / tắt máy.
- Chỉ email/mật khẩu (form login thông thường).

## 5b. Threat model (người dùng chọn)

**v1 — chống lộ vô tình.** Trong luồng bình thường mật khẩu không bao giờ vào chat/context. Tin rằng Claude không cố ý moi mật khẩu bằng shell hay Playwright (`browser_evaluate`, network requests). Không cố chống: Claude tự chạy `bw`, sửa file allowlist/log, giả lập click hộp thoại.

**Phải nâng cấp được lên mức "chống AI bị lừa" sau này** mà không viết lại. Hệ quả cho v1:
- Tách rõ hai lớp: (1) **core** — vault access, allowlist, approval, audit, điền form; (2) **MCP adapter** mỏng chỉ chuyển tool call sang core. Giao tiếp giữa hai lớp qua một interface để sau này core có thể chạy như process/service riêng dưới tài khoản Windows khác (IPC, ví dụ named pipe) mà adapter không đổi.
- Không để Bitwarden session, allowlist, audit log bị phụ thuộc vào vị trí cố định trong thư mục user của AI — đường dẫn cấu hình được.
- Logic điền form nhận một browser/context làm tham số, để sau này có thể đăng nhập trong context riêng rồi chỉ chuyển phiên sang Chrome dùng chung.
- Approval dialog sau một interface, để sau này thay bằng cơ chế mạnh hơn (secure desktop, xác nhận trên điện thoại).

## 6. Thiết kế (phần đã quyết)

### 6.1 Thành phần

```
Claude Code
  ├─ Playwright MCP  ──(--cdp-endpoint)──┐
  └─ u-chan-secrets MCP ──(CDP)─────────┤
                                         ▼
                              Chrome (remote debugging port)
u-chan-secrets ── bw CLI ── Bitwarden vault (đã unlock)
u-chan-secrets ── hộp thoại Windows native (duyệt allowlist)
```

- **Trình duyệt dùng chung:** một Chrome chạy với remote debugging port; Playwright MCP được cấu hình `--cdp-endpoint` trỏ vào đó; broker cũng kết nối qua CDP (Playwright `connectOverCDP`). Phiên đăng nhập do đó dùng chung, không phải chép cookie.
- **Stack (quyết định của Claude):** TypeScript/Node, `@modelcontextprotocol/sdk`, `playwright`.

### 6.2 Tool MCP

| Tool | Hành vi | Trả về cho AI |
|---|---|---|
| `login(domain)` | Kiểm tra allowlist → lấy credential từ Bitwarden → mở/điều hướng tới login URL trong Chrome dùng chung → điền email + mật khẩu và submit trong cùng một bước → xác nhận đăng nhập thành công | `ok` hoặc `failed: <lý do không chứa secret>` |
| `request_allow(domain, item)` | Hiện hộp thoại Windows native: "Cho phép AI đăng nhập <domain> bằng item <item>?" [Đồng ý] [Từ chối]. Chỉ ghi vào allowlist khi người dùng bấm Đồng ý | `approved` / `denied` |
| `revoke(domain)` | Gỡ site khỏi allowlist, không cần duyệt (chỉ giảm quyền) | `ok` |
| `list_allowed()` | Liệt kê domain + tên item (không có secret) | danh sách |
| `status()` | Bitwarden đã unlock chưa, Chrome đã kết nối chưa | trạng thái |

### 6.3 Allowlist

- File config local (JSON), mỗi entry: domain, tên/ID item Bitwarden, login URL.
- Người dùng có thể sửa tay; AI chỉ thay đổi được qua `request_allow` (có duyệt) và `revoke`.

### 6.4 Bảo vệ

- Kiểm tra domain thực của trang ngay trước khi điền (sau mọi redirect) phải khớp allowlist.
- Điền + submit trong một thao tác để không có khoảng thời gian ô mật khẩu chứa giá trị mà AI có thể snapshot.
- Mọi error/exception được lọc, không bao giờ kèm credential.
- Audit log: thời gian, domain, kết quả; thay đổi allowlist (approved/denied/revoked).

### 6.5 Quyết định bổ sung (Claude chọn, sau builder check)

- **Login nhiều bước:** hỗ trợ cả form một trang lẫn form tách bước (email trước, mật khẩu ở màn hình sau). Kiểm tra domain lặp lại trước mỗi lần điền.
- **Chrome profile riêng:** Chrome dùng chung chạy với user-data-dir riêng cho U-Chan Secrets, không phải profile hằng ngày của người dùng (Chrome mới cũng chặn remote debugging trên profile mặc định).
- **`request_allow(domain, login_url, item)`:** AI truyền cả login URL và tên item; hộp thoại hiển thị đủ cả ba để người dùng kiểm tra. AI không có tool liệt kê item trong vault — tên item lấy từ người dùng nói trong chat.
- **So khớp domain:** mỗi entry có danh sách host được phép (mặc định chỉ đúng host đã duyệt, không wildcard subdomain). Thêm host (ví dụ `auth.` riêng) đi qua cùng luồng duyệt.

### 6.6 Rủi ro chấp nhận

Sau khi đăng nhập, AI dùng được phiên (cookie) qua Playwright — đó chính là mục đích. Thứ được bảo vệ là mật khẩu, không phải phiên.

## 7. Để lại cho builder

- Cách định vị ô email/mật khẩu/nút submit (heuristic chung, có thể cho phép override selector theo từng site trong allowlist).
- Cách phát hiện "đăng nhập thành công".
- Cách broker nhận Bitwarden session sau `bw unlock` (biến môi trường `BW_SESSION`, file, hay lệnh helper).
- Cách khởi chạy Chrome có remote debugging và cấu hình Playwright MCP (script khởi động).
- Công nghệ hộp thoại Windows native.
- Vị trí file allowlist và audit log.
- Chiến lược test.
