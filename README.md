# U-Chan Secrets

MCP server chạy local: cho Claude Code đăng nhập vào các website đã allowlist bằng credential Bitwarden, mà mật khẩu không đi qua model.

## Cài đặt

1. Cài Bitwarden CLI bản native (không dùng shim `.cmd` của npm): `winget install Bitwarden.CLI`. Nếu `bw.exe` không nằm trong PATH, đặt `U_CHAN_BW` trỏ tới file đó.
2. `bw login` (một lần).
3. Build:
   ```
   npm install
   npm run build
   ```
   Kết quả: `dist/index.js`.

## Đăng ký MCP

```
claude mcp add u-chan-secrets -- node <path-to>\u-chan-secrets\dist\index.js
```

Playwright MCP phải dùng chung Chrome này. Nếu đã có Playwright MCP, hãy cấu hình lại nó thay vì thêm bản thứ hai:

```
claude mcp remove playwright   # gỡ bản cũ trước khi thêm lại với --cdp-endpoint
claude mcp add playwright -- npx @playwright/mcp@latest --cdp-endpoint http://127.0.0.1:9222
```

## Quy trình hằng ngày

```
powershell -File scripts\start-chrome.ps1   # Chrome riêng, CDP theo U_CHAN_CDP, mặc định 127.0.0.1:9222 (bỏ qua nếu cổng đã mở)
powershell -File scripts\unlock.ps1         # nhập master password; lưu session vào bw-session
powershell -File scripts\unlock.ps1 -Lock   # khóa vault, xóa session
```

Chrome dùng profile riêng `<data dir>\chrome-profile`, không đụng profile Chrome mặc định của bạn.

## Công cụ MCP

- `status`: trạng thái vault (unlocked/locked/...) và kết nối Chrome. Chỉ báo lỗi khi cần người dùng xử lý (vault khoá, Playwright thiếu `--cdp-endpoint`); Chrome tắt không phải lỗi vì `login` tự mở.
- `request_allow(domain, login_url, item)`: xin allowlist một site; hiện hộp thoại Windows, bạn phải bấm Đồng ý. `item` là tên/id item Bitwarden; nên dùng id item vì tên chỉ là tìm kiếm và có thể khớp nhầm item khác.
- `login(domain)`: đăng nhập site đã allowlist trong Chrome dùng chung. Sau đó dùng Playwright MCP để duyệt tiếp.
- `list_allowed`: liệt kê domain đã allowlist.
- `revoke(domain)`: gỡ quyền.

## Dữ liệu và cấu hình

Thư mục dữ liệu: `U_CHAN_HOME`, mặc định `%APPDATA%\u-chan-secrets`. Gồm `allowlist.json`, `audit.log`, `bw-session`, `chrome-profile\`.

| Biến môi trường | Mặc định | Ý nghĩa |
|---|---|---|
| `U_CHAN_HOME` | `%APPDATA%\u-chan-secrets` | Thư mục dữ liệu |
| `U_CHAN_CDP` | `http://127.0.0.1:9222` | CDP endpoint của Chrome (`start-chrome.ps1` lấy host/port từ đây) |
| `U_CHAN_BW` | `bw` | Đường dẫn `bw.exe` |

`allowlist.json` gồm các entry:

```json
{
  "domain": "admin.example.com",
  "hosts": ["admin.example.com"],
  "loginUrl": "https://admin.example.com/login",
  "item": "Tên item Bitwarden",
  "selectors": { "username": "#email", "password": "#password", "submit": "button[type=submit]" }
}
```

`selectors` là tùy chọn (chỉ cần khi tự dò form không đúng). `audit.log` ghi lại mọi lần login / request_allow / revoke (không chứa mật khẩu).

## Gỡ quyền

Gọi `revoke(domain)`, hoặc xóa entry tương ứng trong `allowlist.json`.

## Threat model v1

Chống lộ vô tình (mật khẩu không vào chat/context trong luồng bình thường); không chống AI bị lừa hay cố ý moi mật khẩu (tự chạy `bw`, sửa allowlist/log, giả click hộp thoại). Chi tiết: `docs/specs/2026-10-27-u-chan-secrets-design.md` mục 5b.

## Kiểm tra end-to-end

Chạy thủ công sau khi cài (cần Bitwarden thật):

- [ ] Chạy `start-chrome.ps1` và `unlock.ps1`.
- [ ] Trong Claude Code: `status` trả về unlocked + connected.
- [ ] `request_allow("admin.example.com", "<login url>", "<tên item>")`: hộp thoại hiện, bấm Đồng ý.
- [ ] `login("admin.example.com")` trả về `logged in`.
- [ ] Playwright MCP `browser_navigate` tới trang admin: thấy giao diện đã đăng nhập; chụp màn hình.
- [ ] Kiểm tra rò rỉ: grep mật khẩu thật trong `audit.log`, transcript Claude Code của phiên test (`~/.claude/projects/...`) và stderr log: không có kết quả.
