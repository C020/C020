# 🎥 Stream Bot — بوت البثوث

بوت ديسكورد متكامل للستريمرز: يتابع **Twitch** و **Kick** و **YouTube** و **TikTok**، يعطي رتبة **Streaming Now** تلقائياً وقت البث، يرسل إشعار **واحد مدمج** لو يبث على أكثر من منصة، ويحوّل الإشعار إلى **ملخص كامل** بعد ما يخلص البث — ومعه **لوحة تحكم ويب عربية** تضبط فيها كل شي.

---

## ✨ المميزات

| | |
|---|---|
| 🏷️ **رتبة Streamer تلقائية** | أول ما تضيف الستريمر من اللوحة ياخذ الرتبة |
| 🔴 **رتبة Streaming Now** | تنعطى وقت البث في أي منصة، وتنشال لما يطفي كل المنصات |
| 📢 **إشعار مدمج** (فكرة 1) | يبث على كيك وتويتش مع بعض؟ رسالة وحدة فيها زر لكل منصة |
| 📊 **ملخص بعد البث** (فكرة 2) | نفس الرسالة تتعدل: المدة، أعلى/متوسط مشاهدين، الألعاب مع وقت كل لعبة، روابط الإعادة |
| 🔄 **تحديث حي** | رسالة البث تتحدث (مشاهدين، عنوان، لعبة) كل كم دقيقة |
| 🎬 **إشعارات المقاطع** | يوتيوب (فيديو + شورتس + إعادة البث)، تيك توك، تويتش (VOD / هايلايت / كليبات)، كيك (VOD / كليبات) |
| 🔕 **بدون منشن** | افتراضياً ما فيه أي منشن (تقدر تغيّره من اللوحة) |
| ⚡ **سرعة** | Webhooks فورية (Twitch EventSub، Kick، YouTube WebSub) + فحص دوري كضمان |
| 🛡️ **ضد التذبذب** | فترة سماح لو النت قطع، ودمج البث لو رجع خلال 10 دقايق بنفس الرسالة |
| 🖥️ **لوحة تحكم** | تسجيل دخول بديسكورد، رتب، رومات، ستريمرز، قوالب رسائل مع معاينة حيّة، سجل، إحصائيات |
| 🩺 **تشخيص ذكي** | ينبهك لو رتبة البوت تحت الرتب المطلوبة أو ناقصه صلاحيات |
| 🔐 **حماية الرتب** | ما يشيل رتبة Streaming Now إلا من الستريمرز المسجلين، ويرفض الرتب الإدارية، وتغيير الرتب يحتاج Manage Roles |
| ♻️ **يتحمل الأعطال** | لو ديسكورد أو منصة طاحت، البوت يعيد المحاولة لحاله بدون ما يوقف، ويرجع يزامن الرتب والرسائل |

---

## 🧰 المتطلبات

- VPS (Ubuntu 22.04+ مثلاً) عليه **Docker** و **Docker Compose**
- دومين (أو ساب دومين) يأشر على الـ VPS — مثال `bot.example.com`
- تطبيق ديسكورد + مفاتيح المنصات (الشرح تحت)

---

## 🚀 التشغيل خطوة بخطوة

### 1) تطبيق ديسكورد

1. ادخل https://discord.com/developers/applications ← **New Application**
2. من **Bot**:
   - **Reset Token** ← انسخه في `DISCORD_TOKEN`
   - فعّل **Server Members Intent** (ضروري عشان البوت يعطي ويشيل الرتب ويزامنها)
3. من **General Information** ← انسخ **Application ID** في `DISCORD_CLIENT_ID`
4. من **OAuth2**:
   - انسخ **Client Secret** في `DISCORD_CLIENT_SECRET`
   - في **Redirects** أضف: `https://bot.example.com/auth/callback`
5. ادعُ البوت لسيرفرك (رابط الدعوة يطلع لك في لوحة التحكم وفي اللوق، أو استخدم):
   ```
   https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot%20applications.commands&permissions=268553216
   ```
6. **مهم:** من إعدادات السيرفر ← Roles، اسحب رتبة البوت **فوق** رتبتي `Streamer` و `Streaming Now`.

