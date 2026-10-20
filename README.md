# Q Bank API

Backend cho ứng dụng ngân hàng câu hỏi: HOST soạn câu hỏi và đề (ví dụ đề PMP), USER làm bài và xem kết quả. Đợt 1 hỗ trợ **câu hỏi single choice**. Các dạng multiple choice, point choice, drag & drop và tính toán sẽ được thêm sau mà không cần đổi database.

Chạy trên **Cloudflare Workers gói Free ($0/tháng)**.

| Mảng | Công nghệ |
|---|---|
| Runtime | Cloudflare Workers (`nodejs_compat`), framework Hono 4 |
| Database | Cloudflare D1 (SQLite), Drizzle ORM 0.45, migration bằng drizzle-kit |
| Auth | Tài khoản email/mật khẩu trong bảng `User` (băm PBKDF2), khách tự đăng ký. JWT access token 15 phút + refresh token xoay vòng |
| Validate | zod |
| Test | Vitest. E2E chạy app thật trên D1 local, mỗi file test có DB riêng trong bộ nhớ |

> ⚠️ **Mỗi request chỉ có 10 ms CPU** (gói Free). Khi viết code mới, xem mục [Giới hạn gói Free](#giới-hạn-gói-free).

## Chạy local

Yêu cầu: Node ≥ 22. Không cần Docker: `wrangler dev` tự tạo D1 local trong `.wrangler/`.

```bash
npm install
cp .env.example .env     # đặt JWT_ACCESS_SECRET (≥ 32 ký tự) và tài khoản admin cho seed: ADMIN_EMAIL, ADMIN_PASSWORD (≥ 12 ký tự)
npm run db:migrate       # tạo bảng trong D1 local
npm run db:seed          # tài khoản admin + topic PMP + đề "PMP Mock Test 1"
npm run dev              # http://localhost:8787/api/v1
```

`npm run db:reset` xóa D1 local rồi migrate và seed lại từ đầu.

Kết nối từ app mobile khi phát triển:
- **Android emulator**: `http://10.0.2.2:8787/api/v1`.
- **Máy thật cắm USB**: `adb reverse tcp:8787 tcp:8787`, rồi dùng `http://localhost:8787/api/v1`.
- **Máy thật qua Wi-Fi**: chạy `npx wrangler dev --ip 0.0.0.0`, rồi dùng `http://<IP-LAN>:8787/api/v1`.

## Deploy lên Cloudflare

Làm một lần:

```bash
npx wrangler login
npx wrangler d1 create qbank          # dán database_id in ra vào wrangler.jsonc (d1_databases)
npx wrangler secret put JWT_ACCESS_SECRET
npm run db:migrate:remote             # tạo bảng trên D1 production
ADMIN_EMAIL='…' ADMIN_PASSWORD='…' npm run db:admin:remote   # tạo tài khoản admin
ADMIN_EMAIL='…' ADMIN_PASSWORD='…' npm run db:seed:remote    # (tuỳ chọn) admin + dữ liệu mẫu PMP
```

Worker không đọc `ADMIN_EMAIL` / `ADMIN_PASSWORD`: hai biến này chỉ dùng cho script seed chạy trên máy bạn. Đừng đặt chúng thành secret hay variable của Worker.

Dịch từ vựng **không cần API key**: Worker gọi các endpoint miễn phí mà trình dịch có sẵn của trình duyệt dùng (cùng cách với `translator_extension`). Google `translate_a/t` được thử lần lượt 3 biến thể (`translate.googleapis.com` với `client=gtx`, `client=dict-chrome-ex`, và `clients5.google.com`); khi Google từ chối thì chuyển sang trình dịch của Microsoft Edge. Biến thể bị chặn được nghỉ 15 giây, tăng dần tới 8 phút.
- Đây không phải API chính thức: có thể bị giới hạn tần suất (429, trang "unusual traffic") hoặc đổi định dạng bất cứ lúc nào, và Worker gọi từ IP dùng chung của Cloudflare.
- Từ và cụm từ đã dịch được cache dùng chung cho mọi user, nên mỗi từ chỉ gọi một lần.
- Khi không endpoint nào trả lời, từ vựng vẫn lưu và đồng bộ bình thường; app hiện "Chưa dịch được, sẽ tự thử lại" và thử lại sau.

Sau đó commit và push. Workers Builds chạy `npm run build` (typecheck) rồi `npx wrangler deploy`.

- **Migration không tự chạy khi deploy.** Đổi schema thì chạy `npm run db:migrate:remote` trước khi push. Nếu muốn tự động, đặt Deploy command trên dashboard thành `npm run db:migrate:remote && npx wrangler deploy`; build token khi đó cần quyền sửa D1.
- **Xem CPU thật:** Dashboard → Workers & Pages → `back-q-bank` → Observability. Mỗi request có `cpuTime`; nên nằm dưới 10 ms.

## Tài khoản

Mỗi người có một tài khoản email/mật khẩu trong bảng `User`. Mật khẩu được băm bằng PBKDF2-SHA256 (WebCrypto, không cần thư viện).

| Role | Tạo bằng cách | Làm được |
|---|---|---|
| `USER` | Khách tự đăng ký qua `POST /auth/register` | Xem đề đã publish, làm bài, xem kết quả của mình |
| `HOST` | Đổi `role` của một user trong DB | Thêm: soạn câu hỏi, soạn đề trong ngân hàng riêng của mình |
| `ADMIN` | `npm run db:admin` (hoặc `db:admin:remote`) với `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Mọi việc |

- **Đổi mật khẩu admin:** chạy lại `db:admin` với `ADMIN_PASSWORD` mới. Lệnh này tạo admin nếu chưa có, nếu có rồi thì đặt lại mật khẩu.
- **Khoá một tài khoản:** đặt `isActive = 0`. Phiên đang mở bị chặn ngay ở request kế tiếp.
- **Chi phí CPU:** băm mật khẩu tốn khoảng 0,24 ms cho mỗi 1.000 vòng, chỉ khi đăng ký và đăng nhập. Mặc định `PASSWORD_HASH_ITERATIONS=25000` (khoảng 6 ms) để vừa giới hạn 10 ms của gói Free. Lên gói Paid thì nên tăng lên `100000` (mức tối đa WebCrypto của Workers cho phép). Số vòng được lưu trong từng hash, nên hash cũ tự được băm lại theo mức mới khi user đăng nhập.
- **Dữ liệu cũ:** user tạo từ thời chỉ có một tài khoản có `passwordHash = '!'`, không đăng nhập được. Riêng admin thì chạy `db:admin` một lần là xong.

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

## Auth cho app mobile

Token trả trong JSON body (không dùng cookie):

```jsonc
// POST /auth/register { email, password (8–128 ký tự), fullName, deviceId?, deviceName?, platform? } → 201
// POST /auth/login    { email, password, deviceId?, deviceName?, platform?: "IOS" | "ANDROID" | "WEB" } → 200
{
  "user": { "id": "…", "email": "…", "fullName": "…", "role": "ADMIN", "isActive": true, "createdAt": "…" },
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
4. Mỗi `deviceId` chỉ giữ một phiên. Logout có hiệu lực **ngay lập tức**, vì mỗi request đều kiểm tra phiên trong DB.
5. Login và refresh bị giới hạn 10 lần/phút cho mỗi IP; quá giới hạn trả 429 `TOO_MANY_REQUESTS`.

## API (`/api/v1`)

| Nhóm | Endpoint | Quyền |
|---|---|---|
| Health | `GET /health` | public |
| Auth | `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh` | public (có rate limit) |
| | `POST /auth/logout`, `GET /auth/me` | đã đăng nhập |
| Topic | `GET /topics`, `GET /topics/:id` | đã đăng nhập |
| | `POST /topics`, `PATCH`/`DELETE /topics/:id`, `POST /topics/:topicId/domains`, `PATCH`/`DELETE /domains/:id` | HOST, ADMIN (chỉ người tạo được sửa/xóa) |
| Question | `GET /questions?topicId&domainId&difficulty&type&q`, `POST /questions`, `GET`/`PATCH`/`DELETE /questions/:id` | HOST (của mình), ADMIN |
| Exam | `GET`/`POST /exams`, `GET`/`PATCH`/`DELETE /exams/:id`, `POST /exams/:id/publish \| unpublish \| archive` | HOST (của mình), ADMIN |
| Section | `POST /exams/:id/sections`, `PATCH`/`DELETE /exams/:id/sections/:sectionId`, `PUT /exams/:id/sections/order` | như Exam |
| Câu hỏi trong đề | `POST /exams/:id/sections/:sectionId/questions`, `PUT /exams/:id/sections/:sectionId/questions/order`, `PATCH`/`DELETE /exams/:id/questions/:questionId` | như Exam |
| Catalog | `GET /catalog/exams?topicId&q`, `GET /catalog/exams/:id`, `POST /catalog/exams/:id/attempts` (bắt đầu hoặc tiếp tục bài dở) | đã đăng nhập |
| Làm bài | `GET /attempts`, `GET /attempts/:id`, `PATCH /attempts/:id/answers` (lưu nhiều câu một lần), `POST /attempts/:id/submit`, `GET /attempts/:id/result`, `GET /attempts/:id/review` | chủ bài làm |
| Từ vựng | `POST /vocab/sync` (đẩy thay đổi và kéo phần mới, xem bên dưới) | đã đăng nhập (30 lần/phút) |

Danh sách có phân trang `?page=1&limit=20` (tối đa 100) và trả về `{ items, total, page, limit }`. Tham số `q` tìm **không phân biệt hoa thường và dấu tiếng Việt**: `quan ly` khớp với "Quản lý".

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
- Body: `{ "answers": [{ "attemptQuestionId": "…", "response": { "optionId": "…" }, "flagged": false }] }`, tối đa 500 câu một lần (nên gửi ít hơn, xem giới hạn CPU).
- `response: null` để xóa câu trả lời; bỏ trống field nào thì giữ nguyên giá trị cũ.
- Bài có giới hạn thời gian: server vẫn nhận câu trả lời thêm 30 giây sau `expiresAt`. Quá thời gian đó, bài tự chấm với các câu đã lưu và chuyển `EXPIRED`.
- Dùng `serverTime` trong response để đồng bộ đồng hồ đếm ngược.

**Từ vựng** (`POST /vocab/sync`): app giữ bản sao riêng (dùng được offline) và đồng bộ bằng một endpoint duy nhất.
- Body: `{ "cursor": { "rev": 12, "key": "baseline" } | null, "changes": [{ "key", "term", "meaning?", "partOfSpeech?", "explanation?", "context?", "sourceTitle?", "deleted", "createdAt", "updatedAt" }] }`, tối đa 50 thay đổi một lần. Thời gian tính bằng Unix ms theo đồng hồ thiết bị.
- `key` là `termKey(term)` (`src/modules/vocab/term.ts`, file này giống hệt ở hai app). Mỗi user có một ghi chú cho mỗi key: ghi lại cùng một từ thì cập nhật dòng cũ, xoá là tombstone `deleted: true`.
- Khi xung đột, thay đổi mới hơn thắng theo từng field, nhưng nghĩa, ngữ cảnh và nguồn đã có không bao giờ bị ghi đè bằng null.
- Response: `{ items, cursor, hasMore, pending, maxRev, translateUnavailable, rejected, serverTime }`. Gửi lại `cursor` ở lần sau và gọi tiếp khi `hasMore`. `pending` là số ghi chú còn chờ dịch: mỗi request dịch tối đa 5 ghi chú trong một lần gọi (Google, dự phòng Microsoft), từ và cụm từ được cache dùng chung cho mọi user. `rejected` liệt kê thay đổi bị bỏ (`INVALID_TERM`) hoặc lưu dưới key khác (`REKEY`, kèm `newKey`).
- Dịch hỏng 3 lần thì `translateFailed: true`. Gửi lại ghi chú (mới hơn, vẫn chưa có nghĩa) để yêu cầu dịch lại.

**Luật soạn đề**:
- Chỉ đề `DRAFT` mới sửa được. Muốn sửa đề đã publish thì unpublish trước.
- Publish yêu cầu mọi section đều có câu hỏi.
- Câu hỏi thêm vào đề phải cùng owner và cùng topic với đề.
- Đề đã có người làm thì không xóa được, chỉ archive được.

## Định dạng lỗi

Mọi lỗi đều có dạng:

```json
{ "statusCode": 409, "code": "EXAM_NOT_EDITABLE", "message": "Only draft exams can be edited; unpublish it first" }
```

`message` **luôn là một chuỗi**, có thể hiển thị thẳng cho người dùng. Lỗi validate có thêm `details: [{ field, messages[] }]`.

Các `code` thường gặp:
- **Validate và auth**: `VALIDATION_ERROR`, `BAD_REQUEST` (JSON hỏng, id sai định dạng), `INVALID_CREDENTIALS`, `EMAIL_TAKEN`, `UNAUTHORIZED`, `TOKEN_INVALID`, `SESSION_ENDED`, `REFRESH_TOKEN_INVALID`, `REFRESH_TOKEN_REUSED`, `ACCOUNT_DISABLED`, `TOO_MANY_REQUESTS`.
- **Tài nguyên**: `FORBIDDEN`, `NOT_FOUND`, `TOPIC_EXISTS`, `DOMAIN_EXISTS`, `TOPIC_IN_USE`, `DOMAIN_IN_USE`, `QUESTION_IN_USE`, `ALREADY_EXISTS`, `RESOURCE_IN_USE`.
- **Câu hỏi**: `INVALID_QUESTION_DEFINITION`, `QUESTION_TYPE_NOT_SUPPORTED`, `DOMAIN_TOPIC_MISMATCH`.
- **Soạn đề**: `EXAM_NOT_EDITABLE`, `EXAM_NOT_PUBLISHABLE`, `EXAM_HAS_ATTEMPTS`, `LAST_SECTION`, `QUESTIONS_NOT_FOUND`, `QUESTION_TOPIC_MISMATCH`, `QUESTION_ALREADY_IN_EXAM`, `INVALID_ORDER`.
- **Làm bài**: `INVALID_RESPONSE`, `INVALID_ATTEMPT_QUESTION`, `DUPLICATE_ANSWER`, `ATTEMPT_CLOSED`, `ATTEMPT_EXPIRED`, `ATTEMPT_NOT_SUBMITTED`, `EXAM_EMPTY`.
- **Khác**: `PAYLOAD_TOO_LARGE` (body > 100 kB).

## Giới hạn gói Free

| Giới hạn | Gói Free | Ghi chú |
|---|---|---|
| CPU mỗi request | 10 ms | Thời gian chờ D1 không tính. Thỉnh thoảng vượt được chấp nhận; vượt thường xuyên sẽ bị lỗi 1102 |
| Request | 100.000/ngày | |
| D1 | 5 triệu dòng đọc/ngày, 100.000 dòng ghi/ngày, 500 MB/DB | |
| Truy vấn D1 mỗi request | 50 | |
| Tham số mỗi câu SQL | 100 | Danh sách dài phải đi qua `json_each` (xem AGENTS.md) |
| Endpoint dịch miễn phí (Google, Microsoft) | Không công bố | Không chính thức, có thể bị giới hạn tần suất. Chỉ dùng để dịch từ vựng; thời gian chờ không tính CPU |

CPU đo trong workerd local (cùng runtime với production, đã gồm phần phình do chế độ dev; số trên production thường thấp hơn):

| Request | CPU |
|---|---|
| Đọc thông thường (`/auth/me`, topics, câu hỏi, đề, bài làm, kết quả) | 3–6,5 ms |
| Lưu 30 đáp án | khoảng 6 ms |
| Bắt đầu làm bài, publish đề (30 câu) | khoảng 6,5–8 ms |
| Lưu 120 đáp án trong một request | khoảng 16 ms. App nên lưu theo từng câu hoặc từng nhóm nhỏ |

Đồng bộ từ vựng, đo bằng harness e2e (Node + D1 local, cùng cách đo này `/auth/me` hết 3,6 ms): sync rỗng khoảng 5 ms, đẩy 50 thay đổi khoảng 7,5 ms, kéo một trang 200 ghi chú khoảng 7 ms.

Đề rất lớn (trên khoảng 100 câu) có thể đẩy request bắt đầu làm bài vượt 10 ms. Khi đó, các lựa chọn là chia đề nhỏ hơn hoặc lên gói Workers Paid ($5/tháng).

## Thêm dạng câu hỏi mới

1. Viết handler trong `src/modules/questions/question-types/`, implement `QuestionTypeHandler`:
   - `parseDefinition`: validate `definition` mà host gửi lên.
   - `buildSnapshot`: tách phần người làm bài được thấy và phần đáp án ẩn.
   - `parseResponse`: validate câu trả lời.
   - `grade`: chấm điểm.
2. Đăng ký handler trong `question-types/index.ts`.
3. Không cần migration: cột `type` đã chấp nhận sẵn các dạng.

## Scripts

| Lệnh | Việc |
|---|---|
| `npm run dev` | chạy Worker local (`wrangler dev`) với D1 local |
| `npm run check` | typecheck + lint + unit test |
| `npm run test:e2e` | e2e: app thật trên D1 local, mỗi file một DB mới trong bộ nhớ |
| `npm run db:generate` | tạo migration sau khi sửa `src/db/schema.ts` |
| `npm run db:migrate` / `db:migrate:remote` | áp migration vào D1 local / production |
| `npm run db:seed` / `db:seed:remote` | seed tài khoản admin + dữ liệu mẫu (chạy lại không tạo trùng) |
| `npm run db:admin` / `db:admin:remote` | chỉ tạo admin hoặc đặt lại mật khẩu admin |
| `npm run db:reset` | xóa D1 local, migrate và seed lại |
| `npm run cf:types` | sinh lại `src/worker-configuration.d.ts` sau khi sửa `wrangler.jsonc` |
| `npm run deploy` | deploy từ máy (bình thường để Workers Builds deploy khi push) |
