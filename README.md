# Q Bank API

Backend cho ứng dụng ngân hàng câu hỏi: HOST soạn câu hỏi và đề (ví dụ đề PMP), USER làm bài và xem kết quả. Đợt 1 hỗ trợ **câu hỏi single choice**. Các dạng multiple choice, point choice, drag & drop và tính toán sẽ được thêm sau mà không cần đổi database.

| Mảng | Công nghệ |
|---|---|
| Framework | NestJS 12 (ESM), TypeScript 6 |
| Database | PostgreSQL 18 (Docker), Prisma ORM 7 + `@prisma/adapter-pg` |
| Auth | JWT access token 15 phút + refresh token xoay vòng (opaque), argon2id |
| Validate | class-validator (request), zod (env, định nghĩa câu hỏi) |
| Docs | Swagger tại `/api/v1/docs` |
| Test | Vitest + Supertest (e2e chạy trên DB `qbank_test`) |

> ⚠️ **Đừng nâng lên Prisma 8 hoặc TypeScript 7.** `npm i prisma@latest` hiện kéo về Prisma 8 RC (bỏ `schema.prisma` và `migrate dev`). TypeScript 7 chưa tương thích với Nest CLI và Swagger plugin.

## Chạy local

Yêu cầu: Node ≥ 22, Docker.

```bash
npm install                 # tự chạy `prisma generate`
cp .env.example .env        # rồi đổi JWT_ACCESS_SECRET (≥ 32 ký tự)
npm run db:up               # Postgres ở localhost:5433 (tạo sẵn cả DB qbank_test)
npm run db:migrate          # áp dụng migration + generate client
npm run db:seed             # admin + tài khoản demo + bộ đề PMP mẫu
npm run start:dev           # http://localhost:3000/api/v1  ·  docs: /api/v1/docs
```

Tài khoản seed (chỉ tạo khi `NODE_ENV` khác `production`, trừ admin):

| Role | Email | Mật khẩu |
|---|---|---|
| ADMIN | `SEED_ADMIN_EMAIL` trong `.env` (mặc định `admin@qbank.local`) | `SEED_ADMIN_PASSWORD` (mặc định `Admin@123456`) |
| HOST | `host@qbank.local` | `Host@123456` |
| USER | `user@qbank.local` | `User@123456` |

Seed tạo topic **PMP** với 3 domain (People / Process / Business Environment), 9 câu hỏi và đề đã publish **PMP Mock Test 1** (3 section × 3 câu, 15 phút, đậu 70%). Chạy lại seed không tạo trùng dữ liệu.

## Khái niệm

| Khái niệm | Ý nghĩa | Ví dụ PMP |
|---|---|---|
| **Topic** (chủ đề) | Lĩnh vực hoặc chứng chỉ, dùng chung cho mọi host | PMP |
| **Domain** | Nhóm kiến thức trong topic, gắn lên **từng câu hỏi** để thống kê điểm mạnh/yếu | People / Process / Business Environment |
| **Difficulty** | `EASY` / `MEDIUM` / `HARD`, gắn lên từng câu hỏi | MEDIUM |
| **Question type** | Dạng câu hỏi. Hiện có `SINGLE_CHOICE` | SINGLE_CHOICE |
| **Exam** (đề) | Thuộc một topic, lấy câu hỏi từ ngân hàng của chính host | PMP Mock Test 1 |
| **Section** | Phần của đề. Đề nào cũng có ≥ 1 section; đề "không chia phần" dùng 1 section mặc định | 3 section × 60 câu |
| **Attempt** | Một lượt làm bài. Câu hỏi được chụp lại (snapshot) lúc bắt đầu, nên host sửa câu hỏi sau đó không ảnh hưởng bài đang làm | — |

Role:
- **USER**: làm bài.
- **HOST**: soạn câu hỏi và đề của mình.
- **ADMIN**: thấy mọi thứ và nâng USER lên HOST.

Đăng ký luôn tạo tài khoản USER.

## Auth cho app mobile

Token trả trong JSON body (không dùng cookie):