### 2) مفاتيح المنصات

| المنصة | وين | وش تحط في `.env` |
|---|---|---|
| **Twitch** | https://dev.twitch.tv/console/apps ← Register Your Application (Client Type: Confidential) | `TWITCH_CLIENT_ID` `TWITCH_CLIENT_SECRET` |
| **Kick** | https://kick.com/settings/developer ← Create App، وبعدها **Enable Webhooks** وحط الرابط `https://bot.example.com/webhooks/kick` | `KICK_CLIENT_ID` `KICK_CLIENT_SECRET` |
| **YouTube** | https://console.cloud.google.com ← فعّل **YouTube Data API v3** ← Credentials ← API key | `YOUTUBE_API_KEY` |
| **TikTok** | ما يحتاج شي (غير رسمي) | — |

> حساب Twitch و Kick لازم يكون مفعّل فيه التحقق بخطوتين (2FA) عشان تقدر تسوي تطبيق.

### 3) على الـ VPS

```bash
# تثبيت Docker (لو مو مثبت)
curl -fsSL https://get.docker.com | sh

# تنزيل المشروع
git clone <رابط المستودع> /opt/stream-bot
cd /opt/stream-bot

# الإعدادات
cp .env.example .env
docker run --rm -v "$PWD":/app -w /app node:22-slim node scripts/generate-secrets.mjs   # يطلع لك الأسرار
nano .env   # عبّي القيم + الأسرار اللي طلعت

# التشغيل
docker compose up -d --build
docker compose logs -f bot
```

- خلّ سجل **A** في الـ DNS حق الدومين يأشر على IP الـ VPS، و Caddy يطلع شهادة HTTPS لحاله.
- افتح البورتات 80 و 443 في الجدار الناري.

### 4) لوحة التحكم

1. افتح `https://bot.example.com` ← **تسجيل الدخول بديسكورد**
2. **الإعدادات**: حط ID رتبة Streamer و Streaming Now (أو اخترها من القائمة) + روم إشعارات البث + روم المقاطع
3. **الستريمرز** ← إضافة ستريمر: حط Discord ID حقه، وحساباته (تويتش، كيك، يوتيوب، تيك توك) — اللوحة تتحقق من كل حساب وتعرض صورته
4. خلاص! البوت يعطيه رتبة Streamer ويبدأ يراقبه.

> يدخل اللوحة: صاحب السيرفر، أو أي أحد عنده صلاحية **Manage Server**، أو الـ IDs اللي في `ADMIN_USER_IDS`.

---

## 💬 أوامر السلاش

| الأمر | الوصف |
|---|---|
| `/live` | مين يبث الحين (للكل) |
| `/streamer add` | إضافة ستريمر مع حساباته (للإدارة) |
| `/streamer remove` | حذف ستريمر |
| `/streamer list` | قائمة الستريمرز |
| `/streamer info` | تفاصيل ستريمر وحالته |
| `/bot status` | حالة البوت والمنصات والمشاكل |
| `/bot sync` | مزامنة الرتب |
| `/bot test` | إرسال إشعار تجربة |

---

## ⚙️ كيف يشتغل

```
المنصات ──(Webhook فوري)──┐
                          ├──► المراقب ──► آلة الحالة (فترة سماح) ──► الجلسات ──► الرتب + الرسائل
المنصات ──(فحص دوري)──────┘                                              └──► السجل + اللوحة (لحظي)
```

- **البث المباشر:** Twitch و Kick بالـ API الرسمي (دفعة وحدة لكل 100 حساب)، YouTube عن طريق RSS المجاني + API بكوتا قليلة جداً، TikTok بطرق غير رسمية.
- **فترة السماح:** ما ينتهي البث إلا بعد فحصين متتاليين وأقل شي `OFFLINE_GRACE_SECONDS` (افتراضي 150 ثانية).
- **الدمج:** لو رجع يبث خلال `reconnectMergeMinutes` (افتراضي 10 دقايق) تكمل نفس الجلسة ونفس الرسالة.
- **أول إضافة:** المقاطع القديمة تنحفظ بصمت — ما ينرسل إلا الجديد.

### ملاحظات صريحة عن المنصات

