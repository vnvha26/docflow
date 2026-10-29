# DocFlow

Nền tảng quản lý tài liệu cá nhân. Hiện đã có đăng ký xác minh email, đăng nhập, quên mật khẩu bằng OTP, làm mới phiên và đăng xuất; giao diện tiếng Việt dùng React, API dùng NestJS và PostgreSQL/Prisma. Email local được nhận bằng Mailpit.

## Chạy trên máy

Yêu cầu Node.js **22.13+** (hoặc Node 24), npm và Docker Desktop đang chạy.

```powershell
npm install
node tools/setup.mjs
docker compose up -d --wait postgres mailpit
npm run db:generate
npm run db:migrate
npm run dev
```

Mở **http://127.0.0.1:5173**. API chạy ở cổng 3000; Swagger ở **http://127.0.0.1:3000/api/docs**. Dừng hai tiến trình bằng Ctrl+C. Dữ liệu PostgreSQL nằm trong Docker volume `pgdata` và được giữ lại sau khi dừng container.

Hộp thư thử nghiệm: **http://127.0.0.1:8025**. Mailpit giữ email trong máy local, không gửi ra Gmail hay nhà cung cấp bên ngoài. Dữ liệu thư thử được giữ trong volume `mailpitdata`.

`tools/setup.mjs` tạo `apps/api/.env` với khóa JWT ngẫu nhiên, không ghi đè cấu hình sẵn có. Không đưa file `.env` vào Git. Nếu thay đổi cổng hoặc địa chỉ web, sửa `WEB_ORIGIN` tương ứng. Web chuyển tiếp `/api` đến API qua Vite; có thể đổi đích bằng `API_PROXY_TARGET` khi chạy Vite.

Nếu cổng 5432 đã được ứng dụng khác dùng, sao chép `.env.example` ở thư mục gốc thành `.env`, đổi `POSTGRES_PORT` (ví dụ 15432) **trước** khi chạy setup. Nếu đã có `apps/api/.env`, sửa cổng trong `DATABASE_URL` tương ứng.

Prisma được giữ ở phiên bản 6.19 theo thiết kế hiện tại. Hai dependency của công cụ đọc cấu hình (`deepmerge-ts`, `effect`) được override sang bản đã sửa cảnh báo bảo mật; kiểm tra lại generate/validate/migration khi nâng Prisma.

## Chức năng tài khoản

- Đăng ký bằng email, tên hiển thị tùy chọn và mật khẩu 12–128 ký tự → nhận mã email → xác minh thành công mới tạo tài khoản và đăng nhập. Yêu cầu đang chờ chỉ giữ mật khẩu đã băm.
- OTP gồm 6 chữ số, hạn 10 phút, tối đa 5 lần nhập sai cho mỗi mã; gửi lại sau 60 giây. Gửi lại tạo mã/yêu cầu mới và vô hiệu mã/yêu cầu cũ. Có thể yêu cầu mã mới khi mã hết hạn hoặc đã đạt giới hạn nhập sai.
- Quên mật khẩu → nhận mã → nhập mã và mật khẩu mới. Đặt lại thành công thu hồi mọi phiên cũ; người dùng đăng nhập lại bằng mật khẩu mới. Thông báo yêu cầu không tiết lộ email có tài khoản hay không.
- OTP chỉ xuất hiện trong email; DB lưu HMAC-SHA256 có khóa và gắn với yêu cầu, email, mục đích. Mã không được trả trong API hoặc ghi vào log. Dữ liệu mật khẩu chờ đăng ký được xóa khỏi yêu cầu đã dùng/vô hiệu hóa.
- Email được chuẩn hóa về chữ thường; mật khẩu giữ nguyên và lưu dưới dạng Argon2id.
- Access JWT sống 15 phút, chỉ giữ trong bộ nhớ trình duyệt. Refresh token ngẫu nhiên nằm trong cookie HttpOnly, SameSite=Lax; DB chỉ lưu SHA-256, thời hạn phiên 30 ngày.
- Mỗi lần refresh thay token bằng thao tác có điều kiện; hai request dùng cùng token chỉ một request thành công.
- API kiểm tra phiên ở mỗi request được bảo vệ; đăng xuất thu hồi phiên ngay. Lỗi đăng nhập không tiết lộ email có tồn tại hay không.
- Có giới hạn tần suất và kiểm tra Origin cho các thao tác xác thực. Cookie có `Secure` khi `NODE_ENV=production`; triển khai thật cần HTTPS, khóa JWT riêng và cấu hình cùng origin cho web/API.

