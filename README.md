# DocFlow — Authentication API

NestJS + Prisma/PostgreSQL, đăng ký xác minh email, đăng nhập, refresh, đăng xuất và quên mật khẩu bằng OTP. Nhánh này kế thừa database; giao diện web nằm ở nhánh kế tiếp.

## Chạy local

```powershell
npm install
npm run setup
docker compose up -d --wait postgres mailpit
npm run db:generate
npm run db:migrate
npm run dev
```

API: http://127.0.0.1:3000/api/docs. Mailpit: http://127.0.0.1:8025. Email chỉ được nhận trong Mailpit local. WEB_ORIGIN mặc định http://127.0.0.1:5173 để nhánh giao diện có thể nối vào API.

POST /api/auth/register nhận email/password/displayName? và trả challengeId; POST /api/auth/verify-email nhận challengeId/code, tạo tài khoản và phiên. POST /api/auth/login nhận email/password; GET /api/auth/me cần Bearer token; POST /api/auth/refresh và /api/auth/logout quản lý phiên. POST /api/auth/forgot-password nhận email; POST /api/auth/reset-password nhận challengeId/code/password và thu hồi mọi phiên cũ. POST /api/auth/resend-code nhận challengeId.

OTP 6 số, hạn 10 phút, tối đa 5 lần thử và gửi lại sau 60 giây. Mật khẩu lưu Argon2id; OTP lưu HMAC; access token 15 phút, refresh cookie HttpOnly 30 ngày. Yêu cầu đăng ký chưa tạo user/phiên trước khi xác minh.

Reset mail được gửi nền trong tiến trình local; dùng gửi lại mã nếu API dừng khi đang gửi. Trước triển khai thật cần hàng đợi gửi mail bền vững.

## Kiểm tra

```powershell
npm run build
npm test
```

Bộ HTTP tích hợp cần Mailpit và database thử nghiệm riêng đã migrate. Đặt AUTH_TEST_DATABASE_URL rồi chạy npm run test:auth. Đổi cổng trong DATABASE_URL tương ứng POSTGRES_PORT nếu cổng 5432 đã được dùng.

Thư mục apps/api/test/ chỉ giữ ở local và được Git bỏ qua. Khi clone không có thư mục này, unit test API thông báo bỏ qua; các test database và HTTP tích hợp vẫn có trong Git.