- **TikTok:** ما عنده API رسمي للايف أو المقاطع، فالبوت يستخدم طرق غير رسمية مع حماية: يوقف مؤقتاً لو تيك توك حجب، ما يعتبر الخطأ "أوفلاين"، يتجاهل ظهور الستريمر كضيف في لايف غيره، وصور مقاطع تيك توك ترتفع كمرفق عشان ما تختفي (روابطها تنتهي). لو صار الحجب كثير، شغّل RSSHub المحلي:
  `docker compose --profile rsshub up -d` وحط `RSSHUB_URL=http://rsshub:1200`.
- **Kick:** البث المباشر رسمي وثابت (API + Webhooks). مقاطع كيك (VOD/كليبات) ما لها API رسمي، وشروط كيك تمنع السحب الآلي، فافتراضياً الملخص بعد البث فيه زر صفحة الإعادات. لو تبي إشعارات مقاطع كيك على مسؤوليتك: `KICK_UNOFFICIAL_CONTENT=true` (لو Cloudflare حجبها يوقف لحاله ويبين لك في صفحة **الحالة**).
- **YouTube:** الكوتا 10,000 وحدة يومياً، والبوت يستهلك جزء بسيط منها لأنه يعتمد على RSS المجاني.

---

## 🔧 الصيانة

```bash
docker compose logs -f bot                  # السجلات
git pull && docker compose up -d --build    # التحديث
./deploy/backup.sh                          # نسخة احتياطية لقاعدة البيانات (./backups)
```

### حل المشاكل

| المشكلة | الحل |
|---|---|
| البوت ما يعطي الرتب | رتبة البوت لازم تكون فوق الرتب، وعنده **Manage Roles** — صفحة **نظرة عامة** تبين لك المشكلة بالضبط |
| اللوحة ترفض رتبة معيّنة | لحمايتك: البوت ما يقبل رتبة فيها صلاحيات إدارية (Administrator، Ban، Manage...) كرتبة Streamer أو Streaming Now، وتغيير الرتب يحتاج صلاحية **Manage Roles** |
| صور مقاطع تيك توك ما تطلع | اسمح للبوت بـ **Attach Files** في روم المقاطع (البوت يرفع صور تيك توك كمرفق لأن روابطها تنتهي) |
| خطأ `Used disallowed intents` | فعّل **Server Members Intent** من Developer Portal |
| تسجيل الدخول للوحة ما يشتغل | تأكد إن `PUBLIC_URL` صحيح وإن رابط `/auth/callback` مضاف في OAuth2 Redirects |
| إشعارات كيك تتأخر | تأكد إن رابط الـ Webhook في إعدادات تطبيق كيك هو `PUBLIC_URL/webhooks/kick` (الفحص الدوري شغال كضمان) |
| تيك توك "محجوب" | طبيعي أحياناً من سيرفرات الـ VPS — البوت يرجع يحاول لحاله، أو شغّل RSSHub |

---

## 👨‍💻 التطوير

```bash
npm install
cp .env.example .env     # عبّي DISCORD_TOKEN و DISCORD_CLIENT_ID على الأقل
npm run dev              # البوت + السيرفر
npm run dev:dashboard    # اللوحة (Vite) على http://localhost:5173
npm test                 # كل الاختبارات (السيرفر + اللوحة)
npm run typecheck
npm run build && npm start
```

**التقنيات:** Node.js 22 · TypeScript · discord.js 14 · Fastify 5 · SQLite (node:sqlite) · React 19 · Vite · Tailwind CSS 4

```
src/
├── platforms/   # twitch / kick / youtube / tiktok (+ webhooks)
├── monitor/     # الفحص الدوري + آلة حالة البث + المقاطع
├── services/    # الجلسات (الإشعار المدمج + الملخص)، المقاطع، إدارة الستريمرز
├── discord/     # البوت: الرسائل، الرتب، أوامر السلاش
├── web/         # API + تسجيل الدخول + Webhooks + بث لحظي (SSE)
├── db/          # SQLite: الجداول والمستودعات
└── shared/      # عقد الـ API بين السيرفر واللوحة
dashboard/       # لوحة التحكم (React)
```