```jsonc
// POST /auth/login  { email, password, deviceId?, deviceName?, platform?: "IOS" | "ANDROID" | "WEB" }
{
  "user": { "id": "…", "email": "…", "fullName": "…", "role": "USER", "isActive": true, "createdAt": "…" },
  "accessToken": "…",            // gửi kèm header Authorization: Bearer <accessToken>
  "accessTokenExpiresIn": 900,   // giây
  "refreshToken": "…",           // lưu vào SecureStore
  "refreshTokenExpiresAt": "…"   // gia hạn mỗi lần refresh (mặc định 30 ngày)
}
```

Cách app nên xử lý:
1. Khi API trả 401, gọi `POST /auth/refresh` với `{ refreshToken }` **đúng một lần**. Nếu nhiều request cùng bị 401, tất cả chờ chung lần refresh đó. Sau đó lưu cặp token mới và gửi lại request.
2. Nếu chính `/auth/refresh` trả 401 (`REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`) thì đăng xuất.
3. Refresh token cũ vẫn dùng được thêm 60 giây sau khi xoay vòng, để chịu được việc mất response hoặc retry. Gửi lại token cũ sau 60 giây bị coi là token bị đánh cắp, và cả phiên sẽ bị thu hồi.
4. Mỗi `deviceId` chỉ giữ một phiên. Logout, khóa tài khoản và đổi role có hiệu lực **ngay lập tức**, vì mỗi request đều kiểm tra phiên trong DB.

Kết nối từ app khi phát triển:
- **Android emulator**: dùng `http://10.0.2.2:3000/api/v1`.
- **Máy thật cắm USB**: chạy `adb reverse tcp:3000 tcp:3000`, rồi dùng `http://localhost:3000/api/v1`.
- **Máy thật qua Wi-Fi**: dùng `http://<IP-LAN>:3000/api/v1`. Server đã listen `0.0.0.0`; nhớ cho phép node qua firewall của macOS.
- **Bản release APK**: chặn HTTP thường, nên cần HTTPS hoặc bật `usesCleartextTraffic` khi test.

## API (`/api/v1`)

Chi tiết từng field xem trên Swagger `/api/v1/docs`.