| Endpoint | Công dụng |
| --- | --- |
| `POST /api/auth/register` | `{email, password, displayName?}` → 202, yêu cầu xác minh; chưa tạo tài khoản/phiên |
| `POST /api/auth/verify-email` | `{challengeId, code}` → tạo tài khoản đã xác minh, access token và refresh cookie |
| `POST /api/auth/resend-code` | `{challengeId}` → mã/yêu cầu mới sau thời gian chờ |
| `POST /api/auth/forgot-password` | `{email}` → 202, thông báo chung và yêu cầu đặt lại mật khẩu |
| `POST /api/auth/reset-password` | `{challengeId, code, password}` → đổi mật khẩu, thu hồi mọi phiên; không tự đăng nhập |
| `POST /api/auth/login` | `{email, password}` → người dùng + access token, đặt refresh cookie |
| `POST /api/auth/refresh` | Dùng refresh cookie, xoay token và cấp access token mới |
| `GET /api/auth/me` | Thông tin tài khoản; yêu cầu `Authorization: Bearer <token>` |
| `POST /api/auth/logout` | Thu hồi phiên; xóa refresh cookie |
| `GET /api/health` | Kiểm tra API |

Trang sau đăng nhập hiển thị thông tin tài khoản thật. Upload, AI và quản lý tài liệu sẽ được triển khai ở các bước tiếp theo.

### Thử email trên máy

1. Chạy Docker và ứng dụng theo hướng dẫn trên.
2. Vào `/register`, nhập email thử (ví dụ `ban@example.test`) và mật khẩu. Trang web chuyển sang nhập mã.
3. Mở Mailpit tại `http://127.0.0.1:8025`, chọn thư gửi đến email vừa nhập, lấy mã 6 số.
4. Nhập mã trên DocFlow để hoàn tất đăng ký. Tải lại trang vẫn tiếp tục được bước xác minh; mã và mật khẩu không được lưu trong trình duyệt.
5. Đăng xuất → chọn **Quên mật khẩu?**, nhập email, lấy mã trong Mailpit, đặt mật khẩu mới và đăng nhập lại.

Tài khoản tạo trước luồng xác minh này có thể chưa được đánh dấu xác minh. Dùng **Quên mật khẩu** và mã nhận trong Mailpit để xác nhận email, đặt lại mật khẩu trước khi đăng nhập.

Cấu hình local mặc định trong `apps/api/.env.example`: `SMTP_HOST=127.0.0.1`, `SMTP_PORT=1025`, `SMTP_SECURE=false`, không cần user/password. Nếu đổi `MAILPIT_SMTP_PORT` trong `.env` gốc, đổi `SMTP_PORT` của API tương ứng; đổi `MAILPIT_UI_PORT` thì dùng cổng mới để mở hộp thư.

Ở bản local, email đặt lại mật khẩu được gửi nền trong tiến trình API để thời gian SMTP không tiết lộ email nào có tài khoản. Nếu API dừng đúng lúc đang gửi, dùng **Gửi lại mã** sau khi khởi động lại. Khi triển khai thật cần bổ sung hàng đợi gửi mail bền vững trước khi mở cho người dùng.

## Kiểm tra

```powershell
npm run build
npm test
```

`npm test` chạy unit test API, kiểm tra phiên phía web và kiểm tra migration bằng PGlite; không cần Docker. Kiểm tra HTTP tích hợp dùng **database thử nghiệm riêng** đã áp đủ migration và Mailpit đang chạy. Bộ kiểm tra gửi/đọc email SMTP thực qua Mailpit:

Thư mục `apps/api/test/` hiện chỉ giữ ở local và được Git bỏ qua. Khi clone không có thư mục này, bước unit test API sẽ thông báo bỏ qua; các test web, database và HTTP tích hợp vẫn được quản lý trong Git.

```powershell
docker compose exec -T postgres createdb -U docflow docflow_auth_test
$env:AUTH_TEST_DATABASE_URL = 'postgresql://docflow:docflow_local_only@127.0.0.1:5432/docflow_auth_test?schema=public'
$env:DATABASE_URL = $env:AUTH_TEST_DATABASE_URL
npm run db:migrate
Remove-Item Env:DATABASE_URL
npm run test:auth
```

Suite tích hợp tự chạy API ở cổng thử nghiệm và dọn các tài khoản do suite tạo. Không đặt `AUTH_TEST_DATABASE_URL` trỏ vào dữ liệu production. Thêm migration mới cho thay đổi dữ liệu; không chỉnh các migration đã được áp dụng.

Nếu đã đổi `POSTGRES_PORT`, dùng đúng cổng đó trong `AUTH_TEST_DATABASE_URL` (ví dụ `127.0.0.1:15432`). Audit dependency hiện không có cảnh báo ở phần chạy production; ba cảnh báo mức thấp còn lại thuộc công cụ Nest CLI dùng khi phát triển.

## Cấu trúc

- `apps/api`: API NestJS, Prisma và migration.
- `apps/web`: giao diện React + TypeScript + Vite.
- `tools`: kiểm tra dữ liệu, HTTP integration và lệnh phát triển.
- `docs`: tài liệu thiết kế/kế hoạch cục bộ (hiện bị `.gitignore` loại khỏi Git).

`docs/cp1-scope.md` là phạm vi CP1 hiện hành. `.cp1-backup` chỉ lưu tài liệu tham khảo; migration trong đó đã bị chỉnh dở, không dùng để khởi tạo DB.
