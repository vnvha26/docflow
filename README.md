# DocFlow — Database

PostgreSQL 17 + Prisma 6.19, 19 bảng và 4 migration, gồm ràng buộc auth và EmailChallenge cho OTP.

## Chạy local

Yêu cầu Node.js 22.13+ và Docker Desktop.

```powershell
npm install
# Nếu cổng 5432 đã được dùng, sao chép .env.example thành .env và đổi POSTGRES_PORT.
Copy-Item apps/api/.env.example apps/api/.env
# Sửa cổng DATABASE_URL tương ứng nếu đã đổi POSTGRES_PORT.
docker compose up -d --wait postgres
npm run db:generate
npm run db:migrate
npm run db:test
```

Không sửa migration đã áp dụng. .env, node_modules, file build và tài liệu cục bộ không nằm trong commit. Nhánh này chỉ chứa nền tảng dữ liệu; API và web nằm ở các nhánh kế tiếp.