| Nhóm | Endpoint | Quyền |
|---|---|---|
| Health | `GET /health` | public |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` | public (có rate limit) |
| | `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/password` | đã đăng nhập |
| Admin | `GET /admin/users`, `PATCH /admin/users/:id/role` (`USER` ↔ `HOST`), `PATCH /admin/users/:id/status` | ADMIN |
| Topic | `GET /topics`, `GET /topics/:id` | đã đăng nhập |
| | `POST /topics`, `PATCH`/`DELETE /topics/:id`, `POST /topics/:topicId/domains`, `PATCH`/`DELETE /domains/:id` | HOST, ADMIN (chỉ người tạo được sửa/xóa) |
| Question | `GET /questions?topicId&domainId&difficulty&type&q`, `POST /questions`, `GET`/`PATCH`/`DELETE /questions/:id` | HOST (của mình), ADMIN |
| Exam | `GET`/`POST /exams`, `GET`/`PATCH`/`DELETE /exams/:id`, `POST /exams/:id/publish \| unpublish \| archive` | HOST (của mình), ADMIN |
| Section | `POST /exams/:id/sections`, `PATCH`/`DELETE /exams/:id/sections/:sectionId`, `PUT /exams/:id/sections/order` | như Exam |
| Câu hỏi trong đề | `POST /exams/:id/sections/:sectionId/questions`, `PUT /exams/:id/sections/:sectionId/questions/order`, `PATCH`/`DELETE /exams/:id/questions/:questionId` | như Exam |
| Catalog | `GET /catalog/exams?topicId&q`, `GET /catalog/exams/:id`, `POST /catalog/exams/:id/attempts` (bắt đầu hoặc tiếp tục bài dở) | đã đăng nhập |
| Làm bài | `GET /attempts`, `GET /attempts/:id`, `PATCH /attempts/:id/answers` (lưu nhiều câu một lần), `POST /attempts/:id/submit`, `GET /attempts/:id/result`, `GET /attempts/:id/review` | chủ bài làm |

**Câu hỏi single choice** gồm 2–10 option và đúng 1 option có `isCorrect: true`. Option mới không cần `id`; khi sửa câu hỏi thì giữ nguyên `id` của option cũ.

```json
{
  "topicId": "…", "domainId": "…", "difficulty": "MEDIUM",
  "content": "A key stakeholder asks for a new feature after the scope baseline is approved. What should you do?",
  "explanation": "Changes go through integrated change control.",
  "definition": { "options": [
    { "content": "Add it immediately", "isCorrect": false },
    { "content": "Assess impact and submit a change request", "isCorrect": true }
  ] }
}
```

**Trả lời** (`PATCH /attempts/:id/answers`):
- Body: `{ "answers": [{ "attemptQuestionId": "…", "response": { "optionId": "…" }, "flagged": false }] }`.
- `response: null` để xóa câu trả lời; bỏ trống field nào thì giữ nguyên giá trị cũ.
- Bài có giới hạn thời gian: server vẫn nhận câu trả lời thêm 30 giây sau `expiresAt`. Quá thời gian đó, bài tự chấm với các câu đã lưu và chuyển `EXPIRED`.
- Dùng `serverTime` trong response để đồng bộ đồng hồ đếm ngược.

**Luật soạn đề**:
- Chỉ đề `DRAFT` mới sửa được. Muốn sửa đề đã publish thì unpublish trước.
- Publish yêu cầu mọi section đều có câu hỏi.
- Câu hỏi thêm vào đề phải cùng owner và cùng topic với đề.
- Đề đã có người làm thì không xóa được, chỉ archive được.

## Định dạng lỗi

Mọi lỗi đều có dạng:

```json
{ "statusCode": 409, "code": "EXAM_NOT_EDITABLE", "message": "Only draft exams can be edited; unpublish it first", "details": null }
```

`message` **luôn là một chuỗi**, có thể hiển thị thẳng cho người dùng. Lỗi validate có thêm `details: [{ field, messages[] }]`.

Các `code` thường gặp:
- **Validate và auth**: `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `TOKEN_INVALID`, `SESSION_ENDED`, `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_DISABLED`, `WRONG_PASSWORD`.
- **Tài nguyên**: `FORBIDDEN`, `NOT_FOUND`, `TOPIC_EXISTS`, `TOPIC_IN_USE`, `DOMAIN_IN_USE`, `QUESTION_IN_USE`.
- **Câu hỏi**: `INVALID_QUESTION_DEFINITION`, `QUESTION_TYPE_NOT_SUPPORTED`.
- **Soạn đề**: `EXAM_NOT_EDITABLE`, `EXAM_NOT_PUBLISHABLE`, `EXAM_HAS_ATTEMPTS`, `LAST_SECTION`, `QUESTIONS_NOT_FOUND`, `QUESTION_TOPIC_MISMATCH`, `QUESTION_ALREADY_IN_EXAM`.
- **Làm bài**: `INVALID_RESPONSE`, `ATTEMPT_CLOSED`, `ATTEMPT_EXPIRED`, `ATTEMPT_NOT_SUBMITTED`.
- **Khác**: `TOO_MANY_REQUESTS`.

## Thêm dạng câu hỏi mới

1. Viết handler trong `src/modules/questions/question-types/`, implement `QuestionTypeHandler`:
   - `parseDefinition`: validate `definition` mà host gửi lên.
   - `buildSnapshot`: tách phần người làm bài được thấy và phần đáp án ẩn.
   - `parseResponse`: validate câu trả lời.
   - `grade`: chấm điểm.
2. Đăng ký handler trong `question-types/index.ts`.
3. Không cần migration, vì enum `QuestionType` đã có sẵn các dạng.

## Scripts

| Lệnh | Việc |
|---|---|
| `npm run start:dev` | chạy dev, tự reload |
| `npm run check` | typecheck + lint + unit test |
| `npm run test:e2e` | e2e trên DB `qbank_test`: tự áp dụng migration, mỗi file test tự xóa dữ liệu trong DB test |
| `npm run db:migrate` | tạo/áp dụng migration khi đổi `prisma/schema.prisma` |
| `npm run db:seed` / `db:studio` | seed dữ liệu / mở Prisma Studio |
| `npm run build && npm run start:prod` | build và chạy bản production |
